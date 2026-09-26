/**
 * IDP（个人发展计划）重构 —— 聚合服务（2026-09-26 峰哥需求）。
 *
 * ## 三个视角，一套数据
 *
 * ```
 * 管理员：IDP 配置（学年×学期批次）→ 学生明细 → 分配 IDP 老师
 * 老师  ：我的 IDP（只看 IDP老师 = 我 的行）→ 学生 → 继续沟通
 * 沟通  ：就是「学生记录」里 记录类型=IDP沟通 的那批（不另建表，见 contracts/idp.ts 的说明）
 * ```
 *
 * ## 判据一律来自 contracts（别在这里重写）
 *
 * `idpTermRange`（学年学期→区间）、`idpSummarizeComms`（沟通次数口径）、`idpIsEnrolled`（在校）、
 * `myIdpMenuVisible`（菜单/接口可见性）、`idpLinkIds`（关联字段宽容解析）。
 * 这些都被前端与单测共用；在 service 里再写一份必然漂移。
 *
 * ## 权限（生产实测 2026-09-26）
 *
 * | 页面 | 判据 | 谁持有 |
 * |---|---|---|
 * | IDP 配置（读/写） | `module:idpPlans:read` / `:update` | 系统管理员 + 院级管理 |
 * | 我的 IDP（读） | `myIdpMenuVisible`（= 任一记录类型 read） | 系统管理员 + Phase1~9 + 院级/学生/家长 |
 *
 * 🔴 「我的 IDP」**不用** `idpPlans`：生产实测 Phase1~9 **全部不持有**它 ⇒ 复用它 = 上线即无人可见。
 *    **数据面**靠「IDP老师 = 我的 openId」这个条件卡（不是靠权限点）：老师之间互相看不到。
 */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  IDP_ARCHIVED,
  IDP_COMM_RECORD_TYPE,
  IDP_CONFIG_FIELDS as CF,
  IDP_CONFIG_STATUSES,
  IDP_SCOPE_ALL,
  IDP_STUDENT_FIELDS as SF,
  STUDENT_RECORD_TYPE_FIELD,
  TABLES,
  USER_TABLE,
  idpIsEnrolled,
  idpLinkId,
  idpSummarizeComms,
  idpTermRange,
  myIdpMenuVisible,
  type IdpScope,
  type SessionUser,
} from '@acms/contracts';
import { permissionsOf, type Principal } from '@acms/domain';
import { getSqlStore } from '../base.provider.js';

/** 学生表里「班级」的候选字段（与成绩册 `MarkbookService.CLASS_FIELDS` 同口径） */
const STUDENT_CLASS_FIELDS = ['当前班级', '当前年级'] as const;
/** 学生表里「年级」的候选字段 */
const STUDENT_GRADE_FIELDS = ['当前年级', '入学年级'] as const;
/** 用户表里存 open_id 的字段（与「招生负责老师」同一形态的取值来源） */
const USER_OPEN_ID_FIELD = '飞书 Open ID';

type Row = { id: string; f: Record<string, unknown> };

export interface IdpStudentRow {
  id: string;
  studentId: string;
  studentName: string;
  cls: string;
  grade: string;
  teacherOpenId: string;
  teacherName: string;
  status: string;
  note: string;
  /** 沟通次数（**实时算**：口径见 contracts 的 `idpSummarizeComms`） */
  commCount: number;
  /** 最近一次沟通时间（ms）；0 = 没有 */
  lastAt: number;
  lastSummary: string;
  /** 时间读不出来、因此被排除在计数外的记录数 —— 「读不到 ≠ 0」，必须显式报出来 */
  noTime: number;
}

export interface IdpConfigRow {
  id: string;
  name: string;
  yearId: string;
  yearName: string;
  term: string;
  status: string;
  archived: boolean;
  scopeText: string;
  note: string;
  createdAt: number;
}

@Injectable()
export class IdpService {
  private readonly logger = new Logger('Idp');

  // ───────────────────────── 权限 ─────────────────────────

  private toPrincipal(user: SessionUser): Principal {
    return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
  }

  /** 「我的 IDP」接口的可见性 —— 与前端菜单同一个判据函数（`myIdpMenuVisible`） */
  private requireMyIdp(user: SessionUser): void {
    const perms = [...permissionsOf(this.toPrincipal(user))];
    if (!myIdpMenuVisible({ perms })) throw new ForbiddenException('FORBIDDEN:my-idp');
  }

  /** IDP 配置的读/写（管理员/院级）。**不叠加菜单白名单**：白名单只收敛菜单，不做接口鉴权 */
  private requireConfig(user: SessionUser, action: 'read' | 'update'): void {
    const perm = `module:idpPlans:${action}`;
    const perms = permissionsOf(this.toPrincipal(user));
    if (!perms.has(perm as never)) throw new ForbiddenException(`FORBIDDEN:${perm}`);
  }

  // ───────────────────────── 读表 ─────────────────────────

  /**
   * 全量读一张表（内存过滤用）。
   *
   * 🔴 为什么不走 SQL filter 过滤关联字段：SqlStore 的 `buildCondition` 用 `data ->> field`
   *    取文本，而关联字段存的是 **id 数组** ⇒ 等值/包含都匹配不上（套件老坑）。
   *    本项目这些表都是小表（学生 82 / 记录 176 / 明细几百），全量读 + 内存过滤最可靠。
   */
  private async readAll(tableId: string): Promise<Row[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const out: Row[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await sql.search(tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) });
      for (const it of res.items ?? []) {
        const rec = it as unknown as { recordId?: string; fields?: Record<string, unknown> };
        const id = String(rec.recordId ?? '').trim();
        if (id) out.push({ id, f: (rec.fields ?? {}) as Record<string, unknown> });
      }
      token = res.pageToken;
    } while (token && guard++ < 60);
    return out;
  }

  private studentCls(f: Record<string, unknown>): string {
    for (const k of STUDENT_CLASS_FIELDS) {
      const v = String(f[k] ?? '').trim();
      if (v) return v;
    }
    return '';
  }

  private studentGrade(f: Record<string, unknown>): string {
    for (const k of STUDENT_GRADE_FIELDS) {
      const v = String(f[k] ?? '').trim();
      if (v) return v;
    }
    return '';
  }

  /** open_id → 用户姓名（明细表存 open_id，界面要显示名字） */
  private async userIndex(): Promise<{ byOpenId: Map<string, string>; teachers: { id: string; name: string; openId: string; roles: string[] }[] }> {
    const rows = await this.readAll(USER_TABLE.tableId);
    const byOpenId = new Map<string, string>();
    const teachers: { id: string; name: string; openId: string; roles: string[] }[] = [];
    for (const r of rows) {
      const name = String(r.f['姓名'] ?? '').trim();
      const openId = String(r.f[USER_OPEN_ID_FIELD] ?? '').trim();
      if (!name || !openId) continue;
      byOpenId.set(openId, name);
      teachers.push({ id: r.id, name, openId, roles: parseRoles(r.f['系统角色']) });
    }
    teachers.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return { byOpenId, teachers };
  }

  // ───────────────────────── 配置 ─────────────────────────

  /** 配置清单（带学年名与区间可用性），按创建时间倒序 */
  async configs(user: SessionUser): Promise<(IdpConfigRow & { rangeText: string; rangeOk: boolean; studentCount: number })[]> {
    this.requireConfig(user, 'read');
    const [cfgRows, detailRows, years] = await Promise.all([
      this.readAll(TABLES.idpConfig.tableId),
      this.readAll(TABLES.idpStudent.tableId),
      this.readAll(TABLES.academicYear.tableId),
    ]);
    const yearName = new Map(years.map((y) => [y.id, String(y.f['学年名称'] ?? '')]));
    const counts = new Map<string, number>();
    for (const d of detailRows) {
      const cid = idpLinkId(d.f[SF.所属配置]);
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }
    return cfgRows
      .map((c) => {
        const yearId = idpLinkId(c.f[CF.学年]);
        const term = String(c.f[CF.学期] ?? '');
        const y = years.find((x) => x.id === yearId);
        const range = y ? idpTermRange(y.f['开始日期'], y.f['结束日期'], term) : null;
        const status = String(c.f[CF.状态] ?? '');
        return {
          id: c.id,
          name: String(c.f[CF.配置名称] ?? '') || `${yearName.get(yearId) ?? '（未选学年）'} ${term}`.trim(),
          yearId,
          yearName: yearName.get(yearId) ?? '',
          term,
          status,
          archived: status === IDP_ARCHIVED,
          scopeText: String(c.f[CF.学生范围] ?? ''),
          note: String(c.f[CF.说明] ?? ''),
          createdAt: Number(c.f[CF.创建时间] ?? 0) || 0,
          rangeText: range ? '' : '学年日期缺失或学期与学年对不上',
          rangeOk: !!range,
          studentCount: counts.get(c.id) ?? 0,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 「新建配置」弹窗的可选项：学年（主数据）、学期（字典）、年级/班级（来自学生档案实况） */
  async options(user: SessionUser): Promise<{
    years: { id: string; name: string; current: boolean; status: string }[];
    terms: string[];
    grades: { value: string; count: number }[];
    classes: { value: string; count: number }[];
    allLabel: string;
  }> {
    this.requireConfig(user, 'read');
    const [years, students] = await Promise.all([
      this.readAll(TABLES.academicYear.tableId),
      this.students(),
    ]);
    const terms = await this.semesterDict();
    const g = new Map<string, number>();
    const c = new Map<string, number>();
    for (const s of students) {
      const gr = this.studentGrade(s.f);
      const cl = this.studentCls(s.f);
      if (gr) g.set(gr, (g.get(gr) ?? 0) + 1);
      if (cl) c.set(cl, (c.get(cl) ?? 0) + 1);
    }
    const toList = (m: Map<string, number>) =>
      [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value, 'zh-CN'));
    return {
      years: years
        .map((y) => ({
          id: y.id,
          name: String(y.f['学年名称'] ?? ''),
          current: String(y.f['是否当前学年'] ?? '') === 'true' || y.f['是否当前学年'] === true,
          status: String(y.f['状态'] ?? ''),
        }))
        .sort((a, b) => b.name.localeCompare(a.name, 'zh-CN')),
      terms,
      grades: toList(g),
      classes: toList(c),
      allLabel: IDP_SCOPE_ALL,
    };
  }

  /**
   * IDP 老师候选（= 用户表里有「飞书 Open ID」的用户）。
   *
   * 为什么要这个接口而不是让前端自己拉用户表：明细表存的是 **open_id**，
   * 前端需要一个 `openId → 姓名` 的映射来显示（同时也用于下拉选择）。
   * 只列**有 open_id** 的用户 —— 没有 open_id 的用户即使被选中，也永远匹配不上
   * 「我的 IDP」（那个页面按 openId 过滤），会造成"分配了却看不到"的静默失败。
   */
  async teachers(user: SessionUser): Promise<{ id: string; name: string; openId: string; roles: string[] }[]> {
    this.requireConfig(user, 'read');
    const { teachers } = await this.userIndex();
    return teachers;
  }

  /** 学期字典（供配置弹窗；读不到时退回两个空值，不阻断创建） */
  private async semesterDict(): Promise<string[]> {
    const rows = await this.readAll(TABLES.systemConfig.tableId);
    for (const r of rows) {
      if (String(r.f['配置键'] ?? '') !== 'semester') continue;
      const raw = r.f['配置值'];
      const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeJson(raw) : [];
      const list = (arr as unknown[])
        .map((x) => (typeof x === 'string' ? x : String((x as { key?: string })?.key ?? '')))
        .filter(Boolean);
      if (list.length) return list;
    }
    return [];
  }

  // ───────────────────────── 学生（拉取） ─────────────────────────

  /** 在校学生（判据用 contracts 的 `idpIsEnrolled`，排除法，见那里的注释） */
  private async students(): Promise<Row[]> {
    const rows = await this.readAll(TABLES.studentProfile.tableId);
    return rows.filter((r) => idpIsEnrolled(r.f['当前状态']));
  }

  /**
   * 把范围内的学生拉进该配置的明细（**幂等**）。
   *
   * 幂等规则（三条都必要）：
   *   ① 已在明细里的学生**不重复插入**（用「已存在学生 id 集合」判，不是靠数据库唯一约束）；
   *   ② 已存在但**姓名/班级/年级快照变了**的，刷新快照（学生转班/升级后列表才对）；
   *   ③ **绝不碰「IDP老师」** —— 老师是人工分配的，重拉不能冲掉。
   */
  async pullStudents(
    user: SessionUser,
    configId: string,
    scope: IdpScope,
  ): Promise<{ added: number; refreshed: number; skipped: number; total: number; scanned: number }> {
    this.requireConfig(user, 'update');
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    const cfg = (await this.readAll(TABLES.idpConfig.tableId)).find((c) => c.id === configId);
    if (!cfg) throw new NotFoundException('NOT_FOUND');
    if (String(cfg.f[CF.状态] ?? '') === IDP_ARCHIVED) {
      throw new BadRequestException('IDP_ARCHIVED: 该配置已归档，不能再拉学生');
    }

    const [students, details] = await Promise.all([this.students(), this.readAll(TABLES.idpStudent.tableId)]);
    const mine = details.filter((d) => idpLinkId(d.f[SF.所属配置]) === configId);
    const existing = new Map(mine.map((d) => [idpLinkId(d.f[SF.学生]), d]));

    const inScope = students.filter((s) => matchesScope(s, scope, this.studentGrade.bind(this), this.studentCls.bind(this)));
    let added = 0;
    let refreshed = 0;
    let skipped = 0;
    for (const s of inScope) {
      const name = String(s.f['学生姓名'] ?? '');
      const cls = this.studentCls(s.f);
      const grade = this.studentGrade(s.f);
      const prev = existing.get(s.id);
      if (!prev) {
        await sql.create(TABLES.idpStudent.tableId, {
          [SF.所属配置]: [configId],
          [SF.学生]: [s.id],
          [SF.学生姓名]: name,
          [SF.班级]: cls,
          [SF.当前年级]: grade,
          [SF.IDP老师]: '',
          [SF.状态]: '',
          [SF.备注]: '',
        });
        added += 1;
        continue;
      }
      // ② 只刷新快照字段（update 是「合并」语义 ⇒ 不传 IDP老师就不会动它）
      const patch: Record<string, unknown> = {};
      if (String(prev.f[SF.学生姓名] ?? '') !== name) patch[SF.学生姓名] = name;
      if (String(prev.f[SF.班级] ?? '') !== cls) patch[SF.班级] = cls;
      if (String(prev.f[SF.当前年级] ?? '') !== grade) patch[SF.当前年级] = grade;
      if (Object.keys(patch).length) {
        await sql.update(TABLES.idpStudent.tableId, prev.id, patch);
        refreshed += 1;
      } else {
        skipped += 1;
      }
    }
    this.logger.log(
      `IDP 拉学生：配置 ${configId} 范围 ${describeScope(scope)} → 新增 ${added}，刷新快照 ${refreshed}，已最新 ${skipped}（在校 ${students.length} 人）`,
    );
    return { added, refreshed, skipped, total: inScope.length, scanned: students.length };
  }

  /** 明细列表（含实时沟通次数、老师姓名） */
  async configStudents(user: SessionUser, configId: string): Promise<{
    rows: IdpStudentRow[];
    rangeText: string;
    rangeOk: boolean;
    configName: string;
    archived: boolean;
  }> {
    this.requireConfig(user, 'read');
    const [cfgRows, details, years, comms, users] = await Promise.all([
      this.readAll(TABLES.idpConfig.tableId),
      this.readAll(TABLES.idpStudent.tableId),
      this.readAll(TABLES.academicYear.tableId),
      this.commsByStudent(),
      this.userIndex(),
    ]);
    const cfg = cfgRows.find((c) => c.id === configId);
    if (!cfg) throw new NotFoundException('NOT_FOUND');
    const yearId = idpLinkId(cfg.f[CF.学年]);
    const term = String(cfg.f[CF.学期] ?? '');
    const y = years.find((x) => x.id === yearId);
    const range = y ? idpTermRange(y.f['开始日期'], y.f['结束日期'], term) : null;
    const status = String(cfg.f[CF.状态] ?? '');

    const rows = details
      .filter((d) => idpLinkId(d.f[SF.所属配置]) === configId)
      .map((d) => this.toStudentRow(d, comms, users.byOpenId, range))
      .sort((a, b) => (a.cls || '~').localeCompare(b.cls || '~', 'zh-CN') || a.studentName.localeCompare(b.studentName, 'zh-CN'));

    return {
      rows,
      rangeText: range ? rangeTextOf(range) : '',
      rangeOk: !!range,
      configName: String(cfg.f[CF.配置名称] ?? '') || `${term}`,
      archived: status === IDP_ARCHIVED,
    };
  }

  /** 批量分配 / 更换 IDP 老师（一屏配一个班用） */
  async assignTeachers(
    user: SessionUser,
    configId: string,
    studentIds: string[],
    teacherOpenId: string,
  ): Promise<{ updated: number; skipped: number }> {
    this.requireConfig(user, 'update');
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    const cfg = (await this.readAll(TABLES.idpConfig.tableId)).find((c) => c.id === configId);
    if (!cfg) throw new NotFoundException('NOT_FOUND');
    if (String(cfg.f[CF.状态] ?? '') === IDP_ARCHIVED) {
      throw new BadRequestException('IDP_ARCHIVED: 该配置已归档，不能再改 IDP 老师');
    }
    // open_id 必须在用户表里真实存在 —— 防手写脏值让"老师登录后看不到自己的学生"（最难查的一类）
    if (teacherOpenId) {
      const { byOpenId } = await this.userIndex();
      if (!byOpenId.has(teacherOpenId)) {
        throw new BadRequestException(`BAD_TEACHER: 用户表里找不到 open_id ${teacherOpenId.slice(0, 8)}…`);
      }
    }
    const want = new Set(studentIds.map((x) => String(x).trim()).filter(Boolean));
    if (!want.size) return { updated: 0, skipped: 0 };
    const details = await this.readAll(TABLES.idpStudent.tableId);
    const targets = details.filter(
      (d) => idpLinkId(d.f[SF.所属配置]) === configId && want.has(idpLinkId(d.f[SF.学生])),
    );
    let updated = 0;
    for (const d of targets) {
      if (String(d.f[SF.IDP老师] ?? '') === teacherOpenId) continue;
      await sql.update(TABLES.idpStudent.tableId, d.id, { [SF.IDP老师]: teacherOpenId });
      updated += 1;
    }
    return { updated, skipped: studentIds.length - targets.length };
  }

  /** 改单个学生的状态/备注（明细表行内编辑用） */
  async patchStudent(
    user: SessionUser,
    detailId: string,
    patch: { teacherOpenId?: string; status?: string; note?: string },
  ): Promise<void> {
    this.requireConfig(user, 'update');
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    const details = await this.readAll(TABLES.idpStudent.tableId);
    const row = details.find((d) => d.id === detailId);
    if (!row) throw new NotFoundException('NOT_FOUND');
    const cfgId = idpLinkId(row.f[SF.所属配置]);
    const cfg = (await this.readAll(TABLES.idpConfig.tableId)).find((c) => c.id === cfgId);
    if (cfg && String(cfg.f[CF.状态] ?? '') === IDP_ARCHIVED) {
      throw new BadRequestException('IDP_ARCHIVED: 该配置已归档，不能再改');
    }
    const out: Record<string, unknown> = {};
    if (patch.teacherOpenId !== undefined) {
      const t = patch.teacherOpenId.trim();
      if (t) {
        const { byOpenId } = await this.userIndex();
        if (!byOpenId.has(t)) throw new BadRequestException(`BAD_TEACHER: 用户表里找不到 open_id ${t.slice(0, 8)}…`);
      }
      out[SF.IDP老师] = t;
    }
    if (patch.status !== undefined) out[SF.状态] = String(patch.status);
    if (patch.note !== undefined) out[SF.备注] = String(patch.note);
    if (!Object.keys(out).length) return;
    await sql.update(TABLES.idpStudent.tableId, detailId, out);
  }

  // ───────────────────────── 我的 IDP（老师端） ─────────────────────────

  /**
   * 我的 IDP：按「学年学期」分组，只含 `IDP老师 = 我` 的行。
   *
   * 沟通次数**实时算**（口径见 contracts）：只读一次学生记录表（当前 176 行）内存分组，
   * 比"每人去扫一遍"便宜得多，而且**老师刚记完的沟通立刻可见**（不用等缓存刷新）。
   */
  async myIdp(user: SessionUser): Promise<{
    me: { openId: string; name: string };
    groups: {
      configId: string;
      configName: string;
      yearName: string;
      term: string;
      status: string;
      archived: boolean;
      rangeText: string;
      rangeOk: boolean;
      total: number;
      talked: number;
      students: IdpStudentRow[];
    }[];
  }> {
    this.requireMyIdp(user);
    const myOpenId = String(user.openId ?? '').trim();
    const [cfgRows, details, years, comms, users] = await Promise.all([
      this.readAll(TABLES.idpConfig.tableId),
      this.readAll(TABLES.idpStudent.tableId),
      this.readAll(TABLES.academicYear.tableId),
      this.commsByStudent(),
      this.userIndex(),
    ]);
    const yearName = new Map(years.map((y) => [y.id, String(y.f['学年名称'] ?? '')]));

    const mineByConfig = new Map<string, Row[]>();
    if (myOpenId) {
      for (const d of details) {
        if (String(d.f[SF.IDP老师] ?? '').trim() !== myOpenId) continue;
        const cid = idpLinkId(d.f[SF.所属配置]);
        if (!cid) continue;
        const arr = mineByConfig.get(cid) ?? [];
        arr.push(d);
        mineByConfig.set(cid, arr);
      }
    }

    const groups = [...mineByConfig.entries()]
      .map(([configId, rows]) => {
        const cfg = cfgRows.find((c) => c.id === configId);
        const yearId = idpLinkId(cfg?.f[CF.学年]);
        const term = String(cfg?.f[CF.学期] ?? '');
        const y = years.find((x) => x.id === yearId);
        const range = y ? idpTermRange(y.f['开始日期'], y.f['结束日期'], term) : null;
        const status = String(cfg?.f[CF.状态] ?? '');
        const students = rows
          .map((d) => this.toStudentRow(d, comms, users.byOpenId, range))
          .sort((a, b) => b.lastAt - a.lastAt || a.studentName.localeCompare(b.studentName, 'zh-CN'));
        return {
          configId,
          configName:
            String(cfg?.f[CF.配置名称] ?? '') || `${yearName.get(yearId) ?? ''} ${term}`.trim() || '（配置已删除）',
          yearName: yearName.get(yearId) ?? '',
          term,
          status,
          archived: status === IDP_ARCHIVED,
          rangeText: range ? rangeTextOf(range) : '',
          rangeOk: !!range,
          total: students.length,
          talked: students.filter((s) => s.commCount > 0).length,
          students,
        };
      })
      .sort((a, b) => b.yearName.localeCompare(a.yearName, 'zh-CN') || b.term.localeCompare(a.term, 'zh-CN'));

    return {
      me: { openId: myOpenId, name: String(user.name ?? '') },
      groups,
    };
  }

  /** 某学生在本配置学年学期内的 IDP 沟通时间线（老师端抽屉用） */
  async studentComms(
    user: SessionUser,
    configId: string,
    studentId: string,
  ): Promise<{
    studentId: string;
    studentName: string;
    rangeText: string;
    rangeOk: boolean;
    noTime: number;
    rows: {
      id: string;
      subject: string;
      time: number;
      person: string;
      summary: string;
      attachments: number;
      status: string;
    }[];
  }> {
    this.requireMyIdp(user);
    const cfgRows = await this.readAll(TABLES.idpConfig.tableId);
    const cfg = cfgRows.find((c) => c.id === configId);
    if (!cfg) throw new NotFoundException('NOT_FOUND');
    const years = await this.readAll(TABLES.academicYear.tableId);
    const yearId = idpLinkId(cfg.f[CF.学年]);
    const term = String(cfg.f[CF.学期] ?? '');
    const y = years.find((x) => x.id === yearId);
    const range = y ? idpTermRange(y.f['开始日期'], y.f['结束日期'], term) : null;

    const comms = await this.commsByStudent();
    const list = comms.get(studentId) ?? [];
    const inRange: typeof list = [];
    let noTime = 0;
    for (const c of list) {
      if (!c.time) {
        noTime += 1;
        continue;
      }
      if (!range) continue;
      if (c.time < range.from || c.time > range.to) continue;
      inRange.push(c);
    }
    inRange.sort((a, b) => b.time - a.time);

    const details = await this.readAll(TABLES.idpStudent.tableId);
    const row = details.find(
      (d) => idpLinkId(d.f[SF.所属配置]) === configId && idpLinkId(d.f[SF.学生]) === studentId,
    );

    return {
      studentId,
      studentName: String(row?.f[SF.学生姓名] ?? ''),
      rangeText: range ? rangeTextOf(range) : '',
      rangeOk: !!range,
      noTime,
      rows: inRange.map((c) => ({
        id: c.id,
        subject: c.subject,
        time: c.time,
        person: c.person,
        summary: c.summary,
        attachments: c.attachments,
        status: c.status,
      })),
    };
  }

  // ───────────────────────── 沟通次数（口径收口） ─────────────────────────

  /**
   * 读全部 `记录类型=IDP沟通` 的记录，按学生分组。
   *
   * 「记录类型」是**文本字段** ⇒ 可以用 SQL 等值 filter（关联字段才不行），
   * 所以这里交给数据库过滤，只把 IDP沟通 那批（当前 10 条）读进来。
   */
  private async commsByStudent(): Promise<Map<string, CommLite[]>> {
    const sql = getSqlStore();
    const out = new Map<string, CommLite[]>();
    if (!sql) return out;
    const rows: Row[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await sql.search(TABLES.dailyFollowup.tableId, {
        pageSize: 500,
        filter: {
          conjunction: 'and',
          conditions: [{ field: STUDENT_RECORD_TYPE_FIELD, op: 'is', value: [IDP_COMM_RECORD_TYPE] }],
        },
        ...(token ? { pageToken: token } : {}),
      });
      for (const it of res.items ?? []) {
        const rec = it as unknown as { recordId?: string; fields?: Record<string, unknown> };
        const id = String(rec.recordId ?? '').trim();
        if (id) rows.push({ id, f: (rec.fields ?? {}) as Record<string, unknown> });
      }
      token = res.pageToken;
    } while (token && guard++ < 40);

    for (const r of rows) {
      // 🔴 学生关联可能是「关联学生编号」（record id）或退化成「关联学生」（姓名）——
      //    两个都收：编号优先，没有编号时用姓名当 key（明细表按 id 匹配，姓名的另建索引）。
      const sid = idpLinkId(r.f['关联学生编号']);
      const key = sid || `name:${String(r.f['关联学生'] ?? '').trim()}`;
      if (!key || key === 'name:') continue;
      const arr = out.get(key) ?? [];
      arr.push({
        id: r.id,
        time: idpTime(r.f['沟通时间']),
        subject: String(r.f['沟通主题'] ?? ''),
        summary: String(r.f['沟通总结'] ?? ''),
        person: String(r.f['沟通人'] ?? ''),
        attachments: countAttachments(r.f['沟通附件清单']),
        status: String(r.f['闭环状态'] ?? ''),
      });
      out.set(key, arr);
    }
    return out;
  }

  /**
   * 重算沟通次数并写入快照字段（**导出与列表排序用**）。
   *
   * 界面上的数字来自实时计算（更准）；这个动作把实时值**固化进表**，
   * 好处是 `GenericCrudModule` 的 CSV 导出 / 按沟通次数排序也能用。
   * 幂等：重跑只写变化的值。
   */
  async recount(
    user: SessionUser,
    configId?: string,
  ): Promise<{ scanned: number; updated: number; noTime: number; badRange: string[] }> {
    this.requireConfig(user, 'update');
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    const [cfgRows, details, years, comms] = await Promise.all([
      this.readAll(TABLES.idpConfig.tableId),
      this.readAll(TABLES.idpStudent.tableId),
      this.readAll(TABLES.academicYear.tableId),
      this.commsByStudent(),
    ]);
    const targets = configId ? details.filter((d) => idpLinkId(d.f[SF.所属配置]) === configId) : details;
    const yearCache = new Map<string, ReturnType<typeof idpTermRange>>();
    let updated = 0;
    let noTime = 0;
    const badRange: string[] = [];

    for (const d of targets) {
      const cid = idpLinkId(d.f[SF.所属配置]);
      const cfg = cfgRows.find((c) => c.id === cid);
      if (!cfg) continue;
      let range = yearCache.get(cid);
      if (range === undefined) {
        const y = years.find((x) => x.id === idpLinkId(cfg.f[CF.学年]));
        range = y ? idpTermRange(y.f['开始日期'], y.f['结束日期'], String(cfg.f[CF.学期] ?? '')) : null;
        yearCache.set(cid, range);
      }
      if (!range) {
        const label = String(cfg.f[CF.配置名称] ?? cid);
        if (!badRange.includes(label)) badRange.push(label);
        continue;
      }
      const sid = idpLinkId(d.f[SF.学生]);
      const list = comms.get(sid) ?? [];
      const stat = idpSummarizeComms(list, range);
      noTime += stat.noTime;
      const patch: Record<string, unknown> = {};
      if (Number(d.f[SF.沟通次数] ?? 0) !== stat.count) patch[SF.沟通次数] = stat.count;
      if (Number(d.f[SF.最近沟通时间] ?? 0) !== stat.lastAt) patch[SF.最近沟通时间] = stat.lastAt;
      if (String(d.f[SF.最近沟通摘要] ?? '') !== stat.lastSummary) patch[SF.最近沟通摘要] = stat.lastSummary;
      if (Object.keys(patch).length) {
        await sql.update(TABLES.idpStudent.tableId, d.id, patch);
        updated += 1;
      }
    }
    this.logger.log(`IDP 沟通次数重算：扫描 ${targets.length}，更新 ${updated}，时间缺失 ${noTime}，区间异常 ${badRange.length}`);
    return { scanned: targets.length, updated, noTime, badRange };
  }

  /** 明细行 → 返回给前端的形状（含实时沟通统计） */
  private toStudentRow(
    d: Row,
    comms: Map<string, CommLite[]>,
    byOpenId: Map<string, string>,
    range: ReturnType<typeof idpTermRange>,
  ): IdpStudentRow {
    const sid = idpLinkId(d.f[SF.学生]);
    const teacherOpenId = String(d.f[SF.IDP老师] ?? '').trim();
    const stat = range
      ? idpSummarizeComms(comms.get(sid) ?? [], range)
      : { count: 0, lastAt: 0, lastSummary: '', noTime: (comms.get(sid) ?? []).filter((c) => !c.time).length };
    return {
      id: d.id,
      studentId: sid,
      studentName: String(d.f[SF.学生姓名] ?? ''),
      cls: String(d.f[SF.班级] ?? ''),
      grade: String(d.f[SF.当前年级] ?? ''),
      teacherOpenId,
      teacherName: teacherOpenId ? byOpenId.get(teacherOpenId) ?? '（用户已删除）' : '',
      status: String(d.f[SF.状态] ?? ''),
      note: String(d.f[SF.备注] ?? ''),
      commCount: stat.count,
      lastAt: stat.lastAt,
      lastSummary: stat.lastSummary,
      noTime: stat.noTime,
    };
  }
}

// ───────────────────────── 小工具（纯函数，不进 contracts 是因为只在本模块用） ─────────────────────────

interface CommLite {
  id: string;
  time: number;
  subject: string;
  summary: string;
  person: string;
  attachments: number;
  status: string;
}

/** 时间宽容解析（与 contracts 的 `idpTimeMs` 同口径；这里只为少一次 import 循环） */
function idpTime(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000;
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function rangeTextOf(r: { from: number; to: number }): string {
  const f = new Date(r.from);
  const t = new Date(r.to);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(f)} ~ ${fmt(t)}`;
}

/** 「系统角色」字段宽容解析（数组 / JSON 字符串 / 单值） */
function parseRoles(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    const arr = safeJson(s);
    return Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean) : [];
  }
  return [s];
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 附件条目数（宽容：数组 / JSON 字符串 / 分号或换行分隔） */
function countAttachments(v: unknown): number {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.filter(Boolean).length;
  const s = String(v).trim();
  if (!s || s === '[]' || s === 'null') return 0;
  if (s.startsWith('[')) {
    const arr = safeJson(s);
    return Array.isArray(arr) ? arr.filter(Boolean).length : 0;
  }
  return s.split(/[;\n]/).filter((x) => x.trim()).length;
}

/** 范围描述（日志用） */
function describeScope(scope: IdpScope): string {
  if (scope.kind === 'all') return IDP_SCOPE_ALL;
  if (scope.kind === 'grades') return `年级 ${scope.values.join('/')}`;
  return `班级 ${scope.values.join('/')}`;
}

/** 学生是否落在拉的范围内（抽出来便于单测与复用） */
export function matchesScope(
  s: { f: Record<string, unknown> },
  scope: IdpScope,
  gradeOf: (f: Record<string, unknown>) => string,
  clsOf: (f: Record<string, unknown>) => string,
): boolean {
  if (scope.kind === 'all') return true;
  const want = new Set((scope.values ?? []).map((v) => String(v).trim()).filter(Boolean));
  if (!want.size) return true; // 没选具体值 = 不限制（前端会有提示，别静默变成"零人"）
  const actual = scope.kind === 'grades' ? gradeOf(s.f) : clsOf(s.f);
  return want.has(actual);
}
