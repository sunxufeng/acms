import { Inject, Injectable, Logger } from '@nestjs/common';
import { TABLES, USER_TABLE, type SessionUser } from '@acms/contracts';
import type { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';
import { requireModule } from '../shared/require-module.js';
import { idsOf } from '../mail-archive/mail-archive.meta.js';

/**
 * 「我的跟进」= 以**归属人映射到当前登录人的联系人**为主体，汇总三类互动：
 *   ① 跟进记录（卫瓴跟进记录表，按 `关联联系人ID`）
 *   ② 招生跟进（生源跟进记录表，按关联字段 `关联联系人`）
 *   ③ 邮件（邮件归档，按关联字段 `关联联系人`）
 *
 * 为什么不用通用 CRUD：这是**跨四张表的聚合视图**，通用 CRUD 一次只能查一张表；
 * 而且两个关联字段用等值筛恒 0 条（要 `__has`，走内存）。这里自己聚合，
 * 顺带把「三类计数 + 最近互动 + 明细」一次算完，前端一次请求就够。
 *
 * ── 归属人怎么定（2026-09-24 改版，重点）──────────────────────────────
 * 优先读**归属人映射表**（`owner-mapping`，管理员在「招生管理 › 归属人映射」里配）：
 *   `ACMS用户`（record id）→ `卫瓴归属人`（联系人表里那个复合串）。
 * 映射缺失时**退回**按姓名打分匹配（姓 + 英文名近似）作兜底，并在响应里标注来源 ——
 * **猜出来的归属人可能让人看到别人的联系人**，所以必须可追溯、可纠正。
 * 两者都拿不到 ⇒ 返回空列表 + `ownerUnresolved`（绝不能退化成"不过滤"）。
 */

const CONTACT = TABLES.weilingContact.tableId;
const PROGRESS = TABLES.weilingProgress.tableId;
const SOURCE = TABLES.sourceFollowup.tableId;
const MAIL = TABLES.mailArchive.tableId;
const MAPPING = TABLES.ownerMapping.tableId;

/** 单类明细的硬上限（只防极端数据撑爆响应；正常联系人的明细远小于此） */
const DETAIL_CAP = 200;
/** 三类关联索引的缓存时长（全表扫约万行，不能每次翻页都重扫） */
const INDEX_TTL_MS = 60_000;
/**
 * 映射表 / 用户表的缓存时长。
 *
 * 🔴 只有 30 秒（2026-09-24 实测调过）：管理员在「归属人映射」里配好一条之后，
 *    「我的跟进」**必须很快跟上** —— 原来给 5 分钟，实测配完立刻刷新页面还是旧结果
 *    （`ownerSource` 仍显示按姓名推断、用户下拉仍是空），看起来像"配置没生效"。
 *    这两张表都很小（映射几十行、用户几百行），30 秒一次的读取成本可以忽略。
 */
const META_TTL_MS = 30_000;
/** 联系人表的归属人候选：3686 行的全表扫，只在兜底路径用到，给长一些 */
const OWNERS_TTL_MS = 5 * 60_000;
/** 一次拉取的分页大小（SqlStore 上限 500） */
const PAGE = 500;
/** 单个用户最多处理多少联系人（实测单个归属人名下 1510 条，是批量线索池） */
const MAX_CONTACTS = 3000;

type Row = Record<string, unknown>;

/**
 * 时间归一：**一律转毫秒时间戳**。三类数据的时间形态各不相同（毫秒戳 / ISO / UTC 串），
 * 直接 `Number()` 得 NaN ⇒ 那条记录被当成「没有时间」排到最后。
 */
function toEpochMs(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e12 ? v : v * 1000) : 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function clip(s: unknown, max = 90): string {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 编辑距离（英文名近似匹配的兜底用） */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** 英文名近似：首字母相同 + 编辑距离 ≤ 2（卫瓴侧有错拼：Daniel → Dainel） */
function enLike(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^a-z]/g, '');
  const y = b.toLowerCase().replace(/[^a-z]/g, '');
  if (!x || !y || x[0] !== y[0]) return false;
  if (Math.abs(x.length - y.length) > 2) return false;
  return levenshtein(x, y) <= 2;
}

/** 登录人姓名拆分：`曹德强｜Daniel` → { surname:'曹', en:['Daniel'], parts:[…] } */
function personTokens(full: string): { surname: string; en: string[]; parts: string[] } {
  const parts = String(full ?? '')
    .split(/[｜|]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const cn = parts.find((p) => /[\u4e00-\u9fa5]/.test(p)) ?? '';
  return {
    surname: cn.replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 1),
    en: parts.filter((p) => /^[A-Za-z][A-Za-z .'-]*$/.test(p)),
    parts,
  };
}

/** 归属人候选拆分：`致极学院-曹老师｜Dainel|1510` → { surname:'曹', en:['Dainel'] } */
function ownerTokens(v: string): { surname: string; en: string[]; raw: string } {
  const raw = String(v ?? '').trim();
  const body = raw.split('|').slice(0, -1).join('|') || raw;
  const segs = body
    .split(/[｜|]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const cn = segs.find((p) => /[\u4e00-\u9fa5]/.test(p)) ?? '';
  return {
    surname: cn
      .replace(/^致极学院-?/, '')
      .replace(/老师$/, '')
      .replace(/[^\u4e00-\u9fa5]/g, '')
      .slice(0, 1),
    en: segs.filter((p) => /^[A-Za-z][A-Za-z .'-]*$/.test(p)),
    raw,
  };
}

interface KindRow {
  id: string;
  at: number;
  summary: string;
  meta: string;
}
interface ContactAgg {
  counts: { progress: number; source: number; mail: number };
  detail: { progress: KindRow[]; source: KindRow[]; mail: KindRow[] };
}

@Injectable()
export class MyFollowupsService {
  private readonly logger = new Logger(MyFollowupsService.name);

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  private index: { at: number; map: Map<string, ContactAgg> } | null = null;
  private ownersCache: { at: number; list: string[] } | null = null;
  /** 用户 record id → 该用户映射到的「卫瓴归属人」值（可能多个） */
  private mappingCache: { at: number; byUser: Map<string, string[]> } | null = null;
  private usersCache: { at: number; list: Row[] } | null = null;

  /** 翻页拉全表（建索引 / 读映射、用户表用） */
  private async fetchAll(tableId: string): Promise<Row[]> {
    const out: Row[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(tableId, {
        pageSize: PAGE,
        ...(token ? { pageToken: token } : {}),
      });
      for (const it of res.items ?? []) {
        const rec = it as unknown as { recordId?: string; fields?: Row };
        out.push({ id: String(rec.recordId ?? ''), ...(rec.fields ?? {}) });
      }
      token = res.hasMore ? res.pageToken : undefined;
    } while (token && guard++ < 200);
    return out;
  }

  private emptyAgg(): ContactAgg {
    return {
      counts: { progress: 0, source: 0, mail: 0 },
      detail: { progress: [], source: [], mail: [] },
    };
  }

  /**
   * 建「联系人 id → 三类互动」索引（TTL 缓存）。
   * 两个关联字段在服务端不能过滤，只能把那一列拉回来在内存里归到联系人头上。
   */
  private async ensureIndex(): Promise<Map<string, ContactAgg>> {
    if (this.index && Date.now() - this.index.at < INDEX_TTL_MS) return this.index.map;
    const map = new Map<string, ContactAgg>();
    const aggOf = (cid: string): ContactAgg => {
      let a = map.get(cid);
      if (!a) {
        a = this.emptyAgg();
        map.set(cid, a);
      }
      return a;
    };
    const push = (cid: string, kind: 'progress' | 'source' | 'mail', row: KindRow) => {
      if (!cid) return;
      const a = aggOf(cid);
      a.counts[kind] += 1;
      if (a.detail[kind].length < DETAIL_CAP) a.detail[kind].push(row);
    };

    const started = Date.now();
    const [progressRows, sourceRows, mailRows] = await Promise.all([
      this.fetchAll(PROGRESS),
      this.fetchAll(SOURCE),
      this.fetchAll(MAIL),
    ]);

    for (const r of progressRows) {
      push(String(r['关联联系人ID'] ?? '').trim(), 'progress', {
        id: String(r.id ?? ''),
        at: toEpochMs(r['跟进时间']),
        summary: clip(r['跟进内容']) || '（无内容）',
        meta: String(r['跟进人'] ?? '').trim(),
      });
    }
    for (const r of sourceRows) {
      const row: KindRow = {
        id: String(r.id ?? ''),
        at: toEpochMs(r['跟进时间']),
        summary: clip(r['沟通主题']) || '（无主题）',
        meta: [String(r['跟进状态'] ?? '').trim(), String(r['跟进负责人'] ?? '').trim()]
          .filter(Boolean)
          .join(' · '),
      };
      for (const cid of idsOf(r['关联联系人'])) push(cid, 'source', row);
    }
    for (const r of mailRows) {
      const row: KindRow = {
        id: String(r.id ?? ''),
        at: toEpochMs(r['发送时间']),
        summary: clip(r['主题']) || '（无主题）',
        meta: [String(r['邮件方向'] ?? '').trim(), String(r['发件人'] ?? '').trim()]
          .filter(Boolean)
          .join(' · '),
      };
      for (const cid of idsOf(r['关联联系人'])) push(cid, 'mail', row);
    }
    for (const a of map.values()) {
      for (const k of ['progress', 'source', 'mail'] as const) a.detail[k].sort((x, y) => y.at - x.at);
    }
    this.index = { at: Date.now(), map };
    this.logger.log(
      `我的跟进索引已重建：跟进记录 ${progressRows.length} · 招生跟进 ${sourceRows.length} · 邮件 ${mailRows.length} · ` +
        `涉及联系人 ${map.size} 个（耗时 ${Date.now() - started}ms）`,
    );
    return map;
  }

  /** 用户表（缓存 5 分钟） */
  private async allUsers(): Promise<Row[]> {
    if (this.usersCache && Date.now() - this.usersCache.at < META_TTL_MS) return this.usersCache.list;
    const list = await this.fetchAll(USER_TABLE.tableId);
    this.usersCache = { at: Date.now(), list };
    return list;
  }

  /** 联系人表里出现过的「归属人」候选（缓存），供「归属人映射」页选择 */
  async ownerOptions(user: SessionUser): Promise<string[]> {
    requireModule(user, 'weilingContacts', 'read');
    if (this.ownersCache && Date.now() - this.ownersCache.at < OWNERS_TTL_MS) return this.ownersCache.list;
    const rows = await this.fetchAll(CONTACT);
    const set = new Set<string>();
    for (const r of rows) {
      const v = String(r['归属人'] ?? '').trim();
      if (v) set.add(v);
    }
    const list = [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    this.ownersCache = { at: Date.now(), list };
    return list;
  }

  /** 归属人映射（缓存）：用户 record id → 归属人值 */
  private async mappingIndex(): Promise<Map<string, string[]>> {
    if (this.mappingCache && Date.now() - this.mappingCache.at < META_TTL_MS) {
      return this.mappingCache.byUser;
    }
    const rows = await this.fetchAll(MAPPING);
    const byUser = new Map<string, string[]>();
    for (const r of rows) {
      const owner = String(r['卫瓴归属人'] ?? '').trim();
      if (!owner) continue;
      for (const uid of idsOf(r['ACMS用户'])) {
        const cur = byUser.get(uid) ?? [];
        if (!cur.includes(owner)) cur.push(owner);
        byUser.set(uid, cur);
      }
    }
    this.mappingCache = { at: Date.now(), byUser };
    return byUser;
  }

  /**
   * 有映射关系的用户列表 —— 「我的跟进」顶部的筛选就是它（需求：筛选用「用户」而不是「归属人」）。
   *
   * 只列**配过映射**的用户：没配的用户点开只会看到"未识别"，列出来是噪音；
   * 而配置入口就在旁边的「归属人映射」菜单。
   */
  async userOptions(user: SessionUser): Promise<{ id: string; name: string; owners: string[] }[]> {
    requireModule(user, 'weilingContacts', 'read');
    const [byUser, users] = await Promise.all([this.mappingIndex(), this.allUsers()]);
    const nameOf = new Map(users.map((u) => [String(u.id ?? ''), String(u['姓名'] ?? '')]));
    const out: { id: string; name: string; owners: string[] }[] = [];
    for (const [uid, owners] of byUser) {
      out.push({ id: uid, name: nameOf.get(uid) || uid, owners });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return out;
  }

  /** 当前登录人的用户记录（缓存 5 分钟） */
  private async currentUser(user: SessionUser): Promise<Row | null> {
    if (!user.openId) return null;
    const list = await this.allUsers();
    return list.find((r) => String(r['飞书 Open ID'] ?? '').trim() === user.openId) ?? null;
  }

  /** 按姓名打分猜一个归属人（**兜底**，映射缺失时才用） */
  private inferOwner(myName: string, owners: string[]): string {
    const mine = personTokens(myName);
    const scored = owners
      .map((o) => {
        const ot = ownerTokens(o);
        let score = 0;
        if (mine.surname && ot.surname && mine.surname === ot.surname) score += 2;
        if (mine.en.some((e) => ot.en.some((oe) => enLike(e, oe)))) score += 3;
        if (mine.parts.some((p) => p.length >= 3 && ot.raw.includes(p))) score += 4;
        return { o, score };
      })
      .filter((x) => x.score >= 3)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.o ?? '';
  }

  /**
   * 列表：某用户的联系人 + 三类互动。
   *
   * 归属人的确定顺序：
   *   ① `user` 参数指定的用户 → 映射表里的归属人（前端「用户」筛选走这条）
   *   ② 当前登录人 → 映射表里的归属人（**正常路径**）
   *   ③ 当前登录人 → 按姓名猜（兜底，响应里 `ownerSource: 'name'` 提示去配映射）
   *   ④ 都没有 ⇒ 空列表 + `ownerUnresolved`
   */
  async list(user: SessionUser, query: Record<string, string | undefined>) {
    requireModule(user, 'weilingContacts', 'read');
    const me = await this.currentUser(user);
    const myName = String(me?.['姓名'] ?? '').trim();
    const myId = String(me?.id ?? '');
    const [byUser, users] = await Promise.all([this.mappingIndex(), this.allUsers()]);
    const nameOf = new Map(users.map((u) => [String(u.id ?? ''), String(u['姓名'] ?? '')]));

    const targetId = String(query.user ?? '').trim() || myId;
    const targetName = nameOf.get(targetId) || (targetId === myId ? myName : targetId);

    let owner = '';
    let ownerSource: 'mapping' | 'name' | '' = '';
    const mapped = byUser.get(targetId) ?? [];
    if (mapped.length) {
      owner = mapped[0]!;
      ownerSource = 'mapping';
    } else if (targetId === myId && myName) {
      // 兜底：没配映射时按姓名猜（**只对自己猜**；看别人必须显式配映射，避免越权）
      const guessed = this.inferOwner(myName, await this.ownerOptions(user));
      if (guessed) {
        owner = guessed;
        ownerSource = 'name';
      }
    }

    const base = {
      user: targetId,
      userName: targetName,
      myName,
      myId,
      owner,
      ownerSource,
      users: await this.userOptions(user),
    };

    if (!owner) {
      // 🔴 认不出就返回空，绝不退化成"不加筛条件"（那会把全站联系人当成他的）
      return {
        ...base,
        ownerUnresolved: true,
        stats: { contacts: 0, withProgress: 0, withSource: 0, withMail: 0 },
        stages: [],
        channels: [],
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        hasMore: false,
        truncated: false,
      };
    }

    const aggMap = await this.ensureIndex();

    // 服务端按「归属人」等值筛（普通文本字段，可以筛）
    const contacts: Row[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(CONTACT, {
        pageSize: PAGE,
        ...(token ? { pageToken: token } : {}),
        filter: buildFilter([{ field: '归属人', value: [owner] }]),
      });
      for (const it of res.items ?? []) {
        const rec = it as unknown as { recordId?: string; fields?: Row };
        contacts.push({ id: String(rec.recordId ?? ''), ...(rec.fields ?? {}) });
      }
      token = res.hasMore ? res.pageToken : undefined;
    } while (token && guard++ < 20);

    const q = String(query.q ?? '').trim().toLowerCase();
    const stage = String(query.阶段 ?? query.stage ?? '').trim();
    const channel = String(query.来源渠道 ?? query.channel ?? '').trim();
    const scope = String(query.scope ?? 'active');
    /** 三个勾选框：勾上的**必须**有该类互动；全不勾 = 都可以 */
    const want = {
      progress: query.kindProgress === '1',
      source: query.kindSource === '1',
      mail: query.kindMail === '1',
    };
    const anyWant = want.progress || want.source || want.mail;

    const enriched = contacts.slice(0, MAX_CONTACTS).map((c) => {
      const id = String(c.id ?? '');
      const agg = aggMap.get(id) ?? this.emptyAgg();
      const kinds = (['progress', 'source', 'mail'] as const).flatMap((k) =>
        agg.detail[k].map((d) => ({ ...d, kind: k })),
      );
      const latest = [...kinds].sort((a, b) => b.at - a.at)[0];
      return {
        id,
        name: String(c['联系人姓名'] ?? '') || id,
        phone: String(c['手机号'] ?? ''),
        stage: String(c['客户阶段'] ?? ''),
        channel: String(c['来源渠道'] ?? ''),
        owner: String(c['归属人'] ?? ''),
        score: String(c['互动分'] ?? ''),
        followCount: String(c['跟进次数'] ?? ''),
        lastFollowAt: c['最近跟进时间'] ?? '',
        counts: agg.counts,
        hasAny: agg.counts.progress + agg.counts.source + agg.counts.mail > 0,
        lastAt: latest?.at ?? 0,
        lastKind: latest?.kind ?? '',
        lastSummary: latest?.summary ?? '',
        detail: agg.detail,
      };
    });

    const stats = {
      contacts: enriched.length,
      withProgress: enriched.filter((c) => c.counts.progress > 0).length,
      withSource: enriched.filter((c) => c.counts.source > 0).length,
      withMail: enriched.filter((c) => c.counts.mail > 0).length,
    };
    const distinct = (pick: (c: (typeof enriched)[number]) => string) =>
      [...new Set(enriched.map(pick).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    let items = enriched;
    if (scope !== 'all') items = items.filter((c) => c.hasAny);
    // 勾选框：勾了几类就要求**这几类都有**（AND，与"勾上才筛选出来"一致）
    if (anyWant) {
      items = items.filter(
        (c) =>
          (!want.progress || c.counts.progress > 0) &&
          (!want.source || c.counts.source > 0) &&
          (!want.mail || c.counts.mail > 0),
      );
    }
    if (q) {
      items = items.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.phone.includes(q) ||
          c.lastSummary.toLowerCase().includes(q),
      );
    }
    if (stage) items = items.filter((c) => c.stage === stage);
    if (channel) items = items.filter((c) => c.channel === channel);
    items.sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name, 'zh-CN'));

    const page = Math.max(Number(query.page ?? 1) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20) || 20, 1), 100);
    const total = items.length;

    return {
      ...base,
      ownerUnresolved: false,
      stats,
      stages: distinct((c) => c.stage),
      channels: distinct((c) => c.channel),
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      truncated: contacts.length > MAX_CONTACTS,
    };
  }
}
