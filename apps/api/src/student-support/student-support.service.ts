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
  DEFAULT_SUPPORT_SIGNAL_CONFIG,
  SUPPORT_CONFIG_NUMBER_FIELDS,
  SUPPORT_FIELDS as SF,
  SUPPORT_LEVELS,
  SUPPORT_SEVERITIES,
  SUPPORT_SIGNAL_META,
  SUPPORT_SIGNAL_ORDER,
  SUPPORT_SOURCE_MANUAL,
  SUPPORT_STATUS_TODO,
  SUPPORT_STATUSES,
  SUPPORT_WORD_LIST_MAX,
  TABLES,
  USER_TABLE,
  idpIsEnrolled,
  idpLinkIds,
  idpTimeMs,
  modulePermission,
  normalizeSupportSignalConfig,
  orphanStrongWords,
  supportAutoOwner,
  supportCompareRows,
  supportConfigDiffKeys,
  supportDefaultDueMs,
  supportDismissed,
  supportInScope,
  supportIsOpen,
  supportOverdueDays,
  supportPriorityOf,
  supportProblemHits,
  supportSeeAll,
  supportSignalsOf,
  supportTextOf,
  supportWordListOf,
  type SessionUser,
  type SupportBoardResult,
  type SupportBoardRow,
  type SupportCommLike,
  type SupportConfigPreview,
  type SupportConfigResult,
  type SupportDismissedRow,
  type SupportLevel,
  type SupportSignal,
  type SupportSignalConfig,
  type SupportStatus,
  type SupportStudentOption,
} from '@acms/contracts';
import { permissionsOf, type Principal } from '@acms/domain';
import { getSqlStore } from '../base.provider.js';
import { requireModule } from '../shared/require-module.js';

type Row = { id: string; f: Record<string, unknown> };

/** 聚合上下文：一次读齐的表 + 我的身份 + 判据开关（board / studentOptions / 写入校验共用） */
type AggContext = {
  students: Row[];
  comms: { byId: Map<string, SupportCommLike[]>; byName: Map<string, SupportCommLike[]> };
  supports: Row[];
  users: Map<string, string>;
  idpTeacherOf: Map<string, string>;
  seeAll: boolean;
  meIds: string[];
  nowMs: number;
  /** 信号体系的运行配置（后台「信号规则」页可改；缺省 = 代码默认） */
  config: SupportSignalConfig;
};

/** 系统配置表里存「信号规则」的配置键（与 homepage_config / nav_menu_config 同表同做法） */
const SIGNAL_CONFIG_KEY = 'student_support_config';
/** 配置行的固定 id（`createWithId` 整体替换 ⇒ 天然 upsert，不会写出重复行） */
const SIGNAL_CONFIG_ID = 'cfg_student_support';
/** 系统配置表的两个字段名 */
const CFG_FIELD_KEY = '配置键';
const CFG_FIELD_VALUE = '配置值';

/** 一个在校生的可操作视图（负责人 / 沟通 / 支持行都算好，范围判定只认这个） */
type StudentCtx = {
  id: string;
  name: string;
  nameEn: string;
  grade: string;
  cls: string;
  campus: string;
  comms: SupportCommLike[];
  sup: Row | null;
  owner: { name: string; source: string };
  headOpenId: string;
  idpOpenId: string;
};

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
  private require(user: SessionUser): { seeAll: boolean; canRemove: boolean; canConfig: boolean } {
    requireModule(user, 'studentSupport', 'read');
    const perms = [...permissionsOf(this.toPrincipal(user))];
    return {
      seeAll: supportSeeAll(perms),
      // 「移除卡片」是**另一个权限点**（v10）：破坏性操作，默认只有系统管理员持有。
      // 这里只是把"能不能显示这个按钮"告诉前端；真正写的时候 `dismiss()` 会再判一次。
      canRemove: perms.includes(modulePermission('studentSupportRemove', 'read')),
      // 「信号规则」（v11）：同上，只给前端一个"要不要显示入口"的标记；
      // 真正的读写由 configGet / configSave 各自判 studentSupportConfig。
      canConfig: perms.includes(modulePermission('studentSupportConfig', 'read')),
    };
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

  /** 我的两个身份（姓名 / openId）—— 行级范围判据要**同时认**，少传一个会漏判一半 */
  private meIdsOf(user: SessionUser): string[] {
    return [String(user.name ?? '').trim(), String(user.openId ?? '').trim()].filter(Boolean);
  }

  /**
   * IDP 老师关系（IDP学生表：一行 = 配置 × 学生，含该生这一期的 IDP 老师 openId）。
   * `board` 与 `studentOptions` 共用 —— 两处各建一份必然漂移。
   */
  private async idpTeacherIndex(): Promise<Map<string, string>> {
    const rows = await this.readAll(TABLES.idpStudent.tableId);
    const map = new Map<string, string>();
    for (const r of rows) {
      const sid = idpLinkIds(r.f['学生'])[0] ?? '';
      const t = String(r.f['IDP老师'] ?? '').trim();
      if (sid && t && !map.has(sid)) map.set(sid, t);
    }
    return map;
  }

  /**
   * 一行学生的「负责跟进」：**人工指定优先**，否则自动推导。
   *
   * 🔴 `commsDesc` 必须按时间**降序** —— 取"最近一条**有责任人**的记录"的负责人，不是
   *    "最近一条记录"的：生产实测 17/224 条没填责任人，直接取最近一条会经常拿到空。
   * ⚠️ 判据与 `board` 共用一份（`studentOptions` 里再写一遍 = 选择器与看板显示不同的人）。
   */
  private resolveOwner(input: {
    sup: Row | null;
    commsDesc: readonly SupportCommLike[];
    headName: string;
    idpName: string;
  }): { name: string; source: string } {
    const manualOwner = String(input.sup?.f[SF.负责跟进] ?? '').trim();
    const manualSrc = String(input.sup?.f[SF.负责来源] ?? '').trim();
    if (manualOwner && manualSrc === '人工指定') return { name: manualOwner, source: manualSrc };
    return supportAutoOwner({
      commOwner: input.commsDesc.find((c) => String(c.owner ?? '').trim())?.owner ?? '',
      headTeacher: input.headName,
      idpTeacher: input.idpName,
    });
  }

  /**
   * 一次读齐聚合要用的 5 张表 + 我的身份与判据开关。
   * `board` / `studentOptions` / 写动作的范围校验共用 —— 各读各的会出现"看板里有、选择器里没有"。
   */
  private async loadContext(user: SessionUser): Promise<AggContext> {
    const { seeAll } = this.require(user);
    const [students, comms, supports, users, idpTeacherOf, config] = await Promise.all([
      this.readAll(TABLES.studentProfile.tableId),
      this.commsByStudent(),
      this.readAll(TABLES.studentSupport.tableId),
      this.userIndex(),
      this.idpTeacherIndex(),
      this.loadSignalConfig(),
    ]);
    return {
      students,
      comms,
      supports,
      users,
      idpTeacherOf,
      seeAll,
      meIds: this.meIdsOf(user),
      nowMs: Date.now(),
      config,
    };
  }

  /**
   * 一个在校生的「可操作视图」（负责人、沟通、支持行都算好）。
   * 返回 null = 不是在校生 / 没有姓名。
   */
  private ctxOf(s: Row, ctx: AggContext): StudentCtx | null {
    if (!idpIsEnrolled(s.f['当前状态'])) return null;
    const name = String(s.f['学生姓名'] ?? '').trim();
    if (!name) return null;
    const comms = ctx.comms.byId.get(s.id) ?? ctx.comms.byName.get(name) ?? [];
    const headOpenId = String(s.f['班主任'] ?? '').trim();
    const idpOpenId = ctx.idpTeacherOf.get(s.id) ?? '';
    const sup = this.openSupportOf(ctx.supports, s.id);
    const owner = this.resolveOwner({
      sup,
      commsDesc: [...comms].sort((a, b) => b.ms - a.ms),
      headName: ctx.users.get(headOpenId) ?? headOpenId,
      idpName: ctx.users.get(idpOpenId) ?? idpOpenId,
    });
    return {
      id: s.id,
      name,
      nameEn: String(s.f['英文名'] ?? '').trim(),
      grade: this.studentGrade(s.f),
      cls: this.studentCls(s.f),
      campus: String(s.f['校区'] ?? '').trim(),
      comms,
      sup,
      owner,
      headOpenId,
      idpOpenId,
    };
  }

  /** 行级范围（**读与写共用一份**：`board` / `studentOptions` / `save` 都走它） */
  private inScopeOf(c: StudentCtx, ctx: AggContext): boolean {
    return supportInScope({
      seeAll: ctx.seeAll,
      owner: c.owner.name,
      headTeacher: c.headOpenId,
      idpTeacher: c.idpOpenId,
      me: ctx.meIds,
    });
  }

  // ───────────────────── 信号规则（配置，v11） ─────────────────────

  /**
   * 读「信号规则」配置。
   *
   * 存法：系统配置表（`TABLES.systemConfig`）一行，`配置键 = student_support_config`，
   * 值与 `homepage_config` / `nav_menu_config` 完全同款。
   *
   * 🔴 读的是**全量小表**（系统配置就十来行）⇒ 不做缓存。
   *    上次踩过"改了字段不生效先怀疑缓存"的坑；配置这类**改了必须立刻生效**的东西，
   *    多读十几行远比"老师改完看不见变化"便宜。
   *
   * 🔴 任何异常（行不存在 / JSON 坏了 / 字段缺失）都**逐项回落代码默认**
   *    （`normalizeSupportSignalConfig`），绝不抛错 —— 配置读坏了应该继续能看看板。
   */
  private async loadSignalConfig(): Promise<SupportSignalConfig> {
    try {
      const rows = await this.readAll(TABLES.systemConfig.tableId);
      const rec = rows.find((r) => String(r.f[CFG_FIELD_KEY] ?? '').trim() === SIGNAL_CONFIG_KEY);
      if (!rec) return DEFAULT_SUPPORT_SIGNAL_CONFIG;
      const raw = supportTextOf(rec.f[CFG_FIELD_VALUE]);
      if (!raw) return DEFAULT_SUPPORT_SIGNAL_CONFIG;
      return normalizeSupportSignalConfig(JSON.parse(raw));
    } catch {
      return DEFAULT_SUPPORT_SIGNAL_CONFIG;
    }
  }

  /**
   * 配置页打开时一次拿齐（含元信息）。
   *
   * 🔴 元信息（信号说明 / 数值项标签与区间 / 词表上限）**从 contracts 带出去**，
   *    前端不另抄一份 —— 那些说明里写着"为什么默认是 3""实测命中 56%"这类背景，
   *    两处各写必然漂移（本次已经因为同类问题返工过）。
   */
  async configGet(user: SessionUser): Promise<SupportConfigResult> {
    requireModule(user, 'studentSupportConfig', 'read');
    const config = await this.loadSignalConfig();
    return {
      config,
      defaults: DEFAULT_SUPPORT_SIGNAL_CONFIG,
      changed: supportConfigDiffKeys(config),
      orphanStrong: orphanStrongWords(config),
      signals: SUPPORT_SIGNAL_ORDER.map((k) => ({
        key: k,
        label: SUPPORT_SIGNAL_META[k].label,
        hint: SUPPORT_SIGNAL_META[k].hint,
        level: SUPPORT_SIGNAL_META[k].level,
        icon: SUPPORT_SIGNAL_META[k].icon,
      })),
      numberFields: SUPPORT_CONFIG_NUMBER_FIELDS,
      wordListMax: SUPPORT_WORD_LIST_MAX,
    };
  }

  /**
   * 保存配置（整体替换）。
   *
   * ⚠️ 归一化后再存（钳制 / 去重 / 丢孤儿强词）：**存进去的必须就是生效的那份**，
   *    否则界面显示的和判据实际用的是两回事（"我明明配了 5 天，怎么还是 14 天"）。
   */
  async configSave(user: SessionUser, body: unknown): Promise<SupportConfigResult> {
    requireModule(user, 'studentSupportConfig', 'update');
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    const config = normalizeSupportSignalConfig(body);
    await sql.createWithId(TABLES.systemConfig.tableId, SIGNAL_CONFIG_ID, {
      [CFG_FIELD_KEY]: SIGNAL_CONFIG_KEY,
      [CFG_FIELD_VALUE]: JSON.stringify(config),
      // 留痕：谁在什么时候改的（配置影响全站，出事要能查到人）
      更新人: String(user.name ?? '').trim() || '系统',
      更新时间: Date.now(),
    });
    return this.configGet(user);
  }

  /**
   * **用提交的配置试算全站**（不保存）。
   *
   * 🔴 这是本页存在的意义：调阈值/加词是高风险动作（一个宽词就能让半个学校上板），
   *    必须先看到"这样配会有多少人上板"，再决定存不存。
   *
   * 🔴 口径与看板**完全同一份判据**（同一个 `supportSignalsOf`、同一套数据装载），
   *    所以试算数字与保存后的看板**必然一致** —— 这是被"我的复算与线上差 5 倍"
   *    那次坑逼出来的规矩：任何估算都要跑真判据。
   * ⚠️ 试算**不分权限范围**（全站在校生），因为调参看的是全站效果；
   *    返回里只有人数，没有任何学生明细。
   */
  async configPreview(user: SessionUser, body: unknown): Promise<SupportConfigPreview> {
    requireModule(user, 'studentSupportConfig', 'read');
    const ctx = await this.loadContext(user);
    const current = ctx.config ?? DEFAULT_SUPPORT_SIGNAL_CONFIG;
    const proposed = normalizeSupportSignalConfig(body);

    const tally = (cfg: SupportSignalConfig) => {
      const bySignal = new Map<string, number>();
      const byLevel = new Map<string, number>();
      let onBoard = 0;
      let total = 0;
      for (const s of ctx.students) {
        if (!idpIsEnrolled(s.f['当前状态'])) continue;
        const name = String(s.f['学生姓名'] ?? '').trim();
        if (!name) continue;
        total += 1;
        const mine = ctx.comms.byId.get(s.id) ?? ctx.comms.byName.get(name) ?? [];
        const sigs = supportSignalsOf({ comms: mine }, ctx.nowMs, cfg);
        if (!sigs.length) continue;
        onBoard += 1;
        for (const k of new Set(sigs.map((x) => x.key))) bySignal.set(k, (bySignal.get(k) ?? 0) + 1);
        const lv = supportPriorityOf(sigs) || 'P2';
        byLevel.set(lv, (byLevel.get(lv) ?? 0) + 1);
      }
      return { total, onBoard, bySignal, byLevel };
    };

    const after = tally(proposed);
    const before = tally(current);
    const signalRow = (m: Map<string, number>) =>
      SUPPORT_SIGNAL_ORDER.map((k) => ({
        key: k,
        label: SUPPORT_SIGNAL_META[k].label,
        count: m.get(k) ?? 0,
      }));

    return {
      total: after.total,
      onBoard: after.onBoard,
      bySignal: signalRow(after.bySignal),
      byLevel: SUPPORT_LEVELS.map((g) => ({
        level: g.level,
        label: g.title,
        count: after.byLevel.get(g.level) ?? 0,
      })),
      before: { total: before.total, onBoard: before.onBoard, bySignal: signalRow(before.bySignal) },
    };
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
    const { seeAll, canRemove, canConfig } = this.require(user);
    const nowMs = Date.now();

    const [students, comms, supports, users, idpTeacherOf, config] = await Promise.all([
      this.readAll(TABLES.studentProfile.tableId),
      this.commsByStudent(),
      this.readAll(TABLES.studentSupport.tableId),
      this.userIndex(),
      this.idpTeacherIndex(),
      this.loadSignalConfig(),
    ]);

    const meIds = this.meIdsOf(user);
    let hiddenByScope = 0;
    /** 被「移除卡片」藏起来的人数（v10） */
    let dismissedCount = 0;
    const dismissedList: SupportDismissedRow[] = [];
    const rows: SupportBoardRow[] = [];

    for (const s of students) {
      if (!idpIsEnrolled(s.f['当前状态'])) continue;
      const name = String(s.f['学生姓名'] ?? '').trim();
      if (!name) continue;

      const mine = comms.byId.get(s.id) ?? comms.byName.get(name) ?? [];
      const signals = supportSignalsOf({ comms: mine }, nowMs, config);
      const supPreview = this.openSupportOf(supports, s.id);
      /**
       * 🔴 「移除卡片」（v10）：被忽略的学生**不上看板**。
       * 判据必须在下面那个 `continue` **之前**算出来（见收行条件的 `!dis` 那一项）。
       */
      const dis = this.dismissedOf(supports, s.id);
      /**
       * 🔴 收行的三个条件（2026-09-30 峰哥要的第二类）：
       *  ① 有信号 ⇒ 正常上板
       *  ② **没有信号，但有未关闭的支持行** ⇒ 进「已认领 · 无信号」组
       *     （否则老师认领过的人一旦信号消失就从看板上"人间蒸发"，
       *      跟进到哪了反而看不见）
       *  ③ **被移除过** ⇒ 也要收，因为要进「已移除」名单（供恢复）
       *
       * 🔴🔴 `!dis` 这一项不能省（2026-09-30 上线实测抓到的真 bug）：
       *    被移除的学生绝大多数**没有信号**（正因为没信号才被当成误报移除的），
       *    少了它就会在这里被 `continue` 掉 ⇒ 永远走不到下面的 dismissed 分支
       *    ⇒ `dismissedCount` 恒为 0、名单里也没有他 ⇒
       *    **从界面上再也恢复不了**（无声的数据消失，且不报错）。
       */
      const openSup = Boolean(supPreview) && supportIsOpen(supPreview?.f[SF.支持状态]);
      if (!signals.length && !openSup && !dis) continue;

      const sorted = [...mine].sort((a, b) => b.ms - a.ms);
      const last = sorted[0];
      const lastMs = last?.ms ?? 0;
      const lastDays = last ? Math.floor((nowMs - lastMs) / 86400000) : null;

      const sup = supPreview;
      const headOpenId = String(s.f['班主任'] ?? '').trim();
      const headName = users.get(headOpenId) ?? headOpenId;
      const idpOpenId = idpTeacherOf.get(s.id) ?? '';
      const idpName = users.get(idpOpenId) ?? idpOpenId;

      // 负责人：人工指定优先，否则自动推导（判据与 studentOptions 共用一份）
      const owner = this.resolveOwner({ sup, commsDesc: sorted, headName, idpName });

      // 行级范围（**提前到这里判**：被"移除"的学生也要按范围决定要不要进「已移除」名单）
      const inScope = supportInScope({
        seeAll,
        owner: owner.name,
        headTeacher: headOpenId,
        idpTeacher: idpOpenId,
        me: meIds,
      });

      /**
       * 🔴 「移除卡片」（v10）：被忽略的学生**不上看板**（`dis` 在上面就算好了 ——
       *    这里只是执行「计数 → 进名单 → 跳过」）。
       * 单独计数（`dismissedCount`）而**不算进 `hiddenByScope`** ——
       * 那个数字的含义是"被权限挡掉的"，混在一起会让老师以为是自己权限不够。
       */
      if (dis) {
        if (inScope) {
          dismissedCount += 1;
          if (canRemove) {
            dismissedList.push({
              studentId: s.id,
              name,
              nameEn: String(s.f['英文名'] ?? '').trim(),
              grade: this.studentGrade(s.f),
              cls: this.studentCls(s.f),
              reason: String(dis.f[SF.忽略原因] ?? '').trim(),
              who: String(dis.f[SF.忽略人] ?? '').trim(),
              ms: Number(dis.f[SF.忽略时间] ?? 0) || 0,
            });
          }
        }
        continue;
      }

      if (!inScope) {
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
        // 有信号 ⇒ 按信号定级；没信号（但有人认领）⇒ 进「已认领 · 无信号」组
        level: signals.length ? supportPriorityOf(signals) || 'P2' : 'claimed',
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
    const claimedOnly = out.filter((r) => r.level === 'claimed').length;
    const kpis = {
      // 🔴 `needSupport` **只数有信号的人**：「需要支持」的前提是有信号；
      //    「已认领但无信号」是另一类（`claimedOnly`），两者互斥、相加才是总行数。
      needSupport: out.length - claimedOnly,
      unclaimed: out.filter((r) => !r.supportStatus || r.supportStatus === SUPPORT_STATUS_TODO).length,
      neverContacted: out.filter((r) => has(r, 'neverContacted')).length,
      longSilence: out.filter((r) => has(r, 'longSilence')).length,
      problemClue: out.filter((r) => has(r, 'problemClue')).length,
      unresolved: out.filter((r) => has(r, 'unresolved')).length,
      overdue: out.filter((r) => (r.overdueDays ?? 0) > 0).length,
      claimedOnly,
    };

    return {
      seeAll,
      me: { name: String(user.name ?? ''), openId: String(user.openId ?? '') },
      kpis,
      groups: SUPPORT_LEVELS.map((g) => ({ ...g, count: out.filter((r) => r.level === g.level).length })),
      rows: out,
      hiddenByScope,
      dismissedCount,
      canRemove,
      // 看板页头据此显示直达「信号规则」配置页的入口（v11）
      canConfig,
      // 最近移除的排前面（"我刚手滑移掉的那个"最好恢复）
      dismissed: dismissedList.sort((a, b) => b.ms - a.ms),
    };
  }

  /**
   * 该生是否被「移除卡片」忽略掉（v10）。
   * 判据是"**该生任意一行**带忽略标记" —— 忽略是**学生级**的，不是某一个支持行的属性。
   */
  private dismissedOf(rows: readonly Row[], studentId: string): Row | null {
    const mine = rows.filter((r) => idpLinkIds(r.f[SF.关联学生]).includes(studentId));
    return mine.find((r) => supportDismissed(r.f[SF.已忽略])) ?? null;
  }

  /**
   * 「移除卡片」= 忽略 / 恢复（v10，2026-09-30 峰哥要求）。
   *
   * ## 语义
   *
   * 误报或"这个人我知道，不用系统提醒我"时把卡片藏起来。**不是删数据**：
   * 记下原因 / 操作人 / 时间，`on: false` 即可恢复。
   *
   * ## 为什么忽略标记写在「支持表」
   *
   * 忽略是**学生级**的（不是某一次支持的属性），但为此单独建一张表不值当
   * （看板已经要读支持表）。做法：找到该生**当前开着的支持行**，把标记写上去；
   * 若一行都没有（纯误报、还没人认领过）就先建一行（`来源` 记「人工登记」）。
   * 读侧 `dismissedOf` 只要求"任一行有标记"。
   *
   * ## 权限
   *
   * 🔴 单独一个点 `module:studentSupportRemove:read` —— 破坏性操作（能让别人看不到该看的人），
   *    **不能**跟着看板的 read 走。默认只有系统管理员持有。
   */
  async dismiss(
    user: SessionUser,
    studentId: string,
    body: { reason?: string; on?: boolean },
  ): Promise<{ ok: true; id: string; on: boolean }> {
    requireModule(user, 'studentSupportRemove', 'read');
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    // 范围校验（与读同一份判据）：不能移除范围外的学生（那等于猜着 id 破坏别人的看板）
    const row = await this.studentCtx(user, studentId);

    const on = body.on !== false;
    const reason = String(body.reason ?? '').trim();
    if (on && !reason) throw new BadRequestException('REASON_REQUIRED: 移除卡片必须填原因');

    const supports = await this.readAll(TABLES.studentSupport.tableId);
    const mine = supports.filter((r) => idpLinkIds(r.f[SF.关联学生]).includes(studentId));
    const target = mine.find((r) => supportIsOpen(r.f[SF.支持状态])) ?? mine[0] ?? null;
    const nowMs = Date.now();
    const actor = String(user.name ?? '').trim() || '系统';
    const fields: Record<string, unknown> = {
      [SF.已忽略]: on ? '是' : '否',
      [SF.忽略原因]: on ? reason : '',
      [SF.忽略人]: on ? actor : '',
      [SF.忽略时间]: on ? nowMs : 0,
      [SF.更新人]: actor,
      [SF.更新时间]: nowMs,
    };

    if (target) {
      await sql.update(TABLES.studentSupport.tableId, target.id, fields);
      return { ok: true, id: target.id, on };
    }
    // 一行都没有（纯误报、从没人认领过）⇒ 建一行承载标记
    const id = `dismiss_${studentId}`;
    await sql.createWithId(TABLES.studentSupport.tableId, id, {
      ...fields,
      [SF.关联学生]: [studentId],
      [SF.学生姓名]: row.name,
      [SF.来源]: SUPPORT_SOURCE_MANUAL,
    });
    return { ok: true, id, on };
  }

  /**
   * 「我可以给谁登记」的候选 —— 给**登记弹窗**里的学生选择器用。
   *
   * 🔴🔴 为什么需要这个接口（峰哥 2026-09-30 指出）：
   *    看板只显示**有信号**的学生。一个没命中任何信号的学生（比如老师自己觉得该盯着），
   *    在看板上根本不存在 ⇒ 想给他登记一条支持**没有任何入口**。
   *    设计稿里页头那个「＋ 登记支持」正是为此准备的（弹窗里搜学生）。
   *
   * 🔴 范围与 `board` 用**同一份判据**（`supportInScope`）—— 不能因为"选择器里搜得到"
   *    就绕过看板的行级限制（否则老师能给全校登记，而看板里他只看得到自己那几个）。
   * 🔴 **没上板的学生也在候选里**（`onBoard: false`），这才是本接口存在的意义。
   */
  async studentOptions(user: SessionUser): Promise<SupportStudentOption[]> {
    const ctx = await this.loadContext(user);
    const out: SupportStudentOption[] = [];

    for (const s of ctx.students) {
      const c = this.ctxOf(s, ctx);
      if (!c || !this.inScopeOf(c, ctx)) continue;
      out.push({
        studentId: c.id,
        name: c.name,
        nameEn: c.nameEn,
        grade: c.grade,
        cls: c.cls,
        campus: c.campus,
        owner: c.owner.name,
        ownerSource: c.owner.source,
        onBoard: supportSignalsOf({ comms: c.comms }, ctx.nowMs, ctx.config).length > 0,
        supportStatus: String(c.sup?.f[SF.支持状态] ?? '').trim(),
      });
    }

    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  /**
   * 写动作的范围校验（`save` / `claim` / `resolve` 共用）。
   *
   * 🔴🔴 **绝不能走 `detail()`**：detail 依赖 `board()`，而 board 只收"有信号"的学生
   *    ⇒ 给**看板上没有的学生**登记必然 404 —— 而「＋ 登记支持」的全部意义
   *    就是这个（2026-09-30 上线实测踩到：接口返 404，库里 0 行）。
   *    这里只要求"这个学生在我范围内"，**不要求他在看板上**。
   */
  private async studentCtx(user: SessionUser, studentId: string): Promise<StudentCtx> {
    const ctx = await this.loadContext(user);
    const s = ctx.students.find((x) => x.id === studentId);
    const c = s ? this.ctxOf(s, ctx) : null;
    if (!c) throw new NotFoundException('NOT_FOUND: 学生不存在或已离校');
    if (!this.inScopeOf(c, ctx)) throw new NotFoundException('NOT_FOUND: 该学生不在你的范围内');
    return c;
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
    // ⚠️ 这里**故意**走 `board()`：抽屉是从看板卡片打开的，学生必然在板上，
    //    而且需要行里的 `signals` 等字段。**写动作不要复用本方法**（见 `studentCtx` 的注释：
    //    给"看板上没有的学生"登记会因此 404 —— 而那正是「＋ 登记支持」的用途）。
    const boardData = await this.board(user);
    const row = boardData.rows.find((r) => r.studentId === studentId);
    if (!row) throw new NotFoundException('NOT_FOUND: 该学生不在你的看板范围内');

    // 命中词用**当前生效的配置词表**（与 board 同一份，不另用代码默认 —— 否则改了词表
    // 会出现"看板按新词表上板、抽屉里的命中词还是老的"）
    const config = await this.loadSignalConfig();
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
        hits: supportProblemHits(`${c.subject ?? ''}\n${body}`, supportWordListOf(config)).words.slice(0, 5),
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

    // 行级范围：看不到这个学生的人也不许写（与读同一份判据）。
    // 🔴 这里**不能**用 `this.detail()` —— detail 依赖 `board()`，而 board 只收"有信号"的学生
    //    ⇒ 「＋ 登记支持」里选一个**看板上没有的学生**（那正是这个入口的用途）会 404。
    //    2026-09-30 上线实测踩到：接口 404、库里 0 行。守卫钉住了这一点。
    const row = await this.studentCtx(user, studentId);

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
      [SF.来源]: String(body.source ?? SUPPORT_SOURCE_MANUAL).trim() || SUPPORT_SOURCE_MANUAL,
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

  /**
   * 定时任务用：**系统视角**的看板快照（2026-09-30，峰哥要的「看板定时任务」）。
   *
   * 🔴 复用 `board()` 本身，**不另写一份统计** —— 看板的数字口径（谁上板、什么算待认领、
   *    被移除的算不算）只有 `board` 知道；再数一遍 ⇒ 迟早出现
   *    "任务详情说 50 人、页面显示 48 人"这种没人能解释的差异。
   * ⚠️ 后台跑没有会话，这里**伪造一个系统管理员身份**：`roles: ['系统管理员']`
   *    ⇒ `permissionsOf` 给全量权限 ⇒ `seeAll = true`，拿到的是**全站**数字
   *    （这正是"快照"要的：不是某个老师视角）。
   */
  async snapshot(): Promise<string> {
    const system: SessionUser = {
      openId: '',
      name: '系统 · 定时任务',
      roles: ['系统管理员'],
      campuses: [],
      maxDataLevel: 'L4',
      // 后台没有会话：这两个字段只是类型要求（board 里不读它们）
      sessionId: 'scheduled-tasks',
      expiresAt: Date.now() + 60_000,
    };
    const b = await this.board(system);
    const k = b.kpis;
    return (
      `需要支持 ${k.needSupport} 人（待认领 ${k.unclaimed}）· 从未沟通 ${k.neverContacted} · ` +
      `长期失联 ${k.longSilence} · 问题线索 ${k.problemClue} · 反复未缓解 ${k.unresolved} · ` +
      `已认领无信号 ${k.claimedOnly} · 超期 ${k.overdue} · 已移除 ${b.dismissedCount}`
    );
  }
}

