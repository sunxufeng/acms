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

/** 嵌套过滤组（飞书 API 支持 conjunction + conditions 嵌套） */
export interface FilterGroup {
  conjunction: 'and' | 'or';
  conditions: (FilterCondition | FilterGroup)[];
}

export interface ListOptions {
  pageSize?: number;
  pageToken?: string;
  /** 服务端过滤（records/search filter，支持嵌套 OR/AND 组） */
  filter?: FilterGroup;
  sort?: { field: string; desc: boolean }[];
}

interface FeishuResp<T> {
  code: number;
  msg: string;
  data?: T;
}

/** 递归将 FilterGroup 展平为飞书 API 所需的 conditions 数组 */
function flattenFilter(conditions: (FilterCondition | FilterGroup)[]): Record<string, unknown>[] {
  return conditions.map((c) => {
    if ('conjunction' in c && !('field' in c)) {
      // 嵌套组：递归展平
      return {
        conjunction: c.conjunction,
        conditions: flattenFilter(c.conditions),
      };
    }
    // 叶子条件
    return {
      field_name: (c as FilterCondition).field,
      operator: (c as FilterCondition).op ?? 'is',
      value: (c as FilterCondition).value,
    };
  });
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

  /** 缓存每张表的 datetime 字段（type=5）：字段名 → 是否带时间（formatter 含 HH:mm）。
   *  用于字符串↔毫秒时间戳互转，以及读取时是否回带「时:分」。 */
  private readonly dtCache = new Map<string, Map<string, { hasTime: boolean }>>();

  private async datetimeFields(tableId: string): Promise<Map<string, { hasTime: boolean }>> {
    const cached = this.dtCache.get(tableId);
    if (cached) return cached;
    const fl = await this.listFields(tableId);
    const map = new Map<string, { hasTime: boolean }>();
    for (const f of fl) {
      if (f.type === 5) {
        const fmt = (f.property as { date_formatter?: string }).date_formatter ?? '';
        map.set(f.name, { hasTime: /H{1,2}/.test(fmt) });
      }
    }
    this.dtCache.set(tableId, map);
    return map;
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

  /** 读取后：datetime 字段的毫秒时间戳转本地 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"（带时间时） */
  private fromReadFields(fields: Record<string, unknown>, dt: Map<string, { hasTime: boolean }>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      const info = dt.get(k);
      if (info && typeof v === 'number' && !Number.isNaN(v)) {
        const d = new Date(v);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        if (info.hasTime) {
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          out[k] = `${y}-${m}-${day} ${hh}:${mm}`;
        } else {
          out[k] = `${y}-${m}-${day}`;
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** 原始请求：返回完整 FeishuResp（含 has_more / page_token，供分页用） */
  private async reqRaw<T>(method: string, path: string, body?: unknown): Promise<FeishuResp<T>> {
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
        if (json.code === 0 && json.data !== undefined) return json;
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

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.reqRaw<T>(method, path, body)).data as T;
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
    const payload = () => ({
      field_names: [],
      filter: opts.filter
        ? {
            conjunction: opts.filter.conjunction ?? 'and',
            conditions: flattenFilter(opts.filter.conditions),
          }
        : undefined,
      sort: opts.sort?.map((s) => ({ field_name: s.field, desc: s.desc })),
      automatic_fields: false,
    });
    const url = (tok?: string) =>
      `${this.url(tableId)}/records/search?page_size=${opts.pageSize ?? 50}${tok ? `&page_token=${tok}` : ''}`;
    let d: {
      items?: { record_id: string; fields: Record<string, unknown> }[];
      total?: number;
      has_more?: boolean;
      page_token?: string;
    };
    try {
      d = await this.req<typeof d>('POST', url(opts.pageToken), payload());
    } catch (e) {
      // 飞书按系统字段(创建时间/更新时间)排序会报 InvalidSort(1254016)，降级为不排序重试
      if (e instanceof Error && /1254016|InvalidSort/.test(e.message)) {
        const p = payload();
        delete (p as { sort?: unknown }).sort;
        d = await this.req<typeof d>('POST', url(opts.pageToken), p);
      } else {
        throw e;
      }
    }
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

  /** 表结构（Schema Drift 检测用），含 property（单选/多选的 options 用于合并字典）。
   *  注意：飞书 fields 列表接口分页（每页最多 100），必须翻页，否则表字段数 >100 时
   *  只能看到前 100 个字段，导致「已存在字段被误判为缺失 → FieldNameDuplicated」。 */
  async listFields(
    tableId: string,
  ): Promise<{ id: string; name: string; type: number; property: { options?: { name: string; id?: string }[]; date_formatter?: string } }[]> {
    const out: { id: string; name: string; type: number; property: { options?: { name: string; id?: string }[]; date_formatter?: string } }[] = [];
    let pageToken: string | undefined;
    do {
      const path = `${this.url(tableId)}/fields?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
      const resp = await this.reqRaw<{
        items?: { field_id: string; field_name: string; type: number; property?: { options?: { name: string; id?: string }[] } }[];
        has_more?: boolean;
        page_token?: string;
      }>('GET', path);
      const data = resp.data;
      if (!data) break;
      for (const f of data.items ?? []) {
        out.push({ id: f.field_id, name: f.field_name, type: f.type, property: f.property ?? {} });
      }
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  /** 更新字段（合并单选/多选选项、重命名、启用日期时间等用）。飞书要求 PUT + 完整 property */
  async updateField(
    tableId: string,
    fieldId: string,
    body: { field_name: string; type: number; property?: Record<string, unknown> },
  ): Promise<void> {
    await this.req('PUT', `${this.url(tableId)}/fields/${fieldId}`, body);
  }

  /** 新建字段（幂等迁移用）。type: 1=文本, 3=单选, 4=多选。已存在则跳过（由调用方先 listFields 判定） */
  async createField(
    tableId: string,
    body: { field_name: string; type: number; property?: { options?: { name: string }[] } },
  ): Promise<{ field_id: string; field_name: string; type: number }> {
    const d = await this.req<{
      field_id: string;
      field_name: string;
      type: number;
    }>('POST', `${this.url(tableId)}/fields`, body);
    return { field_id: d.field_id, field_name: d.field_name, type: d.type };
  }

  /** 删除字段（字段类型迁移用，例如 User(11)→Text(1)）。 */
  async deleteField(tableId: string, fieldId: string): Promise<void> {
    await this.req('DELETE', `${this.url(tableId)}/fields/${fieldId}`);
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
