import { Pool } from 'pg';
import type {
  BaseRecord,
  CreateFieldBody,
  CreateTableField,
  CreatedField,
  DataStore,
  FieldMeta,
  FilterCondition,
  FilterGroup,
  ListOptions,
  ListResult,
  TableRef,
  UpdateFieldBody,
} from '@acms/base-adapter';
import { dateFormatterHasTime, formatReadValue, newFieldId, newRecordId } from './field-type.js';

/** SQL 标识符白名单：表名只允许 t_<小写字母数字> */
const SAFE_TABLE = /^t_[a-z0-9]+$/;

/** 飞书 table_id → SQL 表名（小写化，避免 PG 大小写折叠问题） */
export function sqlTableName(tableId: string): string {
  const t = `t_${tableId.toLowerCase()}`;
  if (!SAFE_TABLE.test(t)) throw new Error(`unsafe table name: ${tableId}`);
  return t;
}

/** pageToken 编码：offset 的 base64（含随机前缀，避免与飞书 token 混淆） */
function encodeToken(offset: number): string {
  return `o:${Buffer.from(String(offset), 'utf8').toString('base64url')}`;
}
function decodeToken(tok: string | undefined): number {
  if (!tok) return 0;
  const m = /^o:(.*)$/.exec(tok);
  if (!m || m[1] === undefined) return 0;
  const n = Number(Buffer.from(m[1], 'base64url').toString('utf8'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * PostgreSQL 实现。
 *
 * 设计：每张飞书表对应一张 PG 表 `t_<table_id>`，业务字段整体存 JSONB，
 * 高频过滤字段后续可"提列"加索引而不改变上层调用。
 */
export class SqlStore implements DataStore {
  private readonly pool: Pool;
  private metaReady: Promise<void> | null = null;
  private readonly fieldCache = new Map<string, FieldMeta[]>();

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 元数据表（表清单 / 字段清单），幂等 */
  private ensureMeta(): Promise<void> {
    this.metaReady ??= (async () => {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS acms_tables (
          table_id  text PRIMARY KEY,
          name      text NOT NULL,
          sql_table text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS acms_fields (
          table_id text NOT NULL,
          field_id text NOT NULL,
          name     text NOT NULL,
          type     int  NOT NULL,
          property jsonb NOT NULL DEFAULT '{}'::jsonb,
          PRIMARY KEY (table_id, field_id)
        );
        CREATE INDEX IF NOT EXISTS acms_fields_table_idx ON acms_fields (table_id);
        CREATE UNIQUE INDEX IF NOT EXISTS acms_fields_table_name_uniq ON acms_fields (table_id, name);
      `);
    })();
    return this.metaReady;
  }

  /** 建记录表并注册表信息，幂等 */
  async ensureTable(tableId: string, name: string, fields: { name: string; type: number; property?: unknown }[] = []): Promise<void> {
    await this.ensureMeta();
    const t = sqlTableName(tableId);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${t} (
         id         text PRIMARY KEY,
         data       jsonb NOT NULL DEFAULT '{}'::jsonb,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS ${t}_data_gin ON ${t} USING gin (data jsonb_path_ops);
       CREATE INDEX IF NOT EXISTS ${t}_created_idx ON ${t} (created_at DESC);`,
    );
    await this.pool.query(
      `INSERT INTO acms_tables (table_id, name, sql_table) VALUES ($1,$2,$3)
       ON CONFLICT (table_id) DO UPDATE SET name = EXCLUDED.name`,
      [tableId, name, t],
    );
    for (const f of fields) {
      await this.pool.query(
        `INSERT INTO acms_fields (table_id, field_id, name, type, property) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (table_id, name) DO UPDATE SET type = EXCLUDED.type, property = EXCLUDED.property`,
        [tableId, newFieldId(), f.name, f.type, JSON.stringify(f.property ?? {})],
      );
    }
    this.fieldCache.delete(tableId);
  }

  private async fieldsOf(tableId: string): Promise<FieldMeta[]> {
    const cached = this.fieldCache.get(tableId);
    if (cached) return cached;
    await this.ensureMeta();
    const r = await this.pool.query<{ field_id: string; name: string; type: number; property: unknown }>(
      `SELECT field_id, name, type, property FROM acms_fields WHERE table_id = $1 ORDER BY name`,
      [tableId],
    );
    const out: FieldMeta[] = r.rows.map((x) => ({
      id: x.field_id,
      name: x.name,
      type: x.type,
      property: (typeof x.property === 'object' && x.property ? x.property : {}) as FieldMeta['property'],
    }));
    this.fieldCache.set(tableId, out);
    return out;
  }

  /** 按字段元信息还原读取值（日期格式化、富文本归一化等） */
  private normalize(tableId: string, fields: Record<string, unknown>, metas: FieldMeta[]): Record<string, unknown> {
    const byName = new Map(metas.map((m) => [m.name, m]));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      const m = byName.get(k);
      out[k] = formatReadValue(v, m ? { type: m.type, hasTime: dateFormatterHasTime(m.property.date_formatter) } : undefined);
    }
    return out;
  }

  // ---------- 过滤条件 → 参数化 WHERE ----------

  private buildCondition(c: FilterCondition, p: unknown[]): string {
    const col = `data ->> $${p.push(c.field)}`;
    const op = (c.op ?? 'is').toLowerCase();
    const vals = (c.value ?? []).filter((v) => v !== '' && v != null);
    if (op === 'isempty') return `coalesce(${col}, '') = ''`;
    if (op === 'isnotempty') return `coalesce(${col}, '') <> ''`;
    if (!vals.length) return '';
    const one = (v: string): string => {
      const idx = p.push(v);
      switch (op) {
        case 'isnot':
          return `${col} IS DISTINCT FROM $${idx}`;
        case 'contains':
        case 'doesnotcontain': {
          const like = `${col} ILIKE '%' || $${idx} || '%'`;
          return op === 'contains' ? like : `NOT (${like})`;
        }
        case 'isgreater':
          return `(${col})::numeric > ($${idx})::numeric`;
        case 'isless':
          return `(${col})::numeric < ($${idx})::numeric`;
        default:
          return `${col} = $${idx}`;
      }
    };
    const parts = vals.map(one);
    return parts.length === 1 ? (parts[0] ?? '') : `(${parts.join(' OR ')})`;
  }

  private buildWhere(filter: FilterGroup | undefined, p: unknown[]): string {
    if (!filter?.conditions?.length) return '';
    const parts: string[] = [];
    for (const c of filter.conditions) {
      if ('conjunction' in c && !('field' in c)) {
        const sub = this.buildWhere(c as FilterGroup, p);
        if (sub) parts.push(sub);
      } else {
        const sub = this.buildCondition(c as FilterCondition, p);
        if (sub) parts.push(sub);
      }
    }
    if (!parts.length) return '';
    const joiner = filter.conjunction === 'or' ? ' OR ' : ' AND ';
    return `(${parts.join(joiner)})`;
  }

  private buildOrderBy(sort: ListOptions['sort'], p: unknown[]): string {
    if (!sort?.length) return 'created_at DESC';
    const parts = sort.map((s) => `data ->> $${p.push(s.field)} ${s.desc ? 'DESC' : 'ASC'} NULLS LAST`);
    parts.push('id ASC');
    return parts.join(', ');
  }

  // ---------- DataStore 实现 ----------

  async search(tableId: string, opts: ListOptions = {}): Promise<ListResult> {
    const t = sqlTableName(tableId);
    const p: unknown[] = [];
    const where = this.buildWhere(opts.filter, p);
    // count 语句没有 ORDER BY，只能用 where 段的参数；排序参数在其后追加
    const whereParams = p.length;
    const orderBy = this.buildOrderBy(opts.sort, p);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 500);
    const offset = decodeToken(opts.pageToken);

    const countSql = `SELECT count(*)::int AS c FROM ${t}${where ? ` WHERE ${where}` : ''}`;
    const total =
      ((await this.pool.query<{ c: number }>(countSql, p.slice(0, whereParams))).rows[0]?.c ?? 0) as number;

    const p2 = [...p, pageSize, offset];
    const rows = await this.pool.query<{ id: string; data: Record<string, unknown>; created_at: Date }>(
      `SELECT id, data, created_at FROM ${t}${where ? ` WHERE ${where}` : ''}
       ORDER BY ${orderBy} LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
      p2,
    );

    const metas = await this.fieldsOf(tableId);
    const items: BaseRecord[] = rows.rows.map((r) => ({
      recordId: r.id,
      fields: this.normalize(tableId, r.data ?? {}, metas),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : undefined,
    }));

    const nextOffset = offset + items.length;
    const hasMore = nextOffset < total;
    return { items, total, hasMore, pageToken: hasMore ? encodeToken(nextOffset) : undefined };
  }

  async get(tableId: string, recordId: string): Promise<BaseRecord | null> {
    const t = sqlTableName(tableId);
    const r = await this.pool.query<{ id: string; data: Record<string, unknown>; created_at: Date }>(
      `SELECT id, data, created_at FROM ${t} WHERE id = $1`,
      [recordId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const metas = await this.fieldsOf(tableId);
    return {
      recordId: row.id,
      fields: this.normalize(tableId, row.data ?? {}, metas),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : undefined,
    };
  }

  async create(tableId: string, fields: Record<string, unknown>): Promise<string> {
    const t = sqlTableName(tableId);
    const id = newRecordId();
    await this.pool.query(`INSERT INTO ${t} (id, data) VALUES ($1, $2::jsonb)`, [id, JSON.stringify(fields ?? {})]);
    return id;
  }

  /** 用指定 id 写入（双写场景：id 由飞书生成，SQL 侧跟随，保证两边 id 一致可回退） */
  async createWithId(tableId: string, id: string, fields: Record<string, unknown>): Promise<string> {
    const t = sqlTableName(tableId);
    await this.pool.query(
      `INSERT INTO ${t} (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [id, JSON.stringify(fields ?? {})],
    );
    return id;
  }

  async update(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    const t = sqlTableName(tableId);
    await this.pool.query(
      `UPDATE ${t} SET data = data || $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(fields ?? {}), recordId],
    );
  }

  async delete(tableId: string, recordId: string): Promise<void> {
    const t = sqlTableName(tableId);
    await this.pool.query(`DELETE FROM ${t} WHERE id = $1`, [recordId]);
  }

  async listFields(tableId: string): Promise<FieldMeta[]> {
    return this.fieldsOf(tableId);
  }

  async updateField(tableId: string, fieldId: string, body: UpdateFieldBody): Promise<void> {
    await this.ensureMeta();
    await this.pool.query(
      `UPDATE acms_fields SET name = $3, type = $4, property = $5::jsonb WHERE table_id = $1 AND field_id = $2`,
      [tableId, fieldId, body.field_name, body.type, JSON.stringify(body.property ?? {})],
    );
    this.fieldCache.delete(tableId);
  }

  async createField(tableId: string, body: CreateFieldBody): Promise<CreatedField> {
    await this.ensureMeta();
    const fieldId = newFieldId();
    await this.pool.query(
      `INSERT INTO acms_fields (table_id, field_id, name, type, property) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [tableId, fieldId, body.field_name, body.type, JSON.stringify(body.property ?? {})],
    );
    this.fieldCache.delete(tableId);
    return { field_id: fieldId, field_name: body.field_name, type: body.type };
  }

  async deleteField(tableId: string, fieldId: string): Promise<void> {
    await this.ensureMeta();
    await this.pool.query(`DELETE FROM acms_fields WHERE table_id = $1 AND field_id = $2`, [tableId, fieldId]);
    this.fieldCache.delete(tableId);
  }

  async addFieldOptions(tableId: string, fieldId: string, names: string[]): Promise<void> {
    if (!names.length) return;
    const r = await this.pool.query<{ property: unknown; name: string; type: number }>(
      `SELECT property, name, type FROM acms_fields WHERE table_id = $1 AND field_id = $2`,
      [tableId, fieldId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`addFieldOptions: field ${fieldId} not found in ${tableId}`);
    const prop = (typeof row.property === 'object' && row.property ? row.property : {}) as { options?: { name: string; id?: string }[] };
    const existing = prop.options ?? [];
    const have = new Set(existing.map((o) => o.name));
    const merged = [...existing];
    for (const n of names) if (!have.has(n)) merged.push({ name: n });
    await this.pool.query(`UPDATE acms_fields SET property = $3::jsonb WHERE table_id = $1 AND field_id = $2`, [
      tableId,
      fieldId,
      JSON.stringify({ ...prop, options: merged }),
    ]);
    this.fieldCache.delete(tableId);
  }

  async listTables(): Promise<TableRef[]> {
    await this.ensureMeta();
    const r = await this.pool.query<{ table_id: string; name: string }>(
      `SELECT table_id, name FROM acms_tables ORDER BY name`,
    );
    return r.rows.map((x) => ({ tableId: x.table_id, name: x.name }));
  }

  async createTable(tableName: string, fields: CreateTableField[]): Promise<TableRef> {
    const tableId = `tbl${newFieldId().slice(4)}${Date.now().toString(36)}`;
    await this.ensureTable(
      tableId,
      tableName,
      fields.map((f) => ({
        name: f.field_name,
        type: f.type,
        property: f.options ? { options: f.options.map((o) => ({ name: o })) } : {},
      })),
    );
    return { tableId, name: tableName };
  }

  /** 导入用：批量写入（飞书无批量写入，SQL 侧可走多值 INSERT） */
  async bulkInsert(
    tableId: string,
    rows: { id: string; fields: Record<string, unknown>; createdAt?: number | string | null }[],
  ): Promise<number> {
    if (!rows.length) return 0;
    const t = sqlTableName(tableId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const params: unknown[] = [];
        const values: string[] = [];
        chunk.forEach((r, j) => {
          const a = j * 3 + 1;
          const ts = r.createdAt ? new Date(Number(r.createdAt)) : null;
          params.push(r.id, JSON.stringify(r.fields ?? {}), ts && !Number.isNaN(ts.getTime()) ? ts : null);
          values.push(`($${a}, $${a + 1}::jsonb, coalesce($${a + 2}::timestamptz, now()))`);
        });
        await client.query(
          `INSERT INTO ${t} (id, data, created_at) VALUES ${values.join(',')}
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
          params,
        );
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** 校验用：表内记录数 */
  async count(tableId: string): Promise<number> {
    const t = sqlTableName(tableId);
    const r = await this.pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${t}`);
    return r.rows[0]?.c ?? 0;
  }
}
