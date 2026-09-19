import { Inject, Injectable, UnauthorizedException, BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { BaseClient, toText } from '@acms/base-adapter';
import { TABLES, STUDENT_RECORD_TYPE_FIELD } from '@acms/contracts';
import type { SqlStore } from '../sql-store/sql-store.js';
import { REDIS } from '../redis.provider.js';
import { BASE_CLIENT, getSqlStore } from '../base.provider.js';
import { SessionService } from '../auth/session.service.js';
import { buildFilter, linkIds } from '../shared/record.util.js';
import { WechatBindingService } from '../wechat-binding/wechat-binding.service.js';
import type { SessionUser } from '@acms/contracts';
import {
  attendancesOf,
  commsOf,
  findStudentByNo,
  homeworkOf,
  gradesOf,
  studentSummaries,
  type PortalAttendanceItem,
  type PortalCommItem,
  type PortalGradeItem,
  type PortalHomeworkItem,
} from '../portal/portal-queries.js';

const STUDENT_TABLE = TABLES.studentProfile.tableId;
const GUARDIAN_TABLE = TABLES.guardian.tableId;
const FOLLOWUP_TABLE = TABLES.dailyFollowup.tableId;

/** 家长端自助查询的白名单动作（与 PortalService 同一套查询层，只是视角不同） */
const VIEWER = 'parent' as const;

/** Redis 里的「家长 → 子女」绑定名单（无 TTL：会话本身也在 Redis，清空即全员重新登录） */
const CHILDREN_PREFIX = 'parentchildren:';

/**
 * 家长 H5 端服务（P3 + 2026-09-19 issue #2 多子女 / 自助查询）。
 *
 * 能力：
 *  - `bind`            学号 + 姓名（+ 可选手机号）绑定，签发 cookie 会话（角色 parent）
 *  - `children`        本家长名下可切换的子女列表
 *  - `switchChild`     切换当前子女（改的是会话内容，下一个请求立即生效）
 *  - `grades / homework / comms / attendances`  自助查询（只读，全部经可见性过滤）
 *  - `submitFeedback`  向**家校沟通**写入一条家长反馈
 *
 * 🔴 三个必须守住的边界：
 *   1. 所有查询的 studentId **只从会话取**，绝不接受请求参数指定 ——
 *      否则改个 id 就能看别人家孩子（这类越权在家长端是最敏感的）。
 *   2. 成绩 / 作业 / 沟通记录一律走 `portal-queries.ts` 的可见性判据
 *      （家长可见 + 完成闸门 / 教案已发布 / 记录类型 + 敏感级别），
 *      这里**不做任何"顺手多给一点"的例外**。
 *   3. 切子女只在 `studentIds` 白名单内 —— 见 `switchChild`。
 */
@Injectable()
export class ParentService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly sessions: SessionService,
    private readonly wechatBinding: WechatBindingService,
  ) {}

  /**
   * 门户口径的 SQL 读取（与 PortalService.sql() 同一取舍：没有 SQL 时给空结果而不是抛错）。
   * 门户是只读展示，宁可空列表，也不能因为本地未启用 SQL 就整页 500。
   */
  private sql(): SqlStore {
    const sql = getSqlStore();
    if (sql) return sql;
    return { search: async () => ({ items: [], hasMore: false }) } as unknown as SqlStore;
  }

  /** 学号 + 姓名 → 学生档案（与小程序绑定逻辑一致，但不写 Redis 绑定键） */
  private async findStudent(studentNo: string, name: string) {
    const sql = getSqlStore();
    if (sql) return findStudentByNo(sql, studentNo, name);
    // 无 SQL 时回落通用检索（保持与历史行为一致）
    const res = await this.base.search(STUDENT_TABLE, {
      pageSize: 50,
      filter: buildFilter([{ field: '学生姓名', value: [name] }]),
    });
    const no = String(studentNo).trim();
    const hit = res.items.find((r) => {
      const f = r.fields;
      if (toText(f['学生姓名']) !== name.trim()) return false;
      return (
        String(toText(f['学生编号']) ?? '').trim() === no ||
        String(toText(f['学籍号（脱敏）']) ?? '').trim() === no
      );
    });
    if (!hit) return null;
    return {
      id: hit.recordId,
      姓名: toText(hit.fields['学生姓名']) ?? name,
      学号: toText(hit.fields['学生编号']) ?? no,
      校区: toText(hit.fields['校区']) ?? '',
    };
  }

  /**
   * 手机号归属校验（有数据才校验）。
   *
   * 多子女的口径是「同一手机号 = 同一家长」，所以手机号一旦能随便填，
   * 知道 A 家孩子学号+姓名的人只要猜中家长手机号，就能顺带看到 A 家的**其他**孩子。
   * 该学生若在监护人表里登记了手机号，则必须命中其中之一；
   * 一条都没登记（生产当前就是这种，监护人表为空）时放行 —— 否则多子女功能直接不可用。
   */
  private async assertPhoneBelongsToStudent(studentId: string, phone: string): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    const res = await sql.search(GUARDIAN_TABLE, { pageSize: 500 });
    const mine = (res.items ?? []).filter((r) => {
      const f = (r as unknown as { fields?: Record<string, unknown> }).fields ?? {};
      return linkIds(f['关联学生']).includes(studentId);
    });
    if (!mine.length) return; // 未登记监护人 ⇒ 无从校验，放行
    const phones = mine.map((r) => {
      const f = (r as unknown as { fields?: Record<string, unknown> }).fields ?? {};
      return String(f['手机号'] ?? '').replace(/\D/g, '');
    });
    const want = String(phone).replace(/\D/g, '');
    if (phones.some((p) => p && p === want)) return;
    throw new ForbiddenException('FORBIDDEN:手机号与该学生的监护人登记不一致');
  }

  private childrenKey(parentKey: string): string {
    return CHILDREN_PREFIX + parentKey;
  }

  private async readChildren(parentKey: string): Promise<string[]> {
    try {
      const raw = await this.redis.get(this.childrenKey(parentKey));
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private async writeChildren(parentKey: string, ids: string[]): Promise<void> {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (uniq.length) await this.redis.set(this.childrenKey(parentKey), JSON.stringify(uniq));
    else await this.redis.del(this.childrenKey(parentKey));
  }

  /**
   * 绑定：学号 + 姓名（+ 可选手机号）。
   *
   * 家长身份键（`openId`）的选择是这里最要紧的决定：
   *   - **填了手机号** ⇒ `parent_<手机号>`：同一家长下的多个子女共享一个身份，
   *     再绑第二个孩子时自动进同一份子女名单 ⇒ 多子女切换可用；
   *   - **没填** ⇒ `parent_<studentId>`：与历史行为完全一致（一个子女一个身份），
   *     不会因为这次改动让存量家长突然"多出/少掉"能看的孩子。
   */
  async bind(studentNo: string, name: string, phone?: string): Promise<SessionUser> {
    if (!studentNo || !name) throw new BadRequestException('VALIDATION:需学号与姓名');
    const stu = await this.findStudent(studentNo, name);
    if (!stu) throw new UnauthorizedException('STUDENT_NOT_FOUND:学号或姓名不匹配');

    const cleanPhone = String(phone ?? '').replace(/\D/g, '');
    if (cleanPhone) await this.assertPhoneBelongsToStudent(stu.id, cleanPhone);

    const parentKey = cleanPhone ? `parent_${cleanPhone}` : `parent_${stu.id}`;
    const prev = await this.readChildren(parentKey);
    const children = prev.includes(stu.id) ? prev : [...prev, stu.id];
    await this.writeChildren(parentKey, children);

    const session = await this.sessions.create({
      openId: parentKey,
      name: stu.姓名,
      roles: ['parent'],
      campuses: stu.校区 ? [stu.校区] : [],
      maxDataLevel: 'L1',
      studentId: stu.id,
      studentIds: children,
    });
    // 写入/更新「微信登录用户」绑定记录（供后台查看、解绑、强制下线）
    await this.wechatBinding.upsertBinding({
      openId: parentKey,
      studentId: stu.id,
      studentNo,
      name: stu.姓名,
      role: 'parent',
      loginMethod: '家长H5',
    });
    return session;
  }

  /**
   * 名下子女列表（供切换器渲染）。
   *
   * 只回姓名 / 学号 / 校区 —— 家长切换器不需要孩子的完整档案；
   * `current` 让前端知道当前选中的是哪个。
   */
  async children(user: SessionUser) {
    const ids = user.studentIds?.length ? user.studentIds : user.studentId ? [user.studentId] : [];
    const sql = getSqlStore();
    if (!sql || !ids.length) {
      return { items: [], total: 0, current: user.studentId ?? '', multi: false };
    }
    const items = await studentSummaries(sql, ids);
    return {
      items,
      total: items.length,
      current: user.studentId ?? items[0]?.id ?? '',
      multi: items.length > 1,
    };
  }

  /**
   * 切换当前子女。
   *
   * 🔴 必须校验目标在 `studentIds` 白名单里：如果直接信前端传来的 studentId 改会话，
   *    家长只要把 id 换成别人家孩子的 record_id 就能看那份档案 —— 越权访问未成年人数据。
   */
  async switchChild(sessionId: string, user: SessionUser, studentId: string): Promise<{ ok: true; studentId: string }> {
    const allow = user.studentIds?.length ? user.studentIds : user.studentId ? [user.studentId] : [];
    const want = String(studentId ?? '').trim();
    if (!want) throw new BadRequestException('VALIDATION:缺少学生');
    if (!allow.includes(want)) throw new ForbiddenException('FORBIDDEN:该学生不在你的绑定范围内');
    const next = await this.sessions.update(sessionId, { studentId: want });
    if (!next) throw new UnauthorizedException('UNAUTHENTICATED');
    return { ok: true, studentId: want };
  }

  /**
   * 家长视角的成绩（只读）。
   *
   * 🔴 与老师侧看到的**不是同一份**：只回「家长可见 = 是」且已过「完成日期」闸门的格子。
   *    所以家长端条数少于成绩册是**正常**的，不是 bug。
   */
  async grades(studentId: string): Promise<{ items: PortalGradeItem[]; total: number }> {
    const items = await gradesOf(this.sql(), studentId, VIEWER);
    return { items, total: items.length };
  }

  /** 家长视角的作业布置（教案「作业布置」，需已发布 + 家长可见） */
  async homework(studentId: string): Promise<{ items: PortalHomeworkItem[]; total: number }> {
    const items = await homeworkOf(this.sql(), studentId, VIEWER);
    return { items, total: items.length };
  }

  /** 家长视角的家校沟通记录（仅「家校沟通」类型，敏感级别高于内部的不出） */
  async comms(studentId: string): Promise<{ items: PortalCommItem[]; total: number }> {
    const items = await commsOf(this.sql(), studentId);
    return { items, total: items.length };
  }

  /** 家长只读所绑定学生的考勤记录 */
  async listAttendances(studentId: string): Promise<{ items: PortalAttendanceItem[]; total: number }> {
    const items = await attendancesOf(this.sql(), studentId);
    return { items, total: items.length };
  }

  /**
   * 家长提交反馈（写入**家校沟通**记录）。
   *
   * 🔴 2026-09-19 修：原来写的是合并前的独立家校沟通表，且**不写「记录类型」**。
   *    三合一（日常跟进 / 家校沟通 / 学生观察 合并为一张表 + 记录类型）之后，
   *    那条反馈在老师的「家校沟通」列表里**根本不会出现** ——
   *    家长以为交了，老师永远看不到，两边都不知道丢了。
   */
  async submitFeedback(user: SessionUser, studentId: string, content: string, contact?: string): Promise<{ ok: boolean }> {
    if (!content || !content.trim()) throw new BadRequestException('VALIDATION:反馈内容不能为空');
    const text = contact ? `【${contact}】${content}` : content;
    const fields: Record<string, unknown> = {
      [STUDENT_RECORD_TYPE_FIELD]: '家校沟通',
      关联学生编号: [studentId],
      // 「沟通内容」是三合一前的历史字段名，同步流程会把它当「沟通人备注」；
      // 新版写入直接用公共字段，避免又被字典改名带走
      沟通人备注: text,
      家长: user.name ?? '',
      家长反馈: text,
      闭环状态: '无需跟进',
    };
    try {
      fields['沟通时间'] = new Date().toISOString();
    } catch {
      /* datetime 可选，失败不影响主记录 */
    }
    await this.base.create(FOLLOWUP_TABLE, fields);
    return { ok: true };
  }
}
