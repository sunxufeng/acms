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
  RecordAudit,
  TableRef,
  UpdateFieldBody,
} from '@acms/base-adapter';
import { dateFormatterHasTime, formatReadValue, newFieldId, newRecordId } from './field-type.js';
import { currentActor, systemLabel, UNKNOWN_ACTOR } from '../shared/actor-context.js';

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
         updated_at timestamptz NOT NULL DEFAULT now(),
         created_by text NOT NULL DEFAULT 'system:unknown',
         updated_by text NOT NULL DEFAULT 'system:unknown'
       );
       CREATE INDEX IF NOT EXISTS ${t}_data_gin ON ${t} USING gin (data jsonb_path_ops);
       CREATE INDEX IF NOT EXISTS ${t}_created_idx ON ${t} (created_at DESC);
       ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'system:unknown';
       ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT 'system:unknown';`,
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

    await this.ensureAuditColumns(tableId);
    const p2 = [...p, pageSize, offset];
    const rows = await this.pool.query<{
      id: string;
      data: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      created_by: string;
      updated_by: string;
    }>(
      `SELECT id, data, created_at, updated_at, created_by, updated_by FROM ${t}${where ? ` WHERE ${where}` : ''}
       ORDER BY ${orderBy} LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
      p2,
    );

    const metas = await this.fieldsOf(tableId);
    const names = await this.resolveNames(rows.rows.flatMap((r) => [r.created_by, r.updated_by]));
    const items: BaseRecord[] = rows.rows.map((r) => ({
      recordId: r.id,
      fields: this.normalize(tableId, r.data ?? {}, metas),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : undefined,
      audit: SqlStore.toAudit(r, names),
    }));

    const nextOffset = offset + items.length;
    const hasMore = nextOffset < total;
    return { items, total, hasMore, pageToken: hasMore ? encodeToken(nextOffset) : undefined };
  }

  async get(tableId: string, recordId: string): Promise<BaseRecord | null> {
    const t = sqlTableName(tableId);
    await this.ensureAuditColumns(tableId);
    const r = await this.pool.query<{
      id: string;
      data: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      created_by: string;
      updated_by: string;
    }>(`SELECT id, data, created_at, updated_at, created_by, updated_by FROM ${t} WHERE id = $1`, [recordId]);
    const row = r.rows[0];
    if (!row) return null;
    const metas = await this.fieldsOf(tableId);
    return {
      recordId: row.id,
      fields: this.normalize(tableId, row.data ?? {}, metas),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : undefined,
      audit: SqlStore.toAudit(row, await this.resolveNames([row.created_by, row.updated_by])),
    };
  }

  /** 当前操作人 id：无上下文（启动期 / 裸脚本）时回落为 system:unknown */
  private actorId(): string {
    return currentActor()?.id ?? UNKNOWN_ACTOR.id;
  }

  /**
   * 审计列自愈：历史表（迁移脚本未覆盖 / 手工建的表）缺 created_by、updated_by 时补上。
   * 每张表只执行一次 DDL，结果缓存在 auditReady；表不存在时静默跳过（由 ensureTable 负责建）。
   */
  private readonly auditReady = new Set<string>();
  private async ensureAuditColumns(tableId: string): Promise<void> {
    if (this.auditReady.has(tableId)) return;
    const t = sqlTableName(tableId);
    try {
      await this.pool.query(
        `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'system:unknown';
         ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT 'system:unknown'`,
      );
      this.auditReady.add(tableId);
    } catch {
      // 表尚未创建（首次访问），交给 ensureTable 处理，这里忽略
    }
  }

  /** 把 PG 时间戳列统一转成 ISO 字符串 */
  private static iso(v: unknown): string {
    return v instanceof Date ? v.toISOString() : String(v ?? '');
  }

  // ---------- 操作人展示名解析（openId -> 姓名） ----------

  private static readonly NAME_TTL_MS = 5 * 60 * 1000;
  private readonly nameCache = new Map<string, string>();
  private nameCacheAt = 0;
  private userTable: string | null | undefined;

  /** 定位系统用户表（不同环境表名可能不同，按名称匹配而非硬编码 tableId） */
  private async findUserTable(): Promise<string | null> {
    if (this.userTable !== undefined) return this.userTable;
    try {
      await this.ensureMeta();
      const r = await this.pool.query<{ sql_table: string }>(
        `SELECT sql_table FROM acms_tables WHERE name LIKE '系统用户%' LIMIT 1`,
      );
      this.userTable = r.rows[0]?.sql_table ?? null;
    } catch {
      this.userTable = null;
    }
    return this.userTable;
  }

  /** 刷新 openId -> 姓名 缓存（5 分钟 TTL，用户表只有几十行，全量拉最省事） */
  private async loadNames(): Promise<void> {
    if (Date.now() - this.nameCacheAt < SqlStore.NAME_TTL_MS) return;
    const t = await this.findUserTable();
    if (!t) return;
    try {
      const r = await this.pool.query<{ oid: string; nm: string }>(
        `SELECT data->>'飞书 Open ID' AS oid, data->>'姓名' AS nm FROM ${t}`,
      );
      this.nameCache.clear();
      for (const row of r.rows) {
        if (row.oid) this.nameCache.set(row.oid, row.nm || row.oid);
      }
      this.nameCacheAt = Date.now();
    } catch {
      // 用户表结构异常时降级：直接显示 openId，不影响主流程
    }
  }

  /** 批量解析展示名：系统身份查映射表，openId 查用户表缓存 */
  private async resolveNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const needDb = new Set<string>();
    for (const id of ids) {
      if (!id || out.has(id)) continue;
      const sys = systemLabel(id);
      if (sys) {
        out.set(id, sys);
        continue;
      }
      const cached = this.nameCache.get(id);
      if (cached) {
        out.set(id, cached);
        continue;
      }
      needDb.add(id);
    }
    if (needDb.size) {
      await this.loadNames();
      for (const id of needDb) out.set(id, this.nameCache.get(id) ?? id);
    }
    return out;
  }

  /** 组装审计四件套（时间列一定存在，人列由 ensureAuditColumns 保障） */
  private static toAudit(
    r: {
      created_at: unknown;
      updated_at: unknown;
      created_by?: string | null;
      updated_by?: string | null;
    },
    names: Map<string, string>,
  ): RecordAudit {
    const cb = r.created_by ?? UNKNOWN_ACTOR.id;
    const ub = r.updated_by ?? UNKNOWN_ACTOR.id;
    return {
      createdBy: cb,
      createdByName: names.get(cb) ?? systemLabel(cb) ?? cb,
      createdAt: SqlStore.iso(r.created_at),
      updatedBy: ub,
      updatedByName: names.get(ub) ?? systemLabel(ub) ?? ub,
      updatedAt: SqlStore.iso(r.updated_at),
    };
  }

  async create(tableId: string, fields: Record<string, unknown>): Promise<string> {
    const t = sqlTableName(tableId);
    const id = newRecordId();
    const actor = this.actorId();
    await this.pool.query(
      `INSERT INTO ${t} (id, data, created_by, updated_by) VALUES ($1, $2::jsonb, $3, $3)`,
      [id, JSON.stringify(fields ?? {}), actor],
    );
    return id;
  }

  /** 用指定 id 写入（双写场景：id 由飞书生成，SQL 侧跟随，保证两边 id 一致可回退） */
  async createWithId(tableId: string, id: string, fields: Record<string, unknown>): Promise<string> {
    const t = sqlTableName(tableId);
    const actor = this.actorId();
    // ⚠️ ON CONFLICT 分支只更新 updated_by，保留首次写入的 created_by
    await this.pool.query(
      `INSERT INTO ${t} (id, data, created_by, updated_by) VALUES ($1, $2::jsonb, $3, $3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = $3`,
      [id, JSON.stringify(fields ?? {}), actor],
    );
    return id;
  }

  async update(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    const t = sqlTableName(tableId);
    await this.pool.query(
      `UPDATE ${t} SET data = data || $1::jsonb, updated_at = now(), updated_by = $3 WHERE id = $2`,
      [JSON.stringify(fields ?? {}), recordId, this.actorId()],
    );
  }

  /**
   * 数字字段原子自增（delta 可为负）。
   *
   * 为什么必须用 SQL 表达式而不是「读出来加一下再写回」：
   * 累加类字段（额度、计数、用量）在并发下读-改-写必然丢更新 —— 两个请求都读到 100、
   * 各自写 110，最后只累加了一次。这里交给 Postgres 的 jsonb_set 在一条语句里完成。
   * 字段不存在或不是数字时按 0 起算（coalesce）。
   */
  async addNumber(
    tableId: string,
    recordId: string,
    field: string,
    delta: number,
    decimals = 6,
  ): Promise<void> {
    const t = sqlTableName(tableId);
    await this.pool.query(
      `UPDATE ${t}
          SET data = jsonb_set(
                data,
                ARRAY[$2::text],
                to_jsonb(round(coalesce(nullif(data->>$2, '')::numeric, 0) + $3::numeric, $5::int)),
                true
              ),
              updated_at = now(),
              updated_by = $4
        WHERE id = $1`,
      [recordId, field, delta, this.actorId(), decimals],
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
