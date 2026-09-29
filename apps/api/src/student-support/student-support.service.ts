/**
 * 学生支持看板 —— 聚合服务（2026-09-29 峰哥需求）。
 *
 * ## 这一页要回答的三件事
 *
 * ```
 * 今天该找谁       → board()：按优先级分组 + 「最久没被想起的排最前」
 * 为什么要找他     → 每行的 signals[]，每条都带**证据原文**（判据在 contracts）
 * 谁在管、到哪了   → 负责人（自动带出）+ 学生级状态 + 超期天数 + 沟通时间线
 * ```
 *
 * ## 判据一律来自 contracts（别在这里重写）
 *
 * `supportSignalsOf`（七条信号）、`supportPriorityOf`（进哪个分组）、`supportCompareRows`（排序）、
 * `supportAutoOwner`（负责人推导）、`supportInScope`（行级范围）、`supportSeeAll`（看全部开关）、
 * `supportOverdueDays`（超期）、`supportDefaultDueMs`（默认期望日期）、`supportProblemHits`（命中词）。
 * 这些被前端与单测共用；在 service 里再写一份必然漂移。
 *
 * ## 🔴🔴 两条必须守住的约束
 *
 * **① 不依赖任何"人工维护的状态字段"。** 生产实测：`闭环状态` 223/224 是默认值、
 *    `待办事项` 全空、学生档案的 `心理状态`/`预警科目`/`特殊支持摘要` 全 0 有值
 *    ⇒ 信号只能**从已有记录自动推导**，否则上线即空板（且不报错）。
 *
 * **② 没归属的学生必须任何范围都能看到。** 「从未沟通」的 9 人里有一批正是因为
 *    **没有沟通记录 ⇒ 也推导不出责任人**；若按「负责人 = 我」过滤，"没人管的学生"
 *    恰好被筛掉 —— 而他们恰恰是最该被看见的。判据在 `supportInScope`（专门留了分支）。
 *
 * ## 权限
 *
 * | 能力 | 判据 |
 * |---|---|
 * | 看板页 / 全部接口（含写） | `module:studentSupport:read`（见 module-permissions 文件头 v9） |
 * | 看全部学生 | `module:studentSupportAll:read` |
 *
 * ## 数据来源
 *
 * - 学生基准盘：`TABLES.studentProfile`（只读）—— 只收 `idpIsEnrolled` 在校生
 * - 沟通记录：`TABLES.dailyFollowup`（五类合并，一手数据）
 *   🔴 关联用 **`关联学生编号`（record id 数组）**；`关联学生` 存的是**姓名文本**
 *      （生产实测 75 个姓名全能匹配上，极具迷惑性），只作兜底。
 * - 支持状态：`TABLES.studentSupport`（本模块新建，一行 = 学生 × 一次支持）
 * - 班主任 / IDP 老师存的是 **openId** ⇒ 用用户表转姓名
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  SUPPORT_FIELDS as SF,
  SUPPORT_LEVELS,
  SUPPORT_SEVERITIES,
  SUPPORT_STATUS_TODO,
  SUPPORT_STATUSES,
  TABLES,
  USER_TABLE,
  idpIsEnrolled,
  idpLinkIds,
  idpTimeMs,
  supportAutoOwner,
  supportCompareRows,
  supportDefaultDueMs,
  supportInScope,
  supportIsOpen,
  supportOverdueDays,
  supportPriorityOf,
  supportProblemHits,
  supportSeeAll,
  supportSignalsOf,
  supportTextOf,
  type SessionUser,
  type SupportBoardResult,
  type SupportBoardRow,
  type SupportCommLike,
  type SupportLevel,
  type SupportSignal,
  type SupportStatus,
} from '@acms/contracts';
import { permissionsOf, type Principal } from '@acms/domain';
import { getSqlStore } from '../base.provider.js';
import { requireModule } from '../shared/require-module.js';

type Row = { id: string; f: Record<string, unknown> };

/** 学生表里「班级」/「年级」的候选字段（与成绩册 `MarkbookService.CLASS_FIELDS` 同口径） */
const STUDENT_CLASS_FIELDS = ['当前班级', '当前年级'] as const;
const STUDENT_GRADE_FIELDS = ['当前年级', '入学年级'] as const;
/** 用户表里存 open_id 的字段 */
const USER_OPEN_ID_FIELD = '飞书 Open ID';
/** 用户表里「姓名」字段 */
const USER_NAME_FIELD = '姓名';

@Injectable()
export class StudentSupportService {
  private toPrincipal(user: SessionUser): Principal {
    return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
  }

  /**
   * 看板页与全部接口的入口判据（**写动作也走它**，见 module-permissions 文件头 v9：
   * 教职工角色没有任何"都持有"的写权限点，硬找一个会让老师点「认领」直接 403）。
   */
  private require(user: SessionUser): { seeAll: boolean } {
    requireModule(user, 'studentSupport', 'read');
    const perms = [...permissionsOf(this.toPrincipal(user))];
    return { seeAll: supportSeeAll(perms) };
  }

  // ───────────────────────── 读表 ─────────────────────────

  /**
   * 全量读一张表。
   *
   * 🔴 为什么不走 SQL filter：`SqlStore.buildCondition` 用 `data ->> field` 取文本，
   *    而关联字段存的是 **id 数组** ⇒ 等值/包含都匹配不上（套件老坑）。
   *    这几张都是小表（学生 84 / 记录 224 / 支持 几十）⇒ 全量读 + 内存过滤最可靠。
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

  /** openId → 姓名（记录里存姓名、学生档案的班主任存 openId，两边要能对上） */
  private async userIndex(): Promise<Map<string, string>> {
    const rows = await this.readAll(USER_TABLE.tableId);
    const byOpenId = new Map<string, string>();
    for (const r of rows) {
      const name = String(r.f[USER_NAME_FIELD] ?? '').trim();
      const openId = String(r.f[USER_OPEN_ID_FIELD] ?? '').trim();
      if (name && openId) byOpenId.set(openId, name);
    }
    return byOpenId;
  }

  /**
   * 负责人候选（用户表里有飞书 Open ID 的人）。
   *
   * 🔴 为什么不直接调 `/users`：那个接口属别的模块的权限点，普通老师打它 **403**
   *    ⇒ 下拉是空的，看起来像"系统里一个老师都没有"（套件「模块与页面开发/05」第 4 节踩过）。
   *    自带一个只读候选端点、挂**本模块**的读权限即可。
   */
  async ownerOptions(user: SessionUser): Promise<{ name: string; openId: string }[]> {
    this.require(user);
    const users = await this.userIndex();
    return [...users.entries()]
      .map(([openId, name]) => ({ name, openId }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  private studentGrade(f: Record<string, unknown>): string {
    for (const k of STUDENT_GRADE_FIELDS) {
      const v = supportTextOf(f[k]);
      if (v) return v;
    }
    return '';
  }

  private studentCls(f: Record<string, unknown>): string {
    for (const k of STUDENT_CLASS_FIELDS) {
      const v = supportTextOf(f[k]);
      if (v) return v;
    }
    return '';
  }

  /**
   * 把沟通记录按**学生**分组。
   *
   * 🔴 关联优先用 `关联学生编号`（record id 数组）；`关联学生` 是**姓名字符串**
   *    （生产实测 75 个全能匹配上、看着完全正常，但姓名会重名会改名）
   *    ⇒ 只在没有编号时用姓名兜底，并单独建 `byName` 索引。
   */
  private async commsByStudent(): Promise<{
    byId: Map<string, SupportCommLike[]>;
    byName: Map<string, SupportCommLike[]>;
  }> {
    const rows = await this.readAll(TABLES.dailyFollowup.tableId);
    const byId = new Map<string, SupportCommLike[]>();
    const byName = new Map<string, SupportCommLike[]>();
    for (const r of rows) {
      const f = r.f;
      const like: SupportCommLike = {
        ms: idpTimeMs(f['沟通时间']),
        kind: String(f['记录类型'] ?? '').trim(),
        subject: String(f['沟通主题'] ?? '').trim(),
        // 问题线索扫描的正文：总结（AI 录音总结，217/224 有值）+ 明细（216 条）
        body: `${String(f['沟通总结'] ?? '')}\n${String(f['沟通明细'] ?? '')}`,
        owner: String(f['责任人'] ?? '').trim(),
      };
      for (const sid of idpLinkIds(f['关联学生编号'])) {
        byId.set(sid, [...(byId.get(sid) ?? []), like]);
      }
      const nm = String(f['关联学生'] ?? '').trim();
      if (nm) byName.set(nm, [...(byName.get(nm) ?? []), like]);
    }
    return { byId, byName };
  }

  /** 该学生**未关闭**的支持行（一行 = 学生 × 一次支持；没有则返回 null） */
  private openSupportOf(rows: readonly Row[], studentId: string): Row | null {
    const mine = rows.filter((r) => idpLinkIds(r.f[SF.关联学生]).includes(studentId));
    if (!mine.length) return null;
    const open = mine.filter((r) => supportIsOpen(r.f[SF.支持状态]));
    const pick = (open.length ? open : mine).sort(
      (a, b) =>
        Number(b.f[SF.更新时间] ?? b.f[SF.认领时间] ?? 0) - Number(a.f[SF.更新时间] ?? a.f[SF.认领时间] ?? 0),
    );
    return pick[0] ?? null;
  }

  // ───────────────────────── 看板 ─────────────────────────

  /**
   * 看板聚合：**一次返回全部行**（前端不再逐个请求，避免 N+1）。
   *
   * 只返回**有信号**的学生（`supportSignalsOf` 至少命中一条）—— 没有信号的正常学生不上板，
   * 这是本页与「学生档案列表」的根本区别。
   */
  async board(
    user: SessionUser,
    query: { campus?: string; owner?: string; signal?: string; mine?: string } = {},
  ): Promise<SupportBoardResult> {
    const { seeAll } = this.require(user);
    const nowMs = Date.now();

    const [students, comms, supports, users, idpRows] = await Promise.all([
      this.readAll(TABLES.studentProfile.tableId),
      this.commsByStudent(),
      this.readAll(TABLES.studentSupport.tableId),
      this.userIndex(),
      this.readAll(TABLES.idpStudent.tableId),
    ]);

    // IDP 老师关系（IDP学生表：一行 = 配置 × 学生，含该生这一期的 IDP 老师 openId）
    const idpTeacherOf = new Map<string, string>();
    for (const r of idpRows) {
      const sid = idpLinkIds(r.f['学生'])[0] ?? '';
      const t = String(r.f['IDP老师'] ?? '').trim();
      if (sid && t && !idpTeacherOf.has(sid)) idpTeacherOf.set(sid, t);
    }

    const meIds = [String(user.name ?? '').trim(), String(user.openId ?? '').trim()].filter(Boolean);
    let hiddenByScope = 0;
    const rows: SupportBoardRow[] = [];

    for (const s of students) {
      if (!idpIsEnrolled(s.f['当前状态'])) continue;
      const name = String(s.f['学生姓名'] ?? '').trim();
      if (!name) continue;

      const mine = comms.byId.get(s.id) ?? comms.byName.get(name) ?? [];
      const signals = supportSignalsOf({ comms: mine }, nowMs);
      if (!signals.length) continue; // 没有信号 ⇒ 不上板

      const sorted = [...mine].sort((a, b) => b.ms - a.ms);
      const last = sorted[0];
      const lastMs = last?.ms ?? 0;
      const lastDays = last ? Math.floor((nowMs - lastMs) / 86400000) : null;

      const sup = this.openSupportOf(supports, s.id);
      const headOpenId = String(s.f['班主任'] ?? '').trim();
      const headName = users.get(headOpenId) ?? headOpenId;
      const idpOpenId = idpTeacherOf.get(s.id) ?? '';
      const idpName = users.get(idpOpenId) ?? idpOpenId;

      // 负责人：人工指定的优先，否则自动推导
      const manualOwner = String(sup?.f[SF.负责跟进] ?? '').trim();
      const manualSrc = String(sup?.f[SF.负责来源] ?? '').trim();
      const isManual = Boolean(manualOwner) && manualSrc === '人工指定';
      const auto = supportAutoOwner({
        // 🔴 用"最近一条**有责任人**的记录"的责任人，不是"最近一条记录"的 ——
        //    生产实测 17/224 条没填责任人，直接取最近一条会经常拿到空。
        commOwner: sorted.find((c) => String(c.owner ?? '').trim())?.owner ?? '',
        headTeacher: headName,
        idpTeacher: idpName,
      });
      const owner = isManual ? { name: manualOwner, source: manualSrc } : auto;

      // 行级范围：默认只看「我是负责人 / 班主任 / IDP 老师」的学生
      if (
        !supportInScope({
          seeAll,
          owner: owner.name,
          headTeacher: headOpenId,
          idpTeacher: idpOpenId,
          me: meIds,
        })
      ) {
        hiddenByScope += 1;
        continue;
      }

      const status = (String(sup?.f[SF.支持状态] ?? '').trim() || '') as SupportStatus | '';
      const dueMs = Number(sup?.f[SF.期望回应日期] ?? 0) || 0;

      rows.push({
        studentId: s.id,
        name,
        nameEn: String(s.f['英文名'] ?? '').trim(),
        grade: this.studentGrade(s.f),
        cls: this.studentCls(s.f),
        campus: String(s.f['校区'] ?? '').trim(),
        studentStatus: String(s.f['当前状态'] ?? '').trim(),
        signals,
        level: supportPriorityOf(signals) || 'P2',
        commCount: mine.length,
        lastMs,
        lastDays,
        lastSubject: last?.subject ?? '',
        lastKind: last?.kind ?? '',
        supportId: sup?.id ?? '',
        supportStatus: status,
        problemType: String(sup?.f[SF.问题类型] ?? '').trim(),
        severity: String(sup?.f[SF.严重程度] ?? '').trim(),
        problemText: String(sup?.f[SF.问题描述] ?? '').trim(),
        owner: owner.name,
        ownerSource: owner.source,
        dueMs,
        overdueDays: supportOverdueDays({ status, dueMs }, nowMs),
        claimMs: Number(sup?.f[SF.认领时间] ?? 0) || 0,
        note: String(sup?.f[SF.处理备注] ?? '').trim(),
        headTeacherName: headName,
        idpTeacherName: idpName,
      });
    }

    // ── 筛选（内存里做：数据量小，且关联字段走 SQL 筛不出来）──
    let out = rows;
    if (query.campus) out = out.filter((r) => r.campus === query.campus);
    if (query.owner) out = out.filter((r) => r.owner === query.owner);
    if (query.mine === '1') out = out.filter((r) => meIds.some((m) => r.owner.includes(m)));
    if (query.signal) out = out.filter((r) => r.signals.some((x) => x.key === query.signal));

    out = [...out].sort(supportCompareRows);

    // ── KPI 按**筛选后**的集合算（跟列表所见一致，避免"数字与列表对不上"）──
    const has = (r: SupportBoardRow, key: string) => r.signals.some((x) => x.key === key);
    const kpis = {
      needSupport: out.length,
      unclaimed: out.filter((r) => !r.supportStatus || r.supportStatus === SUPPORT_STATUS_TODO).length,
      neverContacted: out.filter((r) => has(r, 'neverContacted')).length,
      longSilence: out.filter((r) => has(r, 'longSilence')).length,
      problemClue: out.filter((r) => has(r, 'problemClue') || has(r, 'unresolved')).length,
      overdue: out.filter((r) => (r.overdueDays ?? 0) > 0).length,
    };

    return {
      seeAll,
      me: { name: String(user.name ?? ''), openId: String(user.openId ?? '') },
      kpis,
      groups: SUPPORT_LEVELS.map((g) => ({ ...g, count: out.filter((r) => r.level === g.level).length })),
      rows: out,
      hiddenByScope,
    };
  }

  // ───────────────────────── 支持卡详情 ─────────────────────────

  /**
   * 支持卡详情（右侧抽屉）：信号证据 + 沟通时间线 + 动作记录。
   *
   * ⚠️ 这里复用 `board()` 来取行与做范围校验（`board` 会读 5 张表）。
   *    数据量小（学生 84 / 记录 224），一次抽屉打开多读几张表无所谓；
   *    换来的是**"能不能看见"只在一处判定**（否则详情接口很容易漏掉范围校验，
   *    变成"看不到卡片但能猜 URL 读到数据"）。要优化再抽 `loadAll()` 共享读。
   */
  async detail(user: SessionUser, studentId: string): Promise<{
    row: SupportBoardRow;
    timeline: {
      id: string;
      ms: number;
      kind: string;
      subject: string;
      owner: string;
      excerpt: string;
      hits: string[];
    }[];
    actions: { ms: number; who: string; what: string }[];
  }> {
    const boardData = await this.board(user);
    const row = boardData.rows.find((r) => r.studentId === studentId);
    if (!row) throw new NotFoundException('NOT_FOUND: 该学生不在你的看板范围内');

    const comms = await this.commsByStudent();
    const mine = [...(comms.byId.get(studentId) ?? comms.byName.get(row.name) ?? [])].sort(
      (a, b) => b.ms - a.ms,
    );

    const timeline = mine.slice(0, 30).map((c, i) => {
      const body = String(c.body ?? '');
      return {
        id: `${studentId}-${i}`,
        ms: c.ms,
        kind: String(c.kind ?? ''),
        subject: String(c.subject ?? ''),
        owner: String(c.owner ?? ''),
        excerpt: body.replace(/\s+/g, ' ').slice(0, 160),
        // 命中的问题词（前端挂在时间线条目下当"证据原文"用）
        hits: supportProblemHits(`${c.subject ?? ''}\n${body}`).words.slice(0, 5),
      };
    });

    const supports = await this.readAll(TABLES.studentSupport.tableId);
    const actions = supports
      .filter((r) => idpLinkIds(r.f[SF.关联学生]).includes(studentId))
      .map((r) => ({
        ms: Number(r.f[SF.更新时间] ?? r.f[SF.认领时间] ?? 0) || 0,
        who: String(r.f[SF.更新人] ?? '系统'),
        what: [
          String(r.f[SF.来源] ?? '').trim(),
          `状态 ${String(r.f[SF.支持状态] ?? '')}`,
          String(r.f[SF.问题类型] ?? '').trim(),
          String(r.f[SF.严重程度] ?? '').trim(),
          String(r.f[SF.负责跟进] ?? '').trim() ? `负责人 ${String(r.f[SF.负责跟进])}` : '',
          String(r.f[SF.处理备注] ?? '').trim(),
        ]
          .filter(Boolean)
          .join(' · '),
      }))
      .sort((a, b) => b.ms - a.ms);

    return { row, timeline, actions };
  }

  // ───────────────────────── 写 ─────────────────────────

  /**
   * 认领 / 登记 / 更新 —— **一个接口做三件事**（看板上的动作都是"我对这个学生做点什么"）。
   *
   * 幂等键 = **学生**（`关联学生` + 未关闭）。一个学生同时只该有一条未关闭的支持行：
   * 再点一次是"更新"而不是"新建" —— 否则看板上同一个学生会出现两行。
   *
   * 规则：
   * - 没有未关闭行 ⇒ 新建（状态 = 传的 status ?? `跟进中`；来源 = 传的 source ?? '人工登记'）
   * - 已有 ⇒ 只更新**传了的**字段（未传的不动 —— 与全站"保存语义"一致，别把没传的清成空）
   * - 传了 `owner` ⇒ 标 `负责来源 = 人工指定`（之后自动推导不再覆盖它）
   */
  async save(
    user: SessionUser,
    studentId: string,
    body: {
      problemType?: string;
      severity?: string;
      problemText?: string;
      owner?: string;
      dueMs?: number;
      note?: string;
      status?: string;
      source?: string;
    },
  ): Promise<{ ok: true; id: string; created: boolean }> {
    this.require(user);
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');

    // 行级范围：看不到这个学生的人也不许写（与读用同一份判据）
    const { row } = await this.detail(user, studentId);

    // 值校验：字典可增删，但**状态**是流程状态（值域在代码里）
    const status = body.status != null ? String(body.status).trim() : '';
    if (status && !SUPPORT_STATUSES.includes(status as SupportStatus)) {
      throw new BadRequestException(`BAD_STATUS: 未知状态 ${status}`);
    }
    const severity = body.severity != null ? String(body.severity).trim() : '';
    if (severity && !SUPPORT_SEVERITIES.includes(severity as never)) {
      throw new BadRequestException(`BAD_SEVERITY: 未知严重程度 ${severity}`);
    }

    const supports = await this.readAll(TABLES.studentSupport.tableId);
    const existing = this.openSupportOf(
      supports.filter((r) => supportIsOpen(r.f[SF.支持状态])),
      studentId,
    );
    const nowMs = Date.now();
    const actor = String(user.name ?? '').trim() || '系统';

    const fields: Record<string, unknown> = {
      [SF.学生姓名]: row.name,
      [SF.关联学生]: [studentId],
      [SF.更新人]: actor,
      [SF.更新时间]: nowMs,
    };
    if (body.problemType != null) fields[SF.问题类型] = String(body.problemType).trim();
    if (body.severity != null) fields[SF.严重程度] = severity;
    if (body.problemText != null) fields[SF.问题描述] = String(body.problemText).trim();
    if (body.owner != null) {
      fields[SF.负责跟进] = String(body.owner).trim();
      fields[SF.负责来源] = '人工指定';
    }
    if (body.dueMs != null) fields[SF.期望回应日期] = Number(body.dueMs) || 0;
    if (body.note != null) fields[SF.处理备注] = String(body.note).trim();

    if (existing) {
      // 更新：`update` 是**合并**语义（SQL 侧 `data || $1`）⇒ 未传的字段天然不动 ✓
      if (status) {
        fields[SF.支持状态] = status;
        if (status === '已缓解' || status === '已关闭') fields[SF.关闭时间] = nowMs;
      }
      await sql.update(TABLES.studentSupport.tableId, existing.id, fields);
      return { ok: true, id: existing.id, created: false };
    }

    const created = await sql.create(TABLES.studentSupport.tableId, {
      ...fields,
      [SF.支持状态]: status || '跟进中',
      [SF.严重程度]: severity || '需介入',
      [SF.期望回应日期]: Number(body.dueMs ?? 0) || supportDefaultDueMs(nowMs),
      [SF.认领时间]: nowMs,
      [SF.来源]: String(body.source ?? '人工登记').trim() || '人工登记',
    });
    return { ok: true, id: created, created: true };
  }

  /**
   * 状态流转（已缓解 / 关闭 / 升级）。
   *
   * 🔴 之后**把未关闭行改成终态**。若该学生的信号仍在（比如仍 30 天没联系），
   *    下次打开看板**仍会显示** —— 这是**有意**的：状态是"人对这次支持的处理"，
   *    信号是"客观事实"，两者不互相覆盖。老师看到的是"上次已缓解，但又有新信号了"。
   *    （所以 `supportSignalsOf` 与支持状态**完全解耦**，别在信号里读状态。）
   */
  async resolve(
    user: SessionUser,
    studentId: string,
    body: { status?: string; note?: string; owner?: string },
  ): Promise<{ ok: true; id: string }> {
    const status = String(body.status ?? '').trim();
    if (!['已缓解', '已关闭', '已升级'].includes(status)) {
      throw new BadRequestException('BAD_STATUS: 只接受 已缓解 / 已关闭 / 已升级');
    }
    const res = await this.save(user, studentId, { status, note: body.note, owner: body.owner });
    return { ok: true, id: res.id };
  }
}

