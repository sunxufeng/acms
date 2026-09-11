import { Inject, Injectable, ForbiddenException, Logger } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES, USER_TABLE } from '@acms/contracts';
import { BASE_CLIENT, getSqlStore } from '../base.provider.js';
import { LoginLogService } from '../login-log/login-log.service.js';

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
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
    if (!authorize(toPrincipal(user), 'report:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:report:read');
    }
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
   * 活跃时段统计（权限点 `report:read`）。
   *
   * 口径（页面会写明，避免被误读成「在线时长」）：
   *  - **登录** = 登录日志表（每次成功登录一条，SessionService.create 时写入）
   *  - **操作** = 审计日志表的写操作（创建/更新/删除，不含查看）
   * 系统里没有访问日志，也没有在线时长记录，所以这只反映「什么时候登录过、什么时候动过数据」。
   */
  async activity(user: SessionUser, query: { from?: string; to?: string } = {}) {
    if (!authorize(toPrincipal(user), 'report:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:report:read');
    }

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
   */
  async notes(user: SessionUser, query: { from?: string; to?: string } = {}) {
    if (!authorize(toPrincipal(user), 'report:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:report:read');
    }

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

    // ⚠️ 不同数据源返回结构不一致：SqlStore 给 { id, fields }，有的路径直接给扁平对象。
    // 两种都兼容，取错会静默变成「取不到字段」这类最难查的问题。
    const rowsOf = (r: unknown): Record<string, unknown> =>
      (((r as { fields?: Record<string, unknown> }).fields ?? r) ?? {}) as Record<string, unknown>;

    // 1) 笔记快照
    const snapshots: { createdAt: number; owner: string; source: string; title: string }[] = [];
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
              owner: String(f['归属人'] ?? '未归属'),
              source: String(f['来源配置'] ?? ''),
              title: String(f['标题'] ?? ''),
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

    // 聚合
    const byOwnerMap = new Map<string, { owner: string; newNotes: number }>();
    const bySourceMap = new Map<string, { source: string; count: number }>();
    const byDayMap = new Map<string, { date: string; newNotes: number; converts: number }>();
    const byModuleMap = new Map<string, { module: string; count: number }>();
    const byConverterMap = new Map<string, { converter: string; count: number }>();

    for (const s of snapshots) {
      const o = byOwnerMap.get(s.owner) ?? { owner: s.owner, newNotes: 0 };
      o.newNotes += 1;
      byOwnerMap.set(s.owner, o);

      const src = s.source || '未标注';
      const sc = bySourceMap.get(src) ?? { source: src, count: 0 };
      sc.count += 1;
      bySourceMap.set(src, sc);

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
      byModule: [...byModuleMap.values()].sort((a, b) => b.count - a.count),
      byConverter: [...byConverterMap.values()].sort((a, b) => b.count - a.count),
      byDay: [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}
