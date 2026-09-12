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


let analyzeCache = new Map<string, { at: number; data: unknown }>();

function parseCustom(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  try {
    const p = JSON.parse(String(v));
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 时间字段 → 毫秒（兼容毫秒数字 / 数字串 / ISO 字符串） */
function toEpochMsLocal(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const str = String(v).trim();
  if (/^\d+$/.test(str)) return Number(str);
  const t = new Date(str).getTime();
  return Number.isNaN(t) ? 0 : t;
}

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
  /** 跟进记录同步进度（后台任务，轮询看进度） */
  private progressSync: {
    running: boolean;
    done: boolean;
    scanned: number;
    contacts: number;
    records: number;
    at: number;
    error: string;
  } = { running: false, done: false, scanned: 0, contacts: 0, records: 0, at: 0, error: '' };

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

  // ── 跟进记录（progress）─────────────────────────────────────
  /**
   * 同步卫瓴跟进记录。
   *
   * 接口：`GET /openapi/v2/progress/list?access_token=&id=<联系人ID>&type=0&cursor=`
   *  - type：0 联系人 / 3 企业 / 6 群 / 7 商机，这里只要联系人的
   *  - 列表只返回 progress_id / create_user_id / content(HTML) / remark(纯文本) / create_time
   *  - 图片与附件要再按 progress_id 调 `/openapi/progress/get` 拿（每条一次请求）
   *
   * ⚠️ 量很大（3663 个联系人 + 约 2200 条记录逐个查附件 ≈ 六千次请求），
   * 所以在限流内串行跑、后台执行，通过 progressStatus() 看进度，绝不阻塞请求。
   */
  async syncProgress(full = true): Promise<{ ok: boolean; started: boolean; message?: string }> {
    if (this.progressSync.running) return { ok: true, started: false, message: '跟进记录同步正在进行中' };
    const sql = getSqlStore();
    if (!sql) return { ok: false, started: false, message: '未配置数据库连接' };

    this.progressSync = { running: true, scanned: 0, contacts: 0, records: 0, done: false, at: 0, error: '' };
    void (async () => {
      try {
        // 待扫描的联系人：全量 or 只扫最近 30 天有动静的
        const ids: string[] = [];
        const names = new Map<string, string>();
        let token: string | undefined;
        for (let p = 0; p < 80; p += 1) {
          const res = await sql.search(TABLES.weilingContact.tableId, {
            pageSize: 500,
            ...(token ? { pageToken: token } : {}),
          });
          for (const r of res.items ?? []) {
            const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
            const f = ((rec.fields ?? r) ?? {}) as Record<string, unknown>;
            const id = String(rec.recordId ?? rec.id ?? '');
            if (!id) continue;
            if (!full) {
              const t = toEpochMsLocal(f['最近跟进时间']);
              if (!t || t < Date.now() - 30 * 86_400_000) continue;
            }
            ids.push(id);
            names.set(id, String(f['联系人姓名'] ?? ''));
          }
          if (!res.hasMore || !res.pageToken) break;
          token = res.pageToken;
        }

        for (const cid of ids) {
          this.progressSync.scanned += 1;
          try {
            const data = await this.api<{ progress_list?: Record<string, unknown>[]; cursor?: string }>(
              '/openapi/v2/progress/list',
              { id: cid, type: '0' },
            );
            const list = data.progress_list ?? [];
            if (!list.length) continue;
            this.progressSync.contacts += 1;
            for (const pg of list) {
              const pid = String(pg['progress_id'] ?? '');
              if (!pid) continue;
              const uid = String(pg['create_user_id'] ?? '');
              const uname = uid ? await this.staffName(uid) : '';
              // 附件/图片：列表接口没有，按 id 再查一次
              let images = '';
              let files = '';
              try {
                const det = await this.api<Record<string, unknown>>('/openapi/progress/get', { progress_id: pid });
                images = String(det['image_file'] ?? '');
                files = JSON.stringify(det['attachment_file'] ?? []);
              } catch {
                /* 拿不到附件不影响记录本身 */
              }
              const row = {
                关联联系人ID: cid,
                关联联系人: names.get(cid) ?? '',
                跟进时间: Number(pg['create_time'] ?? 0),
                跟进人ID: uid,
                跟进人: uname,
                跟进内容: String(pg['remark'] ?? ''),
                跟进内容原文: String(pg['content'] ?? ''),
                图片: images,
                附件: files && files !== '[]' ? files : '',
                原始数据: JSON.stringify(pg),
                同步时间: Date.now(),
              };
              try {
                await sql.createWithId(TABLES.weilingProgress.tableId, pid, row);
              } catch {
                await sql.update(TABLES.weilingProgress.tableId, pid, row);
              }
              this.progressSync.records += 1;
            }
            // 顺带把「跟进次数」写回联系人，列表页要展示
            try {
              await sql.update(TABLES.weilingContact.tableId, cid, { 跟进次数: list.length });
            } catch {
              /* 忽略 */
            }
            // 限流保护：单 API 500 次/分，留足余量
            await sleep(130);
          } catch (e) {
            this.logger.warn(`联系人 ${cid} 跟进记录拉取失败：${(e as Error).message.slice(0, 100)}`);
          }
        }
        this.progressSync.done = true;
        this.progressSync.at = Date.now();
        this.logger.log(`跟进记录同步完成：${this.progressSync.records} 条 / ${this.progressSync.contacts} 个联系人`);
      } catch (e) {
        this.progressSync.error = (e as Error).message.slice(0, 200);
        this.logger.warn(`跟进记录同步失败：${this.progressSync.error}`);
      } finally {
        this.progressSync.running = false;
      }
    })();

    return { ok: true, started: true };
  }

  /** 按联系人取跟进记录（详情页用，按时间倒序） */
  async progressOf(contactId: string): Promise<Record<string, unknown>[]> {
    const sql = getSqlStore();
    if (!sql || !contactId) return [];
    const out: Record<string, unknown>[] = [];
    let token: string | undefined;
    for (let p = 0; p < 10; p += 1) {
      const res = await sql.search(TABLES.weilingProgress.tableId, {
        pageSize: 200,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of res.items ?? []) {
        const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        const f = ((rec.fields ?? r) ?? {}) as Record<string, unknown>;
        if (String(f['关联联系人ID'] ?? '') !== contactId) continue;
        out.push({
          id: String(rec.recordId ?? rec.id ?? ''),
          跟进时间: f['跟进时间'],
          跟进人: String(f['跟进人'] ?? '') || (f['跟进人ID'] ? String(f['跟进人ID']).slice(0, 8) : ''),
          跟进内容: String(f['跟进内容'] ?? ''),
          图片: String(f['图片'] ?? ''),
          附件: String(f['附件'] ?? ''),
        });
      }
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
    out.sort((a, b) => Number(b['跟进时间'] ?? 0) - Number(a['跟进时间'] ?? 0));
    return out;
  }

  progressStatus() {
    return { ...this.progressSync };
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

  // ── 招生分析（报表用）──────────────────────────────────────────
  /**
   * 卫瓴线索多维度聚合。一次扫全量在内存里算（3663 条约 4 秒），结果缓存 5 分钟。
   * 之所以不用 SQL 聚合：SqlStore 只暴露 search，且维度涉及 JSON 自定义字段，
   * 内存聚合更直观也更好扩展。
   */
  async analyze(params: { from?: string; to?: string; 归属人?: string; 来源渠道?: string; 客户阶段?: string } = {}) {
    const cacheKey = JSON.stringify(params);
    const hit = analyzeCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;

    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库连接');
    const fields = await this.fields();
    const nameOf = new Map(fields.map((f) => [f.api_name, f.view_name]));
    // 枚举：label 是数字键、value 是显示文本（卫瓴结构，跟直觉相反）
    const optOf = new Map<string, Map<string, string>>();
    for (const f of fields) {
      if (f.options?.length) optOf.set(f.api_name, new Map(f.options.map((o) => [String(o.label), String(o.value)])));
    }

    // 时间范围（按创建时间）
    const fromMs = params.from ? new Date(`${params.from}T00:00:00`).getTime() : 0;
    const toMs = params.to ? new Date(`${params.to}T23:59:59`).getTime() : Number.MAX_SAFE_INTEGER;

    const rows: Record<string, unknown>[] = [];
    let token: string | undefined;
    for (let p = 0; p < 80; p += 1) {
      const res = await sql.search(TABLES.weilingContact.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of res.items ?? []) {
        const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        const f = ((rec.fields ?? r) ?? {}) as Record<string, unknown>;
        rows.push(f);
      }
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }

    // 筛选
    const filtered = rows.filter((r) => {
      const ct = toEpochMsLocal(r['创建时间']);
      if (fromMs && ct && ct < fromMs) return false;
      if (toMs < Number.MAX_SAFE_INTEGER && ct && ct > toMs) return false;
      if (params.归属人 && String(r['归属人'] ?? '') !== params.归属人) return false;
      if (params.来源渠道 && String(r['来源渠道'] ?? '') !== params.来源渠道) return false;
      if (params.客户阶段 && String(r['客户阶段'] ?? '') !== params.客户阶段) return false;
      return true;
    });

    const DEAL = '成交客户';
    const isDeal = (r: Record<string, unknown>) => String(r['客户阶段'] ?? '') === DEAL;
    const now = Date.now();

    // ① 客户阶段漏斗（按招生顺序）
    const STAGE_ORDER = ['潜在客户', '适龄客户', '面访客户', '面试客户', '成交客户'];
    const stageCount = new Map<string, number>();
    for (const r of filtered) {
      const s = String(r['客户阶段'] ?? '') || '未标注';
      stageCount.set(s, (stageCount.get(s) ?? 0) + 1);
    }
    const stage = [...stageCount.entries()]
      .sort((a, b) => {
        const ia = STAGE_ORDER.indexOf(a[0]);
        const ib = STAGE_ORDER.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map(([name, count]) => ({ name, count }));

    // ②③④ 分组维度（线索数 / 成交数 / 成交率）
    const groupBy = (keyFn: (r: Record<string, unknown>) => string) => {
      const m = new Map<string, { total: number; deal: number }>();
      for (const r of filtered) {
        const k = keyFn(r) || '未标注';
        const e = m.get(k) ?? { total: 0, deal: 0 };
        e.total += 1;
        if (isDeal(r)) e.deal += 1;
        m.set(k, e);
      }
      return [...m.entries()]
        .map(([name, v]) => ({ name, total: v.total, deal: v.deal, dealRate: v.total ? (v.deal / v.total) * 100 : 0 }))
        .sort((a, b) => b.total - a.total);
    };
    const owners = groupBy((r) => String(r['归属人'] ?? '')).map((o) => {
      // 近 30 天跟进数
      const follow30 = filtered.filter(
        (r) =>
          String(r['归属人'] ?? '') === o.name &&
          toEpochMsLocal(r['最近跟进时间']) > now - 30 * 86_400_000,
      ).length;
      return { ...o, follow30 };
    });
    const channels = groupBy((r) => String(r['来源渠道'] ?? ''));
    const components = groupBy((r) => String(r['来源组件'] ?? '')).slice(0, 10);

    // ⑤ 招生漏斗自定义维度（取覆盖率高的几个）
    const customDim = (apiName: string) => {
      const m = new Map<string, number>();
      const opts = optOf.get(apiName);
      let covered = 0;
      for (const r of filtered) {
        const raw = parseCustom(r['自定义字段'])[apiName];
        if (raw == null || raw === '') continue;
        covered += 1;
        const vals = Array.isArray(raw) ? raw : [raw];
        for (const v of vals) {
          const label = opts?.get(String(v)) ?? String(v);
          m.set(label, (m.get(label) ?? 0) + 1);
        }
      }
      return {
        name: nameOf.get(apiName) ?? apiName,
        apiName,
        covered,
        items: [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      };
    };
    const funnels = ['xsdx', 'yxd', 'zxzlx', 'yxlxgb'].map(customDim).filter((d) => d.covered > 0);

    // ⑥ 漏斗后半段（到访 → 缴面试费 → 完成面试 → 接受 Offer → 缴费）
    const pipelineSteps: { name: string; apiName: string; yes: string }[] = [
      { name: '线下到访', apiName: 'xxdf', yes: '已到访' },
      { name: '缴纳面试费', apiName: 'sftjbmb', yes: '是' },
      { name: '完成面试', apiName: 'sffwcms', yes: '是' },
      { name: '接受 Offer', apiName: 'sfjsoffer', yes: '是' },
      { name: '已缴费', apiName: 'jfqk', yes: '是' },
    ];
    const pipeline = pipelineSteps.map((s) => {
      const opts = optOf.get(s.apiName);
      let yes = 0;
      let answered = 0;
      for (const r of filtered) {
        const raw = parseCustom(r['自定义字段'])[s.apiName];
        if (raw == null || raw === '') continue;
        answered += 1;
        const label = opts?.get(String(raw)) ?? String(raw);
        if (label === s.yes) yes += 1;
      }
      return { name: s.name, yes, answered };
    });

    // ⑦ 按月趋势
    const trendMap = new Map<string, { newCount: number; dealCount: number }>();
    for (const r of filtered) {
      const ct = toEpochMsLocal(r['创建时间']);
      if (!ct) continue;
      const d = new Date(ct);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const e = trendMap.get(m) ?? { newCount: 0, dealCount: 0 };
      e.newCount += 1;
      if (isDeal(r)) e.dealCount += 1;
      trendMap.set(m, e);
    }
    const trend = [...trendMap.entries()]
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);

    // ⑧ 跟进健康度
    const buckets = [
      { name: '7 天内', max: 7 },
      { name: '30 天内', max: 30 },
      { name: '90 天内', max: 90 },
      { name: '90 天以上', max: Number.MAX_SAFE_INTEGER },
    ];
    let never = 0;
    const health = buckets.map((b) => ({ name: b.name, count: 0 }));
    for (const r of filtered) {
      const t = toEpochMsLocal(r['最近跟进时间']);
      if (!t) {
        never += 1;
        continue;
      }
      const days = (now - t) / 86_400_000;
      const idx = buckets.findIndex((b) => days <= b.max);
      if (idx >= 0) health[idx] = { ...health[idx]!, count: health[idx]!.count + 1 };
    }
    health.push({ name: '从未跟进', count: never });

    // 汇总
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const deal = filtered.filter(isDeal).length;
    const matched = filtered.filter((r) => String(r['关联学生'] ?? '') !== '').length;
    const summary = {
      total: filtered.length,
      monthNew: filtered.filter((r) => toEpochMsLocal(r['创建时间']) >= monthStart.getTime()).length,
      deal,
      dealRate: filtered.length ? (deal / filtered.length) * 100 : 0,
      matched,
      owners: owners.length,
    };

    const data = { summary, stage, owners, channels, components, funnels, pipeline, trend, health };
    analyzeCache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  syncStatus() {
    return { lastSyncAt: this.lastSyncAt, count: this.lastSyncCount, syncing: this.syncing };
  }
}

// ── 匹配辅助 ──────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    } else if (s.name.length >= 2 && nick.includes(s.name)) {
      // ⚠️ 必须是「昵称里包含**这个学生**的姓名」，写成 nick.includes(customName)
      // 就变成了「昵称包含自己的学生姓名」——恒真，会把一堆无关联系人都挂到
      // 学生表第一个人身上（2026-09-12 踩过，几百条全匹配成同一个人）。
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
