import { Inject, Injectable, Logger } from '@nestjs/common';
import { TABLES, USER_TABLE, type SessionUser } from '@acms/contracts';
import type { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';
import { requireModule } from '../shared/require-module.js';
import { idsOf } from '../mail-archive/mail-archive.meta.js';

/**
 * 「我的跟进」= 以**当前登录人归属的联系人**为主体，汇总三类互动：
 *   ① 跟进记录（卫瓴跟进记录表，按 `关联联系人ID`）
 *   ② 招生跟进（生源跟进记录表，按关联字段 `关联联系人`）
 *   ③ 邮件（邮件归档，按关联字段 `关联联系人`）
 *
 * 为什么不复用通用 CRUD：这是一个**跨四张表的聚合视图**，不是某张表的列表 ——
 * 通用 CRUD 一次只能查一张表，而且两个关联字段用等值筛恒 0 条（要 `__has`，走内存）。
 * 所以这里自己聚合，也正好把「三类计数 + 最近互动」一次算完，前端一次请求就够。
 */

const CONTACT = TABLES.weilingContact.tableId;
const PROGRESS = TABLES.weilingProgress.tableId;
const SOURCE = TABLES.sourceFollowup.tableId;
const MAIL = TABLES.mailArchive.tableId;

/** 展开区里每类最多带几条明细（要看全部有「查看全部 →」） */
const DETAIL_PER_KIND = 3;
/** 三类关联索引的缓存时长：数据不常变，避免每次翻页/筛选都全表重扫 */
const INDEX_TTL_MS = 60_000;
/** 归属人候选的缓存时长（要扫全表联系人，更久一些） */
const OWNERS_TTL_MS = 10 * 60_000;
/** 一次拉取的分页大小（SqlStore 上限 500） */
const PAGE = 500;
/**
 * 单个用户最多处理多少联系人。
 *
 * 生产实测「归属人」这个字段在卫瓴侧是**批量线索池**（「致极学院-曹老师｜Dainel|1510」
 * 名下 1510 条），所以不能按"一个人几十条"来估上限；3000 的数组在内存里只有几 MB，
 * 且下面还会按「三类至少有一项」收窄。
 */
const MAX_CONTACTS = 3000;

type Row = Record<string, unknown>;

/**
 * 时间归一：**一律转毫秒时间戳**。
 *
 * 🔴 三类数据的时间形态各不相同，生产实测有四种：
 *    · 卫瓴跟进记录：毫秒时间戳（数字）
 *    · 招生跟进：ISO 字符串
 *    · 邮件归档：UTC ISO 串（`2026-09-07T08:43:18.000Z`）
 *    · 老数据：纯日期串
 * 直接 `Number()` 会得 NaN ⇒ 那条记录被当成"没有时间"排到最后（甚至整表被跳过）。
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

/** 编辑距离（英文名近似匹配用） */
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

/**
 * 英文名近似：首字母相同 + 编辑距离 ≤ 2。
 *
 * 🔴 生产实测卫瓴侧的英文名**有错拼**（我们系统是 `Daniel`，卫瓴那边写的是 `Dainel`），
 *    精确比较一个都匹配不上 —— 结果就是"归属人识别失败 → 拉全站联系人"。
 */
function enLike(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^a-z]/g, '');
  const y = b.toLowerCase().replace(/[^a-z]/g, '');
  if (!x || !y || x[0] !== y[0]) return false;
  if (Math.abs(x.length - y.length) > 2) return false;
  return levenshtein(x, y) <= 2;
}

/** 登录人姓名拆分：`曹德强｜Daniel` → { surname: '曹', en: ['Daniel'], parts: ['曹德强','Daniel'] } */
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

/**
 * 归属人候选拆分：`致极学院-曹老师｜Dainel|1510` → { surname: '曹', en: ['Dainel'], raw }
 *
 * 这个字段在卫瓴侧是**拼接出来的复合串**：机构前缀 + 称呼（`曹老师`）+ 英文名 + `|条数`，
 * 所以要先剥掉 `|计数`、`致极学院-` 前缀和 `老师` 称呼，才拿得到可用于比对的姓氏。
 */
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

function clip(s: unknown, max = 80): string {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

interface KindRow {
  id: string;
  at: number;
  /** 列表里显示的一行摘要 */
  summary: string;
  /** 次要信息（如跟进人 / 状态 / 方向） */
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
  private owners: { at: number; list: string[] } | null = null;

  /** 翻页拉全表（只用于建索引，调用方自己只读需要的字段） */
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
   * 建「联系人 id → 三类互动」索引（带 TTL 缓存）。
   *
   * 为什么全表扫：两个关联字段（`关联联系人`）在服务端**不能过滤**（等值/contains 都无效），
   * 只能把那一列拉回来在内存里归到具体联系人头上。三张表加起来约万行、只取少数字段，
   * 一次几秒；缓存 60 秒后翻页与筛选都是零成本。
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
      a.detail[kind].push(row);
    };

    const started = Date.now();
    const [progressRows, sourceRows, mailRows] = await Promise.all([
      this.fetchAll(PROGRESS),
      this.fetchAll(SOURCE),
      this.fetchAll(MAIL),
    ]);

    for (const r of progressRows) {
      const cid = String(r['关联联系人ID'] ?? '').trim();
      push(cid, 'progress', {
        id: String(r.id ?? ''),
        at: toEpochMs(r['跟进时间']),
        summary: clip(r['跟进内容']) || '（无内容）',
        meta: String(r['跟进人'] ?? '').trim(),
      });
    }
    // 招生跟进 / 邮件：`关联联系人` 是关联字段，原始值是 record id 数组（兼容 JSON 文本）
    for (const r of sourceRows) {
      const ids = idsOf(r['关联联系人']);
      const row: KindRow = {
        id: String(r.id ?? ''),
        at: toEpochMs(r['跟进时间']),
        summary: clip(r['沟通主题']) || '（无主题）',
        meta: [String(r['跟进状态'] ?? '').trim(), String(r['跟进负责人'] ?? '').trim()]
          .filter(Boolean)
          .join(' · '),
      };
      for (const cid of ids) push(cid, 'source', row);
    }
    for (const r of mailRows) {
      const ids = idsOf(r['关联联系人']);
      const row: KindRow = {
        id: String(r.id ?? ''),
        at: toEpochMs(r['发送时间']),
        summary: clip(r['主题']) || '（无主题）',
        meta: [String(r['邮件方向'] ?? '').trim(), String(r['发件人'] ?? '').trim()]
          .filter(Boolean)
          .join(' · '),
      };
      for (const cid of ids) push(cid, 'mail', row);
    }
    for (const a of map.values()) {
      for (const k of ['progress', 'source', 'mail'] as const) {
        a.detail[k].sort((x, y) => y.at - x.at);
        if (a.detail[k].length > DETAIL_PER_KIND) a.detail[k] = a.detail[k].slice(0, DETAIL_PER_KIND);
      }
    }
    this.index = { at: Date.now(), map };
    this.logger.log(
      `我的跟进索引已重建：跟进记录 ${progressRows.length} · 招生跟进 ${sourceRows.length} · 邮件 ${mailRows.length} · ` +
        `涉及联系人 ${map.size} 个（耗时 ${Date.now() - started}ms）`,
    );
    return map;
  }

  /**
   * 当前登录人 → 用户记录（拿姓名做归属人匹配）。
   * 带缓存：这需要全表拉用户表，而每次列表请求都要用到（翻页也会）。
   */
  private meCache: { at: number; byOpenId: Map<string, Row | null> } | null = null;

  private async currentUser(user: SessionUser): Promise<Row | null> {
    if (!user.openId) return null;
    if (!this.meCache || Date.now() - this.meCache.at > OWNERS_TTL_MS) {
      this.meCache = { at: Date.now(), byOpenId: new Map() };
    }
    const hit = this.meCache.byOpenId.get(user.openId);
    if (hit !== undefined) return hit;
    const rows = await this.fetchAll(USER_TABLE.tableId);
    const found = rows.find((r) => String(r['飞书 Open ID'] ?? '').trim() === user.openId) ?? null;
    this.meCache.byOpenId.set(user.openId, found);
    return found;
  }

  /** 联系人表里出现过的「归属人」候选（缓存 10 分钟） */
  async ownerOptions(user: SessionUser): Promise<string[]> {
    requireModule(user, 'weilingContacts', 'read');
    if (this.owners && Date.now() - this.owners.at < OWNERS_TTL_MS) return this.owners.list;
    const rows = await this.fetchAll(CONTACT);
    const set = new Set<string>();
    for (const r of rows) {
      const v = String(r['归属人'] ?? '').trim();
      if (v) set.add(v);
    }
    const list = [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    this.owners = { at: Date.now(), list };
    return list;
  }

  /**
   * 列表：我的联系人 + 三类互动。
   *
   * 🔴 「归属人是登录人」只能**按姓名**认：联系人的归属人存的是卫瓴那边的员工，
   *    而卫瓴 `owner_id` 与本系统用户之间**没有映射表**。所以：
   *      ① 取登录人姓名的主体（`曹德强｜Daniel` → `曹德强`）
   *      ② 与归属人候选做「相等 / 互为包含」匹配
   *      ③ 顶部把识别结果显示出来，并且**允许手动切换**（传 `owner` 参数）——
   *         识别不准时不至于功能不可用。
   */
  async list(user: SessionUser, query: Record<string, string | undefined>) {
    requireModule(user, 'weilingContacts', 'read');
    const owners = await this.ownerOptions(user);
    const me = await this.currentUser(user);
    const myName = String(me?.['姓名'] ?? '').trim();
    const mine = personTokens(myName);

    const asked = String(query.owner ?? '').trim();
    // 归属人识别：**不能按姓名精确匹配** —— 卫瓴侧的归属人是
    // 「致极学院-曹老师｜Dainel|1510」这种复合串（机构前缀 + 称呼 + 英文名 + `|计数»），
    // 与我们系统里的「曹德强｜Daniel」对不上，而且英文名还有错拼。
    // 所以打分匹配：姓相同 +2、英文名近似 +3、命中完整词 +4；阈值 3（单靠同姓不算）。
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
    const inferred = scored[0]?.o ?? '';
    const owner = asked || inferred;

    // 🔴 没识别出归属人时**直接返回空**，绝不能退化成「不加筛条件」——
    //    那会把全站几千个联系人当成"我的"（实测：两个不同的人看到同一份数据，
    //    而且都被 300 条上限截断），既误导又像越权。
    if (!owner) {
      return {
        owner: '',
        myName,
        ownerOptions: owners,
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

    // 我的联系人：服务端按「归属人」等值筛（普通文本字段，可以筛）
    const contacts: Row[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(CONTACT, {
        pageSize: PAGE,
        ...(token ? { pageToken: token } : {}),
        ...(owner ? { filter: buildFilter([{ field: '归属人', value: [owner] }]) } : {}),
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

    const enriched = contacts
      .slice(0, MAX_CONTACTS)
      .map((c) => {
        const id = String(c.id ?? '');
        const agg = aggMap.get(id) ?? this.emptyAgg();
        const kinds = (['progress', 'source', 'mail'] as const).flatMap((k) =>
          agg.detail[k].map((d) => ({ ...d, kind: k })),
        );
        const latest = kinds.sort((a, b) => b.at - a.at)[0];
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
    // 筛选项的候选：从「我的联系人」全量取（**不是**当前页），否则筛一次之后选项就只剩筛剩的值
    const distinct = (pick: (c: (typeof enriched)[number]) => string) =>
      [...new Set(enriched.map(pick).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    let items = enriched;
    if (scope !== 'all') items = items.filter((c) => c.hasAny);
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
    // 有互动的排前面，其次按最近互动时间倒序（没有互动的按联系人姓名）
    items.sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name, 'zh-CN'));

    const page = Math.max(Number(query.page ?? 1) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20) || 20, 1), 100);
    const total = items.length;
    const paged = items.slice((page - 1) * pageSize, page * pageSize);

    return {
      owner,
      /** 识别结果可核对：把登录人姓名与推断出的归属人一起回传 */
      myName,
      ownerOptions: owners,
      stats,
      stages: distinct((c) => c.stage),
      channels: distinct((c) => c.channel),
      items: paged,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      /** 联系人数被截断时提示（正常不会有） */
      truncated: contacts.length > MAX_CONTACTS,
    };
  }
}
