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
    return {
      items: (d.items ?? []).map((r) => ({ recordId: r.record_id, fields: r.fields })),
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
      return { recordId: d.record.record_id, fields: d.record.fields };
    } catch {
      return null;
    }
  }

  async create(tableId: string, fields: Record<string, unknown>): Promise<string> {
    const d = await this.req<{ record: { record_id: string } }>(
      'POST',
      `${this.url(tableId)}/records`,
      { fields },
    );
    return d.record.record_id;
  }

  /** 更新必须是 PUT（POST/PATCH 均为 404，坑已固化） */
  async update(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.req('PUT', `${this.url(tableId)}/records/${recordId}`, { fields });
  }

  async delete(tableId: string, recordId: string): Promise<void> {
    await this.req('DELETE', `${this.url(tableId)}/records/${recordId}`);
  }

  /** 表结构（Schema Drift 检测用） */
  async listFields(tableId: string): Promise<{ id: string; name: string; type: number }[]> {
    const d = await this.req<{ items?: { field_id: string; field_name: string; type: number }[] }>(
      'GET',
      `${this.url(tableId)}/fields?page_size=100`,
    );
    return (d.items ?? []).map((f) => ({ id: f.field_id, name: f.field_name, type: f.type }));
  }

  /** 读取单个字段完整定义（含 property.options），用于合并字典选项 */
  async getField(
    tableId: string,
    fieldId: string,
  ): Promise<{ id: string; name: string; type: number; property: { options?: { name: string; id?: string }[] } }> {
    const d = await this.req<{
      field: { field_id: string; field_name: string; type: number; property?: { options?: { name: string; id?: string }[] } };
    }>('GET', `${this.url(tableId)}/fields/${fieldId}`);
    return {
      id: d.field.field_id,
      name: d.field.field_name,
      type: d.field.type,
      property: d.field.property ?? {},
    };
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
}
