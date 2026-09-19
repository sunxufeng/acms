import { Inject, Injectable, ForbiddenException, Logger } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import {
  TABLES,
  USER_TABLE,
  NOTE_SOURCE_TYPES,
  modulePermission,
  REPORT_MODULE_KEYS,
  type ReportKey,
} from '@acms/contracts';
import { BASE_CLIENT, getSqlStore } from '../base.provider.js';
import { LoginLogService } from '../login-log/login-log.service.js';
import { buildDedupGroups, toDedupRow, type DedupResult, type DedupRow } from './contact-dedup.js';
import {
  buildCodeTable,
  computeAttendanceReport,
  type AttendanceReport,
  type AttendanceInputRow,
  type RateCode,
  type StudentInfo,
} from './attendance-rate.js';
import { linkIds } from '../shared/record.util.js';
import { textOf } from '../markbook/markbook.logic.js';
import { StudentScopeService } from '../shared/student-scope.service.js';
import {
  aggregateByStudent,
  competitionRanks,
  computeBands,
  gpaBands,
  mean,
  quantile,
  type TermGradeLike,
} from './exam-stats.js';

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/**
 * 报表接口鉴权：**任一**报表权限即可（v3，2026-09-19）。
 *
 * 为什么是「任一」而不是一对一：
 *   `/reports/students` 一个接口同时喂四张报表（学生结构概览 / 年级升级流向 / 入学趋势 /
 *   档案完整度），拆成四个接口只为了对齐权限并不划算。角色被授予其中**任意一张**，
 *   这个接口就放行 —— 前端只会渲染他有权限的那几张卡，不会因此多看到东西。
 *
 * 权限点来自 contracts 的 `REPORT_MODULE_KEYS`（单一真源），不要在这里手写字符串。
 */
function canSeeReport(user: SessionUser, keys: readonly ReportKey[]): boolean {
  const principal = toPrincipal(user);
  return keys.some((k) => authorize(principal, modulePermission(REPORT_MODULE_KEYS[k], 'read')).allowed);
}

/**
 * 同上，但**不通过就抛 403**，且错误消息带上真正缺的那个权限点。
 *
 * 为什么要收口到这里（2026-09-19 自查发现）：改按报表授权时只换了判定语句，
 * 抛错文案还留着旧的 `FORBIDDEN:module:reports:read` —— 排查的人会照着提示去勾
 * 「报表管理」，勾完依旧 403，白折腾一轮。判定与提示必须同源。
 */
function requireReport(user: SessionUser, keys: readonly ReportKey[]): void {
  if (canSeeReport(user, keys)) return;
  const need = keys.map((k) => modulePermission(REPORT_MODULE_KEYS[k], 'read')).join(' | ');
  throw new ForbiddenException(`FORBIDDEN:${need}`);
}

/** 报表维度字段：保留真实值（分组统计与筛选需要） */
const DIMENSION_FIELDS: readonly string[] = [
  '校区', '当前年级', '入学年级', '入学年份', '是否是新生', '性别',
  // 2026-09-11 新增：学生结构概览要按这些维度统计
  '班主任', '招生负责老师', '升学导师', '当前状态',
];

/** 存的是 open_id、但报表里要显示姓名的人员字段 */
const PERSON_FIELDS = new Set(['班主任', '招生负责老师', '升学导师']);

/**
 * 参与「档案完整度」统计的字段。
 * 必须与前端 `apps/web/components/reports/panels.tsx` 的 COMPLETENESS_FIELDS 保持一致，
 * 否则前后两端的缺失率会不一致。
 */
const COMPLETENESS_FIELDS: readonly string[] = [
  '性别', '出生日期', '入学日期', '校区', '当前年级', '入学年级', '入学年份',
  '当前学段', '实际学制', '入学类型', '来源渠道', '原学校', '原学校类型',
  '合同状态', '付款状态', '综合评定等级', '签证情况', '数据密级',
  '学生手机号', '学生邮箱', '现居住省', '城市',
  '班主任', '招生负责老师', '升学导师',
  'GPA成绩', '出勤率', '作业完成率', '意向专业', '目标国家', '预计毕业日期',
];

/** 有值占位符：让「不给看明细」与「能统计缺失率」同时成立 */
const PLACEHOLDER = '●';

function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/** 人员字段的取值可能是字符串 open_id、数组、或 [{ id, text }]，统一取出 id 列表 */
function personIds(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((x) => personIds(x));
  if (typeof v === 'object') {
    const o = v as { id?: string; open_id?: string; text?: string };
    const id = o.id ?? o.open_id ?? '';
    return id ? [String(id)] : [];
  }
  return [String(v)];
}

/** 人员字段显示名：能解析到姓名就显示姓名，否则原样回退（不隐藏、不报错） */
function personLabel(v: unknown, names?: Map<string, string>): string {
  const ids = personIds(v);
  if (ids.length === 0) return '';
  return ids.map((id) => names?.get(id) ?? id).join('、');
}

/** 只保留报表所需字段；非维度字段一律降级为「有无」占位符，避免泄露学生明细 */
function project(fields: Record<string, unknown>, names?: Map<string, string>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const k of DIMENSION_FIELDS) {
    row[k] = PERSON_FIELDS.has(k) ? personLabel(fields[k], names) : (fields[k] ?? '');
  }
  for (const k of COMPLETENESS_FIELDS) {
    if (DIMENSION_FIELDS.includes(k)) continue;
    row[k] = hasValue(fields[k]) ? PLACEHOLDER : '';
  }
  return row;
}

/**
 * 时间字段 → 毫秒。
 *
 * ⚠️ 同一个字段在不同表里读出来的形态不一样：
 *  - 自建 SQL 表（无字段元数据）：原样返回毫秒数字
 *  - 飞书 Base 表（字段类型=日期）：读取侧会格式化成 "2026-09-11 12:00" 字符串
 * 直接 Number() 的话后者得到 NaN，时间范围过滤会把记录全筛掉（2026-09-11 踩过：
 * 转换记录 6 条全被漏掉，统计恒为 0）。
 */
function toEpochMs(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000;
  }
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? 0 : t;
}

let nameCache: { at: number; map: Map<string, string> } | null = null;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly loginLog: LoginLogService,
    /**
     * 学生档案「行级数据范围」（2026-09-16 加）。
     * 成绩类报表**含学生姓名与分数明细**（GPA 排名榜尤其明显），
     * 不套范围就等于把全校成绩单开给了每个班主任 —— 与列表页同一口径，必须过滤。
     */
    @Inject(StudentScopeService) private readonly scope: StudentScopeService,
  ) {}

  /**
   * open_id → 姓名映射（5 分钟内存缓存）。
   * 学生档案里「班主任 / 招生负责老师 / 升学导师」存的是 open_id，
   * 报表要显示姓名；直接展示 open_id 没人看得懂，展示失败又不能整个报表报错。
   */
  private async personNameMap(): Promise<Map<string, string>> {
    if (nameCache && Date.now() - nameCache.at < 5 * 60 * 1000) return nameCache.map;
    const map = new Map<string, string>();
    try {
      let token: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await this.base.search(USER_TABLE.tableId, {
          pageSize: 200,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const f = ((r as { fields?: Record<string, unknown> }).fields ?? r) as Record<string, unknown>;
          const openId = String(f['飞书 Open ID'] ?? '');
          const name = String(f['姓名'] ?? '');
          if (openId && name) map.set(openId, name);
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
      this.logger.log(`人员 open_id→姓名 映射已建立：${map.size} 条`);
    } catch (e) {
      // 解析失败就退回显示原值，但必须留下日志 —— 静默失败会让 open_id 直接显示给用户
      this.logger.warn(`人员姓名映射建立失败（报表将显示 open_id）：${(e as Error).message.slice(0, 160)}`);
    }
    nameCache = { at: Date.now(), map };
    return map;
  }

  /**
   * 报表专用学生数据（权限点 `report:read`，与 `student:read` 解耦）。
   * 只返回维度字段真值 + 完整度占位符，不含姓名/联系方式等明细。
   */
  async studentRows(user: SessionUser, pageSize = 200) {
    requireReport(user, ['overview', 'gradeFlow', 'trend', 'completeness']);
    const names = await this.personNameMap();
    const out: Record<string, unknown>[] = [];
    let token: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = await this.base.search(TABLES.studentProfile.tableId, {
        pageSize,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items) out.push(project((r.fields ?? {}) as Record<string, unknown>, names));
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return { items: out, total: out.length };
  }
  /**
   * 联系人去重（权限点 `report:read`）。
   *
   * 判据、分级与反证据规则见 `contact-dedup.ts` 顶部说明。这里只负责「拉全量 + 缓存」：
   *  - 联系人表是卫瓴的全量只读副本（当前 3.6k 条），拉一次做内存分组即可，
   *    **不新增表、不写任何数据** —— 合并动作在卫瓴侧做，本报表只出清单；
   *  - 缓存的是**原始行**（5 分钟），统计口径与筛选都交给纯函数重算 ——
   *    缓存「已筛选结果」会在切换条件时串味。
   */
  private dedupRowsCache: { at: number; rows: DedupRow[] } | null = null;

  private async dedupRows(force = false): Promise<DedupRow[]> {
    const cached = this.dedupRowsCache;
    if (!force && cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.rows;
    const rows: DedupRow[] = [];
    let token: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await this.base.search(TABLES.weilingContact.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items) {
        const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        rows.push(toDedupRow(String(rec.recordId ?? rec.id ?? ''), rec.fields ?? {}));
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    this.dedupRowsCache = { at: Date.now(), rows };
    return rows;
  }

  async contactDedup(
    user: SessionUser,
    query: { level?: string; channel?: string; owner?: string; refresh?: string } = {},
  ): Promise<DedupResult> {
    requireReport(user, ['dedup']);
    const rows = await this.dedupRows(query.refresh === '1');
    const level = query.level === 'strong' || query.level === 'all' ? query.level : 'likely';
    const result = buildDedupGroups(rows, { level, channel: query.channel, owner: query.owner });
    if (query.refresh === '1') {
      this.logger.log(
        `[联系人去重] 重算完成：${result.stats.groups} 组 / ${result.stats.records} 条` +
          `（强 ${result.stats.byLevel.strong} · 较可信 ${result.stats.byLevel.likely} · 仅同名 ${result.stats.byLevel.weak}）`,
      );
    }
    return result;
  }

  /**
   * 活跃时段统计（权限点 `report:read`）。
   *
   * 口径（页面会写明，避免被误读成「在线时长」）：
   *  - **登录** = 登录日志表（每次成功登录一条，SessionService.create 时写入）
   *  - **操作** = 审计日志表的写操作（创建/更新/删除，不含查看）
   * 系统里没有访问日志，也没有在线时长记录，所以这只反映「什么时候登录过、什么时候动过数据」。
   */
  async activity(user: SessionUser, query: { from?: string; to?: string } = {}) {
    requireReport(user, ['activity']);

    const dayMs = 86_400_000;
    const startOf = (d: string): number | null => {
      const t = new Date(`${d}T00:00:00`).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const endOf = (d: string): number | null => {
      const t = new Date(`${d}T23:59:59.999`).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const dayKey = (t: number): string => {
      const d = new Date(t);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    // 默认最近 30 天
    const now = Date.now();
    const fromMs = (query.from ? startOf(query.from) : null) ?? now - 29 * dayMs;
    const toMs = (query.to ? endOf(query.to) : null) ?? now;

    // 1) 登录记录
    const logins = await this.loginLog.list(fromMs, toMs);

    // 2) 审计（写操作）
    const actions: { at: number; actor: string; module: string; action: string }[] = [];
    try {
      let token: string | undefined;
      for (let i = 0; i < 20; i += 1) {
        const page = await this.base.search(TABLES.auditLog.tableId, {
          pageSize: 500,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const f = (r as unknown as { fields?: Record<string, unknown> }).fields ?? {};
          const at = Number(f['操作时间'] ?? 0);
          if (at >= fromMs && at <= toMs) {
            actions.push({
              at,
              actor: String(f['操作人'] ?? ''),
              module: String(f['业务模块'] ?? ''),
              action: String(f['操作类型'] ?? ''),
            });
          }
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch {
      /* 审计表不可读时只统计登录 */
    }

    interface Agg {
      name: string;
      logins: number;
      actions: number;
      days: Set<string>;
      hours: number[];
      firstAt: number;
      lastAt: number;
    }
    const empty = (): Agg => ({
      name: '',
      logins: 0,
      actions: 0,
      days: new Set<string>(),
      hours: new Array(24).fill(0),
      firstAt: 0,
      lastAt: 0,
    });
    const users = new Map<string, Agg>();
    const touch = (name: string): Agg => {
      let a = users.get(name);
      if (!a) {
        a = empty();
        a.name = name;
        users.set(name, a);
      }
      return a;
    };
    const byHour = new Array(24).fill(0);
    const byDayMap = new Map<string, { date: string; logins: number; actions: number }>();
    const moduleMap = new Map<string, number>();
    const allDays = new Set<string>();

    const bump = (name: string, at: number, kind: 'login' | 'action') => {
      const a = touch(name);
      const h = new Date(at).getHours();
      a.hours[h] = (a.hours[h] ?? 0) + 1;
      byHour[h] = (byHour[h] ?? 0) + 1;
      const dk = dayKey(at);
      a.days.add(dk);
      allDays.add(dk);
      if (!a.firstAt || at < a.firstAt) a.firstAt = at;
      if (at > a.lastAt) a.lastAt = at;
      const day = byDayMap.get(dk) ?? { date: dk, logins: 0, actions: 0 };
      if (kind === 'login') {
        a.logins += 1;
        day.logins += 1;
      } else {
        a.actions += 1;
        day.actions += 1;
      }
      byDayMap.set(dk, day);
    };

    for (const l of logins) if (l.姓名) bump(l.姓名, l.登录时间, 'login');
    for (const a of actions) {
      if (a.actor) bump(a.actor, a.at, 'action');
      if (a.module) moduleMap.set(a.module, (moduleMap.get(a.module) ?? 0) + 1);
    }

    const byUser = [...users.values()]
      .map((a) => ({
        name: a.name,
        logins: a.logins,
        actions: a.actions,
        activeDays: a.days.size,
        firstAt: a.firstAt || null,
        lastAt: a.lastAt || null,
        hours: a.hours,
        peakHour: a.hours.indexOf(Math.max(...a.hours)),
      }))
      .sort((x, y) => y.logins + y.actions - (x.logins + x.actions));

    const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const modules = [...moduleMap.entries()]
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      from: dayKey(fromMs),
      to: dayKey(toMs),
      summary: {
        activeUsers: byUser.length,
        logins: logins.length,
        actions: actions.length,
        activeDays: allDays.size,
        peakHour: byHour.indexOf(Math.max(...byHour)),
      },
      byHour,
      byUser,
      byDay,
      modules,
    };
  }
  /**
   * 笔记统计（权限点 `report:read`）。
   *
   * 数据来源：
   *  - **新增笔记** = 笔记快照表（管理员视角聚合时顺带落库，含上游的笔记创建时间）
   *  - **转换次数** = 笔记转换记录表（谁把笔记转成了业务记录、转到了哪个模块）
   *
   * ⚠️ 快照只在管理员浏览笔记页时更新（复用已拉到的快照，不额外消耗上游 QPS 2 额度），
   * 所以「新增笔记」的覆盖度取决于管理员最近是否打开过笔记页。
   *
   * 🔴 **分组键一律用 ID，名字只用于显示**（2026-09-17 修）：
   * 快照表里存的是**写入当时**的归属人名与配置名，配置一改名，同一个配置就会以
   * 两个名字各占一行（实测 Amy「Amy Liu Get Note」73 +「AMY Liu Get Seed」2）；
   * 归属人同样会出现「孙旭峰」「孙旭峰｜Richard」「Richard」三种写法。
   * 所以「按人」按 `归属人ID` 归并、「按来源」按 `来源配置ID` 归并，
   * 名字用**当前**的名字解析（用户表 / 配置表），老行没有 ID 时按名字兜底。
   */
  async notes(user: SessionUser, query: { from?: string; to?: string } = {}) {
    requireReport(user, ['notes']);

    const startOf = (d: string): number | null => {
      const t = new Date(`${d}T00:00:00`).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const endOf = (d: string): number | null => {
      const t = new Date(`${d}T23:59:59.999`).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const dayKey = (t: number): string => {
      const d = new Date(t);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const now = Date.now();
    const fromMs = (query.from ? startOf(query.from) : null) ?? now - 29 * 86_400_000;
    const toMs = (query.to ? endOf(query.to) : null) ?? now;

    // ⚠️ 不同数据源返回结构不一致：SqlStore 给 **{ recordId, fields }**（id 叫 recordId，
    // 不叫 id！），有的路径直接给扁平对象。
    // 两种都兼容，取错会静默变成「取不到字段」这类最难查的问题。
    const rowsOf = (r: unknown): Record<string, unknown> =>
      (((r as { fields?: Record<string, unknown> }).fields ?? r) ?? {}) as Record<string, unknown>;

    // 1) 笔记快照
    const snapshots: {
      createdAt: number;
      owner: string;
      ownerId: string;
      source: string;
      sourceId: string;
      title: string;
      tags: string[];
      tagTypes: string[];
    }[] = [];
    let syncedAt: number | null = null;
    try {
      let token: string | undefined;
      for (let i = 0; i < 20; i += 1) {
        const page = await this.base.search(TABLES.noteSnapshot.tableId, {
          pageSize: 500,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const f = rowsOf(r);
          const created = toEpochMs(f['笔记创建时间']);
          const synced = toEpochMs(f['同步时间']);
          if (synced && (!syncedAt || synced > syncedAt)) syncedAt = synced;
          if (created >= fromMs && created <= toMs) {
            snapshots.push({
              createdAt: created,
              owner: String(f['归属人'] ?? ''),
              ownerId: String(f['归属人ID'] ?? ''),
              source: String(f['来源配置'] ?? ''),
              sourceId: String(f['来源配置ID'] ?? ''),
              title: String(f['标题'] ?? ''),
              // 标签与类型是两个**平行数组**（逗号分隔、下标对齐），见 GetnoteService.persistNoteSnapshot
              tags: String(f['标签'] ?? '').split(',').map((x) => x.trim()).filter(Boolean),
              tagTypes: String(f['标签类型'] ?? '').split(',').map((x) => x.trim()),
            });
          }
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch {
      /* 快照表不可读时只统计转换 */
    }

    // 2) 转换记录（按创建时间落在区间内）
    const converts: { module: string; at: number; by: string }[] = [];
    try {
      // 转换记录是 ACMS 自建/本地表，优先直连 PG（避免飞书路由不通导致静默空结果）
      const store = (getSqlStore() ?? this.base) as Pick<BaseClient, 'search'>;
      let token: string | undefined;
      for (let i = 0; i < 20; i += 1) {
        const page = await store.search(TABLES.noteConvertLog.tableId, {
          pageSize: 500,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const f = rowsOf(r);
          // ⚠️ 转换记录的时间字段叫「转换时间」（毫秒），不是审计的「创建时间」——
          // 取错字段会让转换次数恒为 0（2026-09-11 踩过）。
          const at =
            toEpochMs(f['转换时间']) ||
            toEpochMs(f['创建时间']) ||
            toEpochMs(f['created_at']);
          if (at >= fromMs && at <= toMs) {
            converts.push({
              module: String(f['目标模块'] ?? f['模块KEY'] ?? ''),
              by: String(f['转换人'] ?? ''),
              at,
            });
          }
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch (e) {
      this.logger?.warn(`笔记转换记录读取失败（转换统计会为空）：${(e as Error).message.slice(0, 160)}`);
    }

    // ── 名称真源：把「写入当时的名字」换成「当前的名字」 ───────────────────
    // 配置表：来源配置ID → 当前配置名称；同时按名称反查 ID（给没有 ID 的老行兜底）
    const configNameById = new Map<string, string>();
    const configIdByName = new Map<string, string>();
    try {
      const page = await this.base.search(TABLES.getnoteSource.tableId, { pageSize: 500 });
      for (const r of page.items ?? []) {
        const rr = r as unknown as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        const f = ((rr.fields ?? r) ?? {}) as Record<string, unknown>;
        const id = String(rr.recordId ?? rr.id ?? '');
        const name = String(f['配置名称'] ?? '').trim();
        if (id && name) configNameById.set(id, name);
        if (id && name) configIdByName.set(name, id);
      }
    } catch {
      /* 配置表读不到时退化为按名字分组 */
    }

    // 用户表：openId → 姓名；并把「丁懿｜Kevin」拆成全角/半角分隔的**别名**一起登记 ——
    // 归属人字段历史上出现过「孙旭峰」「孙旭峰｜Richard」「Richard」三种写法，都是同一个人。
    const userNameById = new Map<string, string>();
    const userIdByName = new Map<string, string>();
    try {
      const page = await this.base.search(USER_TABLE.tableId, { pageSize: 500 });
      for (const r of page.items ?? []) {
        const rr = r as unknown as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        const f = ((rr.fields ?? r) ?? {}) as Record<string, unknown>;
        const openId = String(f['飞书 Open ID'] ?? '').trim();
        const name = String(f['姓名'] ?? '').trim();
        if (!openId || !name) continue;
        userNameById.set(openId, name);
        for (const alias of [name, ...name.split(/[｜|]/)]) {
          const k = alias.trim();
          if (k) userIdByName.set(k, openId);
        }
      }
    } catch {
      /* 用户表读不到时按名字分组 */
    }

    /** 归属人归并键：优先 ID，其次用别名反查出来的 ID，最后才用名字本身 */
    const ownerKey = (s: { ownerId: string; owner: string }): string =>
      s.ownerId || userIdByName.get(s.owner.trim()) || s.owner.trim() || '未归属';
    const ownerLabel = (key: string): string => userNameById.get(key) || key;

    /** 来源归并键：同上（配置名历史上也改过多次） */
    const sourceKey = (s: { sourceId: string; source: string }): string =>
      s.sourceId || configIdByName.get(s.source.trim()) || s.source.trim() || '';
    const sourceLabel = (key: string): string =>
      key ? configNameById.get(key) || key : '未标注';

    // 聚合
    const byOwnerMap = new Map<string, { owner: string; newNotes: number }>();
    const bySourceMap = new Map<string, { source: string; count: number }>();
    /**
     * 按标签：一条笔记有多个标签就**分别计入每个标签** ⇒ 各标签之和 > 笔记总数（不是错误）。
     * `type` 一并回传，前端默认隐藏 system 标签（如「录音卡笔记」实测每篇都有，没有区分度）
     * 与来源标签（它们已由「来源」维度统计）。
     */
    const byTagMap = new Map<string, { tag: string; type: string; count: number; owners: Set<string> }>();
    const sourceTagSet = new Set<string>(NOTE_SOURCE_TYPES);
    const byDayMap = new Map<string, { date: string; newNotes: number; converts: number }>();
    const byModuleMap = new Map<string, { module: string; count: number }>();
    const byConverterMap = new Map<string, { converter: string; count: number }>();

    for (const s of snapshots) {
      const ok = ownerKey(s);
      const o = byOwnerMap.get(ok) ?? { owner: ownerLabel(ok), newNotes: 0 };
      o.newNotes += 1;
      byOwnerMap.set(ok, o);

      const sk = sourceKey(s);
      const sc = bySourceMap.get(sk) ?? { source: sourceLabel(sk), count: 0 };
      sc.count += 1;
      bySourceMap.set(sk, sc);

      for (let i = 0; i < s.tags.length; i += 1) {
        const tag = s.tags[i]!;
        const type = s.tagTypes[i] ?? '';
        // 来源标签归「来源」维度统计，这里不再重复计（否则「得到大脑」会和来源列撞车）
        if (sourceTagSet.has(tag)) continue;
        const e = byTagMap.get(tag) ?? { tag, type, count: 0, owners: new Set<string>() };
        e.count += 1;
        if (ok) e.owners.add(ownerLabel(ok));
        byTagMap.set(tag, e);
      }

      const dk = dayKey(s.createdAt);
      const d = byDayMap.get(dk) ?? { date: dk, newNotes: 0, converts: 0 };
      d.newNotes += 1;
      byDayMap.set(dk, d);
    }
    for (const c of converts) {
      const who = c.by || '未标注';
      const bc = byConverterMap.get(who) ?? { converter: who, count: 0 };
      bc.count += 1;
      byConverterMap.set(who, bc);

      const m = c.module || '未标注';
      const mc = byModuleMap.get(m) ?? { module: m, count: 0 };
      mc.count += 1;
      byModuleMap.set(m, mc);

      const dk = dayKey(c.at);
      const d = byDayMap.get(dk) ?? { date: dk, newNotes: 0, converts: 0 };
      d.converts += 1;
      byDayMap.set(dk, d);
    }

    return {
      from: dayKey(fromMs),
      to: dayKey(toMs),
      /** 快照最后同步时间（null 表示还没落过库） */
      syncedAt,
      summary: {
        newNotes: snapshots.length,
        converts: converts.length,
        owners: byOwnerMap.size,
      },
      byOwner: [...byOwnerMap.values()].sort((a, b) => b.newNotes - a.newNotes),
      bySource: [...bySourceMap.values()].sort((a, b) => b.count - a.count),
      byTag: [...byTagMap.values()]
        .map((e) => ({ tag: e.tag, type: e.type, count: e.count, owners: [...e.owners] }))
        .sort((a, b) => b.count - a.count),
      byModule: [...byModuleMap.values()].sort((a, b) => b.count - a.count),
      byConverter: [...byConverterMap.values()].sort((a, b) => b.count - a.count),
      byDay: [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  // ── 考勤出勤率（口径见 attendance-rate.ts 顶部说明）──────────────────────

  /**
   * 学生 / 班级 / 考勤码索引（5 分钟缓存）。
   *
   * 这三张都是配置型数据（学生档案 82 条、班级 6 条、考勤码十几条），
   * 每次进报表都全量拉一遍纯属浪费；但它们与「考勤记录」不同 ——
   * 考勤记录会因审核而立刻变化，**不能缓存**（否则刚审完页面数字不动）。
   */
  private attIndexCache: {
    at: number;
    students: Map<string, StudentInfo>;
    classNames: Map<string, string>;
    codes: RateCode[];
    classes: string[];
    grades: string[];
  } | null = null;

  private async attendanceIndex() {
    const cached = this.attIndexCache;
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;

    // 1) 班级表：考勤记录的「班级」是关联字段，存的是 record id，要解析成班级名
    const classNames = new Map<string, string>();
    try {
      let token: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await this.base.search(TABLES.classLink.tableId, {
          pageSize: 500,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
          const name = textOf((rec.fields ?? {})['班级名称']);
          const id = String(rec.recordId ?? rec.id ?? '');
          if (id && name) classNames.set(id, name);
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch (e) {
      this.logger.warn(`班级表读取失败（班级维度会缺名）：${(e as Error).message.slice(0, 160)}`);
    }

    // 2) 学生档案：「当前年级」是唯一有值的分组维度（「当前班级」生产全为 null）
    const students = new Map<string, StudentInfo>();
    const grades = new Set<string>();
    try {
      let token: string | undefined;
      for (let i = 0; i < 20; i += 1) {
        const page = await this.base.search(TABLES.studentProfile.tableId, {
          pageSize: 500,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
          const f = (rec.fields ?? {}) as Record<string, unknown>;
          const id = String(rec.recordId ?? rec.id ?? '');
          if (!id) continue;
          // ⚠️ 必须走 textOf：关联字段在 jsonb 里是对象，String() 会得到 "[object Object]"
          const grade = textOf(f['当前年级']);
          const clsId = linkIds(f['当前班级'])[0] ?? '';
          students.set(id, {
            id,
            name: textOf(f['学生姓名']),
            grade,
            cls: clsId ? classNames.get(clsId) ?? '' : '',
          });
          if (grade) grades.add(grade);
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch (e) {
      this.logger.warn(`学生档案读取失败（年级维度会缺名）：${(e as Error).message.slice(0, 160)}`);
    }

    // 3) 考勤码表：出勤率口径的配置真源（空表时由 buildCodeTable 回落到内置默认码）
    let codeRows: Record<string, unknown>[] = [];
    try {
      let token: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await this.base.search(TABLES.attendanceCode.tableId, {
          pageSize: 500,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const rec = r as { fields?: Record<string, unknown> };
          codeRows.push((rec.fields ?? {}) as Record<string, unknown>);
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch (e) {
      // 码表读不到时不报错：按内置默认口径出报表（总比整页 500 好）
      this.logger.warn(`考勤码表读取失败（按内置默认码口径出报表）：${(e as Error).message.slice(0, 160)}`);
      codeRows = [];
    }
    const codes = buildCodeTable(codeRows);
    if (!codeRows.length) {
      this.logger.log('[考勤分析] 考勤码表为空/未配置，出勤率按内置默认码口径计算');
    }

    const idx = {
      at: Date.now(),
      students,
      classNames,
      codes,
      classes: [...new Set(classNames.values())].sort(),
      grades: [...grades].sort(),
    };
    this.attIndexCache = idx;
    return idx;
  }

  /** 拉全部考勤记录（不缓存：审核完必须立刻反映到报表） */
  private async attendanceRows(): Promise<{ rows: AttendanceInputRow[]; truncated: boolean }> {
    const rows: AttendanceInputRow[] = [];
    const MAX_PAGES = 60; // 500 × 60 = 3 万条上限，超出只统计前 3 万并标记 truncated
    let truncated = false;
    let token: string | undefined;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page = await this.base.search(TABLES.attendance.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items ?? []) {
        const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        rows.push({
          id: String(rec.recordId ?? rec.id ?? ''),
          fields: (rec.fields ?? {}) as Record<string, unknown>,
        });
      }
      if (!page.hasMore || !page.pageToken) return { rows, truncated };
      token = page.pageToken;
      if (i === MAX_PAGES - 1) truncated = true;
    }
    if (truncated) this.logger.warn(`考勤记录超过 ${MAX_PAGES * 500} 条，报表只统计了前 ${rows.length} 条`);
    return { rows, truncated };
  }

  /**
   * 考勤出勤率报表（权限点 `report:read`）。
   *
   * 只返回聚合结果，不含学生明细（与 students 报表一致的脱敏取向）。
   * 口径：见 `attendance-rate.ts` 顶部 —— 特别是「只统计已通过终态」这一条。
   */
  // ────────────────────────────────────────────────────────────
  // 成绩类报表（考试与成绩 Phase 2，2026-09-16）
  // ────────────────────────────────────────────────────────────

  /**
   * 批次下拉（最新在前）。
   * 不是「已发布」优先 —— 期末总评在草稿批次里也能看，报表只是呈现快照。
   */
  private async examBatchOptions(): Promise<
    { id: string; name: string; status: string; year: string; term: string }[]
  > {
    const out: { id: string; name: string; status: string; year: string; term: string; at: number }[] = [];
    let tok: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = await this.base.search(TABLES.gradeBatch.tableId, {
        pageSize: 200,
        ...(tok ? { pageToken: tok } : {}),
      });
      for (const r of page.items) {
        const f = r.fields as Record<string, unknown>;
        const id = String((r as { recordId?: string }).recordId ?? (r as { id?: string }).id ?? '');
        out.push({
          id,
          name: textOf(f['批次名称']),
          status: textOf(f['状态']),
          year: textOf(f['学年']),
          term: textOf(f['学期']),
          at: Number(f['创建时间']) || 0,
        });
      }
      if (!page.hasMore || !page.pageToken) break;
      tok = page.pageToken;
    }
    // 有创建时间的按时间倒序；没有的（老数据）按名字倒序兜底
    out.sort((a, b) => (b.at || 0) - (a.at || 0) || b.name.localeCompare(a.name, 'zh-CN'));
    return out.map(({ at: _at, ...rest }) => rest);
  }

  /** 期末总评全表（分页拉完）—— 学生×批次×科目 量级，单校内存里聚合完全够 */
  private async examTermRows(): Promise<(TermGradeLike & { batchId: string })[]> {
    const out: (TermGradeLike & { batchId: string })[] = [];
    const num = (v: unknown): number | null => {
      if (v === '' || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    let tok: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await this.base.search(TABLES.termGrade.tableId, {
        pageSize: 500,
        ...(tok ? { pageToken: tok } : {}),
      });
      for (const r of page.items) {
        const f = r.fields as Record<string, unknown>;
        out.push({
          batchId: String(linkIds(f['批次'])[0] ?? ''),
          studentId: String(linkIds(f['学生'])[0] ?? ''),
          studentName: textOf(f['学生姓名']),
          cls: textOf(f['班级']),
          subject: textOf(f['科目']),
          total: num(f['总评']),
          level: textOf(f['等级']),
          levelOrder: num(f['等级序号']),
          attained: textOf(f['是否达标']),
          weightedGpa: num(f['加权GPA']),
          unweightedGpa: num(f['不加权GPA']),
          count: num(f['参与项数']) ?? 0,
        });
      }
      if (!page.hasMore || !page.pageToken) break;
      tok = page.pageToken;
    }
    return out;
  }

  /**
   * 按当前用户的学生数据范围过滤总评行。
   * 返回 `keys === null` 表示不受限（组织级豁免），页面的「口径说明」要如实写出来。
   */
  private async scopeExamRows(
    user: SessionUser,
    rows: (TermGradeLike & { batchId: string })[],
  ): Promise<{ rows: (TermGradeLike & { batchId: string })[]; keys: string[] | null }> {
    const scope = await this.scope.resolve(user);
    const keys = await this.scope.visibleKeys(scope, 'id');
    if (!keys) return { rows, keys: null };
    const set = new Set(keys);
    return { rows: rows.filter((r) => set.has(r.studentId)), keys };
  }

  /**
   * 报表：考试成绩分布。
   *
   * 数据源 = **期末总评快照**（不是成绩册的原始条目）—— 报表要跟成绩单对得上，
   * 而成绩单读的就是这份快照。
   */
  async examDistribution(
    user: SessionUser,
    opts: { batchId?: string; cls?: string; subject?: string } = {},
  ) {
    requireReport(user, ['examDist']);
    const batches = await this.examBatchOptions();
    const batchId = String(opts.batchId ?? '') || batches[0]?.id || '';
    if (!batchId) {
      return { batches: [], batchId: '', batchName: '', classes: [], subjects: [], reason: '还没有任何成绩批次' };
    }
    const all = await this.examTermRows();
    const { rows: scoped, keys } = await this.scopeExamRows(
      user,
      all.filter((r) => r.batchId === batchId),
    );

    const classes = [...new Set(scoped.map((r) => r.cls).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );
    const subjects = [...new Set(scoped.map((r) => r.subject).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );

    const filtered = scoped.filter(
      (r) => (!opts.cls || r.cls === opts.cls) && (!opts.subject || r.subject === opts.subject),
    );
    const totals = filtered.map((r) => r.total).filter((t): t is number => t != null);

    const levelMap = new Map<string, number>();
    for (const r of filtered) if (r.level) levelMap.set(r.level, (levelMap.get(r.level) ?? 0) + 1);

    const bySubject = subjects.map((sub) => {
      const rs = filtered.filter((r) => r.subject === sub);
      const ts = rs.map((r) => r.total).filter((t): t is number => t != null);
      const ok = rs.filter((r) => r.attained === '达标').length;
      return {
        subject: sub,
        count: rs.length,
        avg: mean(ts),
        attainedRate: rs.length ? Math.round((ok / rs.length) * 1000) / 10 : null,
      };
    });

    const sorted = filtered
      .filter((r) => r.total != null)
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    const brief = (r: TermGradeLike) => ({
      studentId: r.studentId,
      studentName: r.studentName,
      cls: r.cls,
      subject: r.subject,
      total: r.total,
      level: r.level,
    });

    return {
      batches,
      batchId,
      batchName: batches.find((b) => b.id === batchId)?.name ?? '',
      classes,
      subjects,
      /** 数据范围口径（页面「口径说明」直接展示，别让用户猜为什么人数比预期少） */
      scopeNote: keys
        ? `仅统计你可见的 ${keys.length} 名学生`
        : '不限制（组织级：系统管理员 / 院级管理看到全部）',
      summary: {
        students: new Set(filtered.map((r) => r.studentId)).size,
        records: filtered.length,
        avg: mean(totals),
        median: quantile(totals, 0.5),
        max: totals.length ? Math.max(...totals) : null,
        min: totals.length ? Math.min(...totals) : null,
        passRate: totals.length
          ? Math.round((totals.filter((t) => t >= 60).length / totals.length) * 1000) / 10
          : null,
        attainedRate: filtered.length
          ? Math.round((filtered.filter((r) => r.attained === '达标').length / filtered.length) * 1000) / 10
          : null,
      },
      bands: computeBands(totals),
      byLevel: [...levelMap.entries()]
        .map(([level, count]) => ({ level, count }))
        .sort((a, b) => b.count - a.count),
      bySubject,
      top: sorted.slice(0, 10).map(brief),
      bottom: sorted.slice(-10).reverse().map(brief),
    };
  }

  /**
   * 报表：GPA 与班级排名。
   *
   * 一个学生一个批次下有多条总评（每个科目一条），**先按学生聚合再排名** ——
   * 否则同一个学生会占据前 4 名，看起来像 bug。
   * 班级排名 = 同班内按加权 GPA 的竞赛排名（同 GPA 同名次、下一名跳号）。
   */
  async examGpaRank(user: SessionUser, opts: { batchId?: string; cls?: string } = {}) {
    requireReport(user, ['examGpa']);
    const batches = await this.examBatchOptions();
    const batchId = String(opts.batchId ?? '') || batches[0]?.id || '';
    if (!batchId) {
      return { batches: [], batchId: '', batchName: '', classes: [], gpaConfigured: false, rows: [], reason: '还没有任何成绩批次' };
    }
    const all = await this.examTermRows();
    const { rows: scoped, keys } = await this.scopeExamRows(
      user,
      all.filter((r) => r.batchId === batchId),
    );
    const classes = [...new Set(scoped.map((r) => r.cls).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );
    const filtered = scoped.filter((r) => !opts.cls || r.cls === opts.cls);

    const students = aggregateByStudent(filtered);
    const ranks = competitionRanks(students, (s) => s.weightedGpa);

    // 班级内排名
    const byCls = new Map<string, typeof students>();
    for (const st of students) {
      const arr = byCls.get(st.cls);
      if (arr) arr.push(st);
      else byCls.set(st.cls, [st]);
    }
    const clsRank = new Map<string, number | null>();
    const clsTotal = new Map<string, number>();
    for (const [c, list] of byCls) {
      const rr = competitionRanks(list, (s) => s.weightedGpa);
      list.forEach((st, i) => clsRank.set(st.studentId, rr[i] ?? null));
      clsTotal.set(c, list.length);
    }

    const gpas = students.map((s) => s.weightedGpa).filter((g): g is number => g != null);
    const rows = students
      .map((st, i) => ({
        ...st,
        rank: ranks[i] ?? null,
        clsRank: clsRank.get(st.studentId) ?? null,
        clsTotal: clsTotal.get(st.cls) ?? 0,
      }))
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.studentName.localeCompare(b.studentName, 'zh-CN'));

    return {
      batches,
      batchId,
      batchName: batches.find((b) => b.id === batchId)?.name ?? '',
      classes,
      /** 等级表一个绩点都没配时为 false —— 页面要明说「未配置绩点」，不显示 0.00 */
      gpaConfigured: gpas.length > 0,
      scopeNote: keys ? `仅统计你可见的 ${keys.length} 名学生` : '不限制（组织级）',
      summary: {
        students: students.length,
        avgGpa: gpas.length ? Math.round((gpas.reduce((a, b) => a + b, 0) / gpas.length) * 100) / 100 : null,
        fullMarks: students.filter((s) => s.attainedCount === s.subjectCount && s.subjectCount > 0).length,
      },
      distribution: gpaBands(gpas),
      rows,
    };
  }

  async attendanceReport(
    user: SessionUser,
    query: { from?: string; to?: string; class?: string; grade?: string } = {},
  ): Promise<AttendanceReport> {
    requireReport(user, ['attendance']);
    const idx = await this.attendanceIndex();
    const { rows, truncated } = await this.attendanceRows();

    const startOf = (d: string): number | undefined => {
      const t = new Date(`${d}T00:00:00`).getTime();
      return Number.isNaN(t) ? undefined : t;
    };
    const endOf = (d: string): number | undefined => {
      const t = new Date(`${d}T23:59:59.999`).getTime();
      return Number.isNaN(t) ? undefined : t;
    };

    const report = computeAttendanceReport({
      rows,
      students: idx.students,
      classNames: idx.classNames,
      codes: idx.codes,
      // 不传 from/to = 全量（前端面板自己给默认区间，接口保持「所见即所选」）
      ...(query.from ? { fromMs: startOf(query.from) } : {}),
      ...(query.to ? { toMs: endOf(query.to) } : {}),
      cls: query.class || undefined,
      grade: query.grade || undefined,
      truncated,
    });

    // 下拉可选项来自配置表（不是「当前结果里出现过的值」）—— 考勤记录 0 行时也要给出年级/班级，
    // 否则用户在新环境里连筛选都看不到。
    report.options = { classes: idx.classes, grades: idx.grades };
    return report;
  }
}
