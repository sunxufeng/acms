import { TokenManager, type FeishuConfig } from './token.js';

export interface BaseRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface FilterCondition {
  field: string;
  /** 默认 is */
  op?: string;
  value: string[];
}

export interface ListOptions {
  pageSize?: number;
  pageToken?: string;
  /** 服务端过滤（records/search filter） */
  filter?: { conjunction?: 'and' | 'or'; conditions: FilterCondition[] };
  sort?: { field: string; desc: boolean }[];
}

interface FeishuResp<T> {
  code: number;
  msg: string;
  data?: T;
}

/** 飞书 Base 记录读写客户端（search 为主读路径，写入走 create/update） */
export class BaseClient {
  private readonly tokens: TokenManager;

  constructor(
    private readonly cfg: FeishuConfig,
    private readonly appToken: string,
  ) {
    this.tokens = new TokenManager(cfg);
  }

  /** 缓存每张表的 datetime 字段名（type=5），用于字符串↔毫秒时间戳互转 */
  private readonly dtCache = new Map<string, Set<string>>();

  private async datetimeFields(tableId: string): Promise<Set<string>> {
    const cached = this.dtCache.get(tableId);
    if (cached) return cached;
    const fl = await this.listFields(tableId);
    const set = new Set(fl.filter((f) => f.type === 5).map((f) => f.name));
    this.dtCache.set(tableId, set);
    return set;
  }

  /** 写入前：datetime 字段的日期字符串("YYYY-MM-DD")转毫秒时间戳（飞书要求数值） */
  private async toWriteFields(
    tableId: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const dt = await this.datetimeFields(tableId);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (dt.has(k) && typeof v === 'string') {
        if (v.trim() === '') continue; // 空日期不写入，避免 DatetimeFieldConvFail
        const t = new Date(v.trim()).getTime();
        out[k] = Number.isNaN(t) ? v : t;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** 读取后：datetime 字段的毫秒时间戳转本地 "YYYY-MM-DD"（供 Web date 输入展示） */
  private fromReadFields(fields: Record<string, unknown>, dt: Set<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (dt.has(k) && typeof v === 'number' && !Number.isNaN(v)) {
        const d = new Date(v);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        out[k] = `${y}-${m}-${day}`;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokens.getToken();
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.cfg.baseUrl ?? 'https://open.feishu.cn'}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = (await res.json()) as FeishuResp<T>;
        if (json.code === 0 && json.data !== undefined) return json.data;
        // 429/限流退避重试
        if (json.code === 99991400 || res.status === 429) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        throw new Error(`feishu ${method} ${path} error ${json.code}: ${json.msg}`);
      } catch (e) {
        lastErr = e as Error;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    throw lastErr ?? new Error('feishu request failed');
  }

  private url(tableId: string, tail = ''): string {
    return `/open-apis/bitable/v1/apps/${this.appToken}/tables/${tableId}${tail}`;
  }

  /** 检索记录（服务端过滤） */
  async search(tableId: string, opts: ListOptions = {}): Promise<{
    items: BaseRecord[];
    total: number;
    hasMore: boolean;
    pageToken?: string;
  }> {
    const d = await this.req<{
      items?: { record_id: string; fields: Record<string, unknown> }[];
      total?: number;
      has_more?: boolean;
      page_token?: string;
    }>('POST', `${this.url(tableId)}/records/search?page_size=${opts.pageSize ?? 50}${opts.pageToken ? `&page_token=${opts.pageToken}` : ''}`, {
      field_names: [],
      filter: opts.filter
        ? {
            conjunction: opts.filter.conjunction ?? 'and',
            conditions: opts.filter.conditions.map((c) => ({
              field_name: c.field,
              operator: c.op ?? 'is',
              value: c.value,
            })),
          }
        : undefined,
      sort: opts.sort?.map((s) => ({ field_name: s.field, desc: s.desc })),
      automatic_fields: false,
    });
    const dt = await this.datetimeFields(tableId);
    return {
      items: (d.items ?? []).map((r) => ({
        recordId: r.record_id,
        fields: this.fromReadFields(r.fields, dt),
      })),
      total: d.total ?? 0,
      hasMore: d.has_more ?? false,
      pageToken: d.page_token,
    };
  }

  async get(tableId: string, recordId: string): Promise<BaseRecord | null> {
    try {
      const d = await this.req<{ record: { record_id: string; fields: Record<string, unknown> } }>(
        'GET',
        `${this.url(tableId)}/records/${recordId}`,
      );
      const dt = await this.datetimeFields(tableId);
      return { recordId: d.record.record_id, fields: this.fromReadFields(d.record.fields, dt) };
    } catch {
      return null;
    }
  }

  async create(tableId: string, fields: Record<string, unknown>): Promise<string> {
    const wf = await this.toWriteFields(tableId, fields);
    const d = await this.req<{ record: { record_id: string } }>(
      'POST',
      `${this.url(tableId)}/records`,
      { fields: wf },
    );
    return d.record.record_id;
  }

  /** 更新必须是 PUT（POST/PATCH 均为 404，坑已固化） */
  async update(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    const wf = await this.toWriteFields(tableId, fields);
    await this.req('PUT', `${this.url(tableId)}/records/${recordId}`, { fields: wf });
  }

  async delete(tableId: string, recordId: string): Promise<void> {
    await this.req('DELETE', `${this.url(tableId)}/records/${recordId}`);
  }

  /** 表结构（Schema Drift 检测用），含 property（单选/多选的 options 用于合并字典） */
  async listFields(
    tableId: string,
  ): Promise<{ id: string; name: string; type: number; property: { options?: { name: string; id?: string }[] } }[]> {
    const d = await this.req<{
      items?: { field_id: string; field_name: string; type: number; property?: { options?: { name: string; id?: string }[] } }[];
    }>('GET', `${this.url(tableId)}/fields?page_size=100`);
    return (d.items ?? []).map((f) => ({
      id: f.field_id,
      name: f.field_name,
      type: f.type,
      property: f.property ?? {},
    }));
  }

  /** 更新字段（合并单选/多选选项用）。飞书要求 PUT + 完整 property */
  async updateField(
    tableId: string,
    fieldId: string,
    body: { field_name: string; type: number; property: { options: { name: string }[] } },
  ): Promise<void> {
    await this.req('PUT', `${this.url(tableId)}/fields/${fieldId}`, body);
  }

  async listTables(): Promise<{ tableId: string; name: string }[]> {
    const d = await this.req<{ items?: { table_id: string; name: string }[] }>(
      'GET',
      `/open-apis/bitable/v1/apps/${this.appToken}/tables?page_size=100`,
    );
    return (d.items ?? []).map((t) => ({ tableId: t.table_id, name: t.name }));
  }

  /** 创建数据表（建表用，M2 教学域等）。fields 中 type: 1=文本, 3=单选, 4=多选 */
  async createTable(
    tableName: string,
    fields: { field_name: string; type: number; options?: string[] }[],
  ): Promise<{ tableId: string; name: string }> {
    const d = await this.req<{
      table_id: string;
      name?: string;
    }>('POST', `/open-apis/bitable/v1/apps/${this.appToken}/tables`, {
      table: {
        name: tableName,
        fields: fields.map((f) => ({
          field_name: f.field_name,
          type: f.type,
          ...(f.options
            ? { property: { options: f.options.map((o) => ({ name: o })) } }
            : {}),
        })),
      },
    });
    return { tableId: d.table_id, name: d.name ?? tableName };
  }
}
