import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { decryptSecret } from '../shared/secret-cipher.js';

/**
 * 卫瓴 SCRM 开放平台对接。
 * ──────────────────────────────────────────────────────────────
 * 官方接口（已实测连通）：
 *  - 鉴权   GET  /openapi/auth/access_token/get?app_id=&app_secret=
 *           ⚠️ 只能 GET；参数名是 app_id / app_secret（写成 appid 报 1001）
 *  - 联系人 GET  /openapi/contact/list?access_token=&start_day=YYYY-MM-DD&end_day=YYYY-MM-DD&cursor=
 *           start_day/end_day 必填且必须 YYYY-MM-DD（其它格式报 1013）；cursor 分页 100 条/页
 *  - 员工   GET  /openapi/user/get?access_token=&userid=
 *  - 字段   GET  /openapi/v2/custom/detail?api_key=contact&access_token=
 * 限流：单 API 500 次/分、10000 次/小时。
 *
 * 凭证不落在本模块：从「开放平台」表里读系统来源=卫瓴CRM 的那条（库中 AES 加密）。
 * 本模块全程只读 —— 不提供任何写卫瓴的接口（业务要求：只能看，不能改）。
 */

const HOST = 'https://openapi.weiling.cn';
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 官方未明确有效期，按 2 小时刷新
const FIELD_TTL_MS = 24 * 60 * 60 * 1000;
const STAFF_TTL_MS = 24 * 60 * 60 * 1000;

export interface WeilingFieldDesc {
  api_name: string;
  view_name: string;
  property_type?: number;
  options?: { label: string; value: string }[];
}

interface TokenCache {
  token: string;
  at: number;
}

@Injectable()
export class WeilingService implements OnModuleInit {
  private readonly logger = new Logger(WeilingService.name);
  private tokenCache: TokenCache | null = null;
  private fieldCache: { at: number; fields: WeilingFieldDesc[] } | null = null;
  private staffCache = new Map<string, { name: string; at: number }>();
  /** 同步中标记：避免手动与定时任务并发跑两轮 37 次请求 */
  private syncing = false;
  private lastSyncAt = 0;
  private lastSyncCount = 0;

  async onModuleInit() {
    // 启动后延迟 1 分钟做一次同步（让其它模块先就绪），之后每天一次
    setTimeout(() => void this.syncAll(false), 60_000).unref?.();
    setInterval(() => void this.syncAll(false), 24 * 60 * 60 * 1000).unref?.();
  }

  // ── 凭证 ────────────────────────────────────────────────────
  /** 从开放平台表取卫瓴凭证（库中 AES 加密，这里解密） */
  private async credentials(): Promise<{ appId: string; appSecret: string } | null> {
    const sql = getSqlStore();
    if (!sql) return null;
    let token: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await sql.search(TABLES.openPlatformApp.tableId, {
        pageSize: 100,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items ?? []) {
        const f = ((r as { fields?: Record<string, unknown> }).fields ?? r) as Record<string, unknown>;
        const src = String(f['系统来源'] ?? '');
        if (!src.includes('卫瓴')) continue;
        if (String(f['状态'] ?? '') === '停用') continue;
        const appId = String(f['App ID'] ?? '');
        const secret = decryptSecret(String(f['App Secret'] ?? ''));
        if (appId && secret) return { appId, appSecret: secret };
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return null;
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < TOKEN_TTL_MS) return this.tokenCache.token;
    const cred = await this.credentials();
    if (!cred) throw new Error('未配置卫瓴凭证：请在「后台管理 → 开放平台」配置系统来源为「卫瓴CRM」的应用');
    const url = `${HOST}/openapi/auth/access_token/get?app_id=${encodeURIComponent(cred.appId)}&app_secret=${encodeURIComponent(cred.appSecret)}`;
    const res = await fetch(url, { method: 'GET' });
    const json = (await res.json()) as { code?: number; msg?: string; data?: { access_token?: string } };
    if (json.code !== 0 || !json.data?.access_token) {
      throw new Error(`卫瓴鉴权失败：${json.code} ${json.msg ?? ''}`);
    }
    this.tokenCache = { token: json.data.access_token, at: Date.now() };
    return this.tokenCache.token;
  }

  private async api<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await this.getToken();
    const qs = new URLSearchParams({ access_token: token, ...params });
    const res = await fetch(`${HOST}${path}?${qs.toString()}`, { method: 'GET' });
    const json = (await res.json()) as { code?: number; msg?: string; data?: T };
    if (json.code !== 0) throw new Error(`卫瓴接口 ${path} 失败：${json.code} ${json.msg ?? ''}`);
    return (json.data ?? {}) as T;
  }

  // ── 字段描述（api_name → 中文名 + 枚举选项）────────────────────
  async fields(force = false): Promise<WeilingFieldDesc[]> {
    if (!force && this.fieldCache && Date.now() - this.fieldCache.at < FIELD_TTL_MS) {
      return this.fieldCache.fields;
    }
    const sql = getSqlStore();
    // 先读库里缓存（进程重启后不必每次都问上游）
    if (!force && sql) {
      try {
        const page = await sql.search(TABLES.weilingField.tableId, { pageSize: 500 });
        const rows = (page.items ?? []).map(
          (r) => (((r as { fields?: Record<string, unknown> }).fields ?? r) as Record<string, unknown>),
        );
        if (rows.length) {
          const fields = rows.map((f) => ({
            api_name: String(f['api_name'] ?? ''),
            view_name: String(f['view_name'] ?? ''),
            property_type: Number(f['property_type'] ?? 0),
            options: safeParseOptions(f['options']),
          }));
          this.fieldCache = { at: Date.now(), fields };
          return fields;
        }
      } catch {
        /* 读缓存失败就走上游 */
      }
    }
    const data = await this.api<{ fields?: WeilingFieldDesc[] }>('/openapi/v2/custom/detail', {
      api_key: 'contact',
    });
    const fields = data.fields ?? [];
    this.fieldCache = { at: Date.now(), fields };
    // 落库缓存（供下次启动与前端展示）
    if (sql) {
      try {
        for (const f of fields) {
          const payload = {
            api_name: f.api_name,
            view_name: f.view_name,
            property_type: Number(f.property_type ?? 0),
            options: JSON.stringify(f.options ?? []),
          };
          // 用 api_name 当主键。⚠️ 先 create 再 update（SqlStore.update 对不存在的
          // 记录不抛异常，反过来写会导致一条都存不进去）
          try {
            await sql.createWithId(TABLES.weilingField.tableId, f.api_name, payload);
          } catch {
            await sql.update(TABLES.weilingField.tableId, f.api_name, payload);
          }
        }
      } catch (e) {
        this.logger.warn(`卫瓴字段描述落库失败：${(e as Error).message.slice(0, 120)}`);
      }
    }
    return fields;
  }

  /** 员工姓名（带缓存；失败回退显示原 userid 的前 6 位） */
  private async staffName(userId: string): Promise<string> {
    if (!userId) return '';
    const hit = this.staffCache.get(userId);
    if (hit && Date.now() - hit.at < STAFF_TTL_MS) return hit.name;
    try {
      const data = await this.api<{ name?: string }>('/openapi/user/get', { userid: userId });
      const name = String(data.name ?? '');
      if (name) {
        this.staffCache.set(userId, { name, at: Date.now() });
        return name;
      }
    } catch {
      /* 忽略：拿不到就显示 ID */
    }
    return userId ? userId.slice(0, 8) : '';
  }

  // ── 同步 ────────────────────────────────────────────────────
  /**
   * 全量同步联系人。incremental=true 时只拉最近 30 天（日常增量），
   * 否则从 2020-01-01 拉全量（首次或手动触发）。
   */
  async syncAll(full = true): Promise<{ ok: boolean; count: number; message?: string }> {
    if (this.syncing) return { ok: false, count: 0, message: '同步正在进行中，请稍后再试' };
    this.syncing = true;
    const sql = getSqlStore();
    if (!sql) {
      this.syncing = false;
      return { ok: false, count: 0, message: '未配置数据库连接' };
    }
    try {
      const end = new Date();
      const start = new Date(full ? '2020-01-01' : Date.now() - 30 * 86_400_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      let cursor = '';
      let total = 0;
      const staffIds = new Set<string>();
      const rows: Record<string, unknown>[] = [];

      for (let page = 0; page < 200; page += 1) {
        const params: Record<string, string> = {
          start_day: fmt(start),
          end_day: fmt(end),
        };
        if (cursor) params.cursor = cursor;
        const data = await this.api<{ contact_list?: Record<string, unknown>[]; cursor?: string }>(
          '/openapi/contact/list',
          params,
        );
        const list = data.contact_list ?? [];
        for (const c of list) rows.push(c);
        total += list.length;
        cursor = String(data.cursor ?? '');
        if (!cursor || list.length === 0) break;
      }

      // 归属人姓名（逐个反查，带缓存；人数通常个位数到几十）
      for (const c of rows) {
        const oid = String(c['owner_id'] ?? '');
        if (oid) staffIds.add(oid);
      }
      const nameMap = new Map<string, string>();
      for (const id of staffIds) nameMap.set(id, await this.staffName(id));

      // 落库
      // ⚠️ 顺序必须是「先 create，冲突了再 update」：SqlStore.update 对不存在的
      // 记录不会抛异常（只是影响 0 行），如果反过来写，新建记录会被静默吞掉 ——
      // 表现就是「同步报告成功 N 条，库里却是空的」（2026-09-12 踩过）。
      let written = 0;
      for (const c of rows) {
        const id = String(c['contact_id'] ?? '');
        if (!id) continue;
        const f = this.flatten(c, nameMap);
        try {
          await sql.createWithId(TABLES.weilingContact.tableId, id, f);
        } catch {
          await sql.update(TABLES.weilingContact.tableId, id, f);
        }
        written += 1;
      }
      // 落库后回查真实条数：防止「调用都成功但没写进去」的静默失败被当成成功
      let inDb = written;
      try {
        const check = await sql.search(TABLES.weilingContact.tableId, { pageSize: 1 });
        inDb = Number(check.total ?? written) || written;
      } catch {
        /* 回查失败不影响返回 */
      }
      this.lastSyncAt = Date.now();
      this.lastSyncCount = inDb;
      // 同步完顺带重算与学生的匹配（内部自己吞异常，不影响同步结果）
      void this.matchStudents();
      this.logger.log(`卫瓴联系人同步完成：写入 ${written} 条，库内共 ${inDb} 条（拉取 ${total}）`);
      if (written > 0 && inDb === 0) {
        return { ok: false, count: 0, message: '写入调用全部返回成功，但库中查不到记录，请检查数据表' };
      }
      return { ok: true, count: inDb };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      this.logger.warn(`卫瓴联系人同步失败：${msg}`);
      return { ok: false, count: 0, message: msg };
    } finally {
      this.syncing = false;
    }
  }

  /** 把卫瓴原始记录摊平成中文键，供列表筛选与详情展示 */
  private flatten(c: Record<string, unknown>, nameMap: Map<string, string>): Record<string, unknown> {
    const ways = (c['contact_ways'] ?? []) as { type?: number; contact_way?: string }[];
    const mobiles: string[] = [];
    const emails: string[] = [];
    for (const w of ways) {
      const v = String(w?.contact_way ?? '');
      if (!v) continue;
      // type: 0/1 均可能是手机号（实测 0=1917、1=1662、101=107），按内容判断更稳
      if (/@/.test(v)) emails.push(v);
      else mobiles.push(v);
    }
    const custom = (c['contact_custom'] ?? {}) as Record<string, unknown>;
    const source = (c['contact_source'] ?? {}) as Record<string, unknown>;
    const ownerId = String(c['owner_id'] ?? '');
    const tags = ((c['tag_group_list'] ?? []) as { group_name?: string }[]).map((t) => String(t?.group_name ?? '')).filter(Boolean);
    return {
      联系人姓名: String(c['user_name'] ?? ''),
      手机号: mobiles.join('、'),
      邮箱: emails.join('、'),
      归属人: nameMap.get(ownerId) ?? ownerId,
      归属人ID: ownerId,
      客户阶段: String(c['customer_stage'] ?? ''),
      来源渠道: String(c['from_channel_name'] ?? ''),
      来源组件: String(source['component_name'] ?? ''),
      状态: String(c['status'] ?? ''),
      创建时间: Number(c['create_time'] ?? 0),
      领取时间: Number(c['claim_time'] ?? 0),
      最近跟进时间: Number(c['last_follow_time'] ?? 0),
      首次跟进时间: Number(c['first_progress_time'] ?? 0),
      互动分: Number(c['interactive_score'] ?? 0),
      企业名: String(c['corp_name'] ?? ''),
      备注: String(c['remark'] ?? ''),
      标签: tags.join('、'),
      落地页: String(c['url'] ?? ''),
      头像: String(c['avatar'] ?? ''),
      // 自定义字段（键为缩写，中文名由字段描述接口翻译）
      自定义字段: JSON.stringify(custom),
      其他信息: String(c['other_custom_field'] ?? ''),
      原始数据: JSON.stringify(c),
      同步时间: Date.now(),
    };
  }

  // ── 与 ACMS 学生档案的「疑似匹配」──────────────────────────────
  /**
   * 把卫瓴联系人与 ACMS 学生档案做**疑似**匹配，结果写回联系人表。
   *
   * 为什么是"疑似"：卫瓴里存的手机号大多是**家长**的，姓名也可能是
   * 「XX妈妈」这种昵称，任何单一条件都可能误配。所以：
   *  - 多条件各自给分，取最高可信的一条
   *  - 同时记录匹配置信度与匹配依据，页面上明确标注「疑似」，由人确认
   *
   * 置信度口径：
   *  - 98 学生姓名 + 手机/家长电话 双命中
   *  - 90 学生姓名精确相等（卫瓴自定义字段「学生姓名」）
   *  - 88 手机号 = 学生手机号；85 = 父亲/母亲电话
   *  - 70 联系人昵称去掉「妈妈/爸爸/家长」后缀 = 父亲/母亲姓名
   *  - 55 弱包含（昵称里出现学生姓名）
   */
  async matchStudents(): Promise<{ ok: boolean; matched: number; total: number; message?: string }> {
    const sql = getSqlStore();
    if (!sql) return { ok: false, matched: 0, total: 0, message: '未配置数据库连接' };
    try {
      const students = await this.fetchStudentIndex();
      if (!students.length) return { ok: false, matched: 0, total: 0, message: '未读到学生档案' };

      let total = 0;
      let matched = 0;
      let token: string | undefined;
      for (let page = 0; page < 60; page += 1) {
        const res = await sql.search(TABLES.weilingContact.tableId, {
          pageSize: 100,
          ...(token ? { pageToken: token } : {}),
        });
        if (page === 0) {
          const first = (res.items ?? [])[0] as Record<string, unknown> | undefined;
          this.logger.log(
            `匹配：首页 ${(res.items ?? []).length} 条，样本键=${first ? Object.keys(first).slice(0, 8).join(',') : '无'}`,
          );
        }
        for (const r of res.items ?? []) {
          const rec = r as { id?: string; recordId?: string; fields?: Record<string, unknown> };
          const f = ((rec.fields ?? r) ?? {}) as Record<string, unknown>;
          // id 可能挂在 record 上，也可能在扁平字段里（不同读取路径结构不一致，都兜住）
          const id = String(rec.id ?? rec.recordId ?? f['id'] ?? f['contact_id'] ?? '');
          total += 1;
          if (!id) continue;
          const hit = bestMatch(f, students);
          const patch: Record<string, unknown> = {
            关联学生: hit?.name ?? '',
            关联学生ID: hit?.id ?? '',
            匹配置信度: hit?.score ?? 0,
            匹配依据: hit?.reason ?? '',
            匹配时间: Date.now(),
          };
          if (hit) matched += 1;
          try {
            await sql.update(TABLES.weilingContact.tableId, id, patch);
          } catch (e) {
            this.logger.warn(`写入匹配结果失败 ${id}：${(e as Error).message.slice(0, 100)}`);
          }
        }
        if (!res.hasMore || !res.pageToken) break;
        token = res.pageToken;
      }
      this.logger.log(`卫瓴联系人匹配完成：${matched}/${total} 命中`);
      return { ok: true, matched, total };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      this.logger.warn(`卫瓴联系人匹配失败：${msg}`);
      return { ok: false, matched: 0, total: 0, message: msg };
    }
  }

  /** 拉学生档案用于匹配的字段（一次性建索引，学生数通常几十到几百） */
  private async fetchStudentIndex(): Promise<
    { id: string; name: string; enName: string; formerName: string; mobile: string; parentMobiles: string[]; parentNames: string[] }[]
  > {
    const sql = getSqlStore();
    const store = (sql ?? undefined) as { search?: (t: string, o: Record<string, unknown>) => Promise<{ items?: unknown[]; hasMore?: boolean; pageToken?: string }> } | undefined;
    const out: {
      id: string;
      name: string;
      enName: string;
      formerName: string;
      mobile: string;
      parentMobiles: string[];
      parentNames: string[];
    }[] = [];
    if (!store?.search) return out;
    let token: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = await store.search(TABLES.studentProfile.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items ?? []) {
        const rec = r as { id?: string; fields?: Record<string, unknown> };
        const f = ((rec.fields ?? r) ?? {}) as Record<string, unknown>;
        out.push({
          id: String(rec.id ?? ''),
          name: String(f['学生姓名'] ?? ''),
          enName: String(f['英文名'] ?? ''),
          formerName: String(f['曾用名'] ?? ''),
          mobile: digitsOnly(f['学生手机号']),
          parentMobiles: [digitsOnly(f['父亲电话']), digitsOnly(f['母亲电话'])].filter(Boolean),
          parentNames: [String(f['父亲姓名'] ?? ''), String(f['母亲姓名'] ?? '')].filter(Boolean),
        });
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return out;
  }

  syncStatus() {
    return { lastSyncAt: this.lastSyncAt, count: this.lastSyncCount, syncing: this.syncing };
  }
}

// ── 匹配辅助 ──────────────────────────────────────────────────
function digitsOnly(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** 取手机号后 11 位比较（兼容带区号/空格/86 前缀） */
function normPhone(v: unknown): string {
  const d = digitsOnly(v);
  if (!d) return '';
  return d.length > 11 ? d.slice(-11) : d;
}

type StudentIdx = {
  id: string;
  name: string;
  enName: string;
  formerName: string;
  mobile: string;
  parentMobiles: string[];
  parentNames: string[];
};

function bestMatch(
  contact: Record<string, unknown>,
  students: StudentIdx[],
): { id: string; name: string; score: number; reason: string } | null {
  // 卫瓴侧：学生姓名（自定义字段 xsxm）、昵称、手机号
  let customName = '';
  try {
    const cc = JSON.parse(String(contact['自定义字段'] ?? '{}')) as Record<string, unknown>;
    customName = String(cc['xsxm'] ?? '');
  } catch {
    customName = '';
  }
  const nick = String(contact['联系人姓名'] ?? '');
  const phones = String(contact['手机号'] ?? '')
    .split(/[、,，\s]/)
    .map(normPhone)
    .filter((p) => p.length >= 7);

  // 收集所有候选再取最高分（不用闭包累加变量：TS 会把闭包内赋值推断成 never）
  const hits: { id: string; name: string; score: number; reason: string }[] = [];
  const consider = (s: StudentIdx, score: number, reason: string) => {
    hits.push({ id: s.id, name: s.name, score, reason });
  };

  for (const s of students) {
    if (!s.name) continue;
    // 1) 姓名精确（卫瓴的「学生姓名」自定义字段）
    const nameHit = customName && (customName === s.name || customName === s.enName || customName === s.formerName);
    // 2) 手机号
    let phoneHit: 'self' | 'parent' | '' = '';
    for (const p of phones) {
      if (!p) continue;
      if (s.mobile && normPhone(s.mobile) === p) phoneHit = 'self';
      else if (s.parentMobiles.some((m) => normPhone(m) === p)) phoneHit = phoneHit === 'self' ? 'self' : 'parent';
    }
    // 3) 昵称 = 家长姓名（去掉「妈妈/爸爸/家长」等后缀）
    const nickBase = nick.replace(/(妈妈|爸爸|母亲|父亲|家长|女士|先生|Mrs|Mr)$/g, '').trim();
    const parentHit = nickBase.length >= 2 && s.parentNames.some((n) => n && n === nickBase);

    if (nameHit && phoneHit) {
      consider(s, phoneHit === 'self' ? 98 : 96, `学生姓名 + ${phoneHit === 'self' ? '学生手机' : '家长电话'}`);
    } else if (nameHit) {
      consider(s, 90, '学生姓名');
    } else if (phoneHit === 'self') {
      consider(s, 88, '学生手机号');
    } else if (phoneHit === 'parent') {
      consider(s, 85, '家长电话');
    } else if (parentHit) {
      consider(s, 70, '家长姓名');
    } else if (customName && nick.includes(customName) && customName.length >= 2) {
      consider(s, 55, '昵称包含学生姓名');
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  const top = hits[0];
  // 最低 55 分才算匹配，低于此不写入，避免噪音
  return top && top.score >= 55 ? top : null;
}

function safeParseOptions(v: unknown): { label: string; value: string }[] {
  if (Array.isArray(v)) return v as { label: string; value: string }[];
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}
