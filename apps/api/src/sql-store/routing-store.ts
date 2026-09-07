import type {
  BaseRecord,
  CreateFieldBody,
  CreateTableField,
  CreatedField,
  DataStore,
  FieldMeta,
  ListOptions,
  ListResult,
  TableRef,
  UpdateFieldBody,
} from '@acms/base-adapter';
import type { SqlStore } from './sql-store.js';

/**
 * 按表路由：SQL_TABLES 里登记的表走 PostgreSQL，其余走飞书。
 *
 * - `SQL_TABLES` 未配置或为空 → 全部走飞书（线上零影响）
 * - `SQL_TABLES='*'` → 全部走 SQL
 * - `SQL_TABLES='tblA,tblB'` → 逐表灰度
 *
 * 未配置 DATABASE_URL 时 SqlStore 为 null，永远走飞书。
 */
export class RoutingStore implements DataStore {
  constructor(
    private readonly feishu: DataStore,
    private readonly sql: SqlStore | null,
    private readonly sqlTables: Set<string>,
    /** 影子写：SQL 为主写的同时把变更同步回飞书，保证任意时刻都能回退（失败只记日志，不阻断） */
    private readonly shadowWrite = false,
  ) {}

  get sqlEnabled(): boolean {
    return this.sql !== null;
  }

  private pick(tableId: string): DataStore {
    if (this.sql && (this.sqlTables.has('*') || this.sqlTables.has(tableId))) return this.sql;
    return this.feishu;
  }

  /** 影子写飞书：任何异常都只记日志，绝不影响主流程 */
  private shadow(tableId: string, op: string, fn: () => Promise<unknown>): void {
    if (!this.shadowWrite) return;
    void Promise.resolve()
      .then(fn)
      .catch((e: unknown) => {
        console.error(`[sql-shadow] ${op} ${tableId} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  search(tableId: string, opts?: ListOptions): Promise<ListResult> {
    return this.pick(tableId).search(tableId, opts);
  }
  get(tableId: string, recordId: string): Promise<BaseRecord | null> {
    return this.pick(tableId).get(tableId, recordId);
  }
  /**
   * 影子写模式下，由飞书生成 id 再写入 SQL —— 飞书 create 不接受自定义 record_id，
   * 只有这样才能保证两边 id 一致，回退时关联引用不会错位。
   */
  async create(tableId: string, fields: Record<string, unknown>): Promise<string> {
    const store = this.pick(tableId);
    if (this.shadowWrite && this.sql && store === this.sql) {
      const id = await this.feishu.create(tableId, fields);
      try {
        await this.sql.createWithId(tableId, id, fields);
      } catch (e) {
        console.error(`[sql-shadow] createWithId ${tableId} ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return id;
    }
    return store.create(tableId, fields);
  }

  async update(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    const store = this.pick(tableId);
    await store.update(tableId, recordId, fields);
    if (this.shadowWrite && this.sql && store === this.sql) {
      this.shadow(tableId, `update ${recordId}`, () => this.feishu.update(tableId, recordId, fields));
    }
  }

  async delete(tableId: string, recordId: string): Promise<void> {
    const store = this.pick(tableId);
    await store.delete(tableId, recordId);
    if (this.shadowWrite && this.sql && store === this.sql) {
      this.shadow(tableId, `delete ${recordId}`, () => this.feishu.delete(tableId, recordId));
    }
  }
  listFields(tableId: string): Promise<FieldMeta[]> {
    return this.pick(tableId).listFields(tableId);
  }
  updateField(tableId: string, fieldId: string, body: UpdateFieldBody): Promise<void> {
    return this.pick(tableId).updateField(tableId, fieldId, body);
  }
  createField(tableId: string, body: CreateFieldBody): Promise<CreatedField> {
    return this.pick(tableId).createField(tableId, body);
  }
  deleteField(tableId: string, fieldId: string): Promise<void> {
    return this.pick(tableId).deleteField(tableId, fieldId);
  }
  addFieldOptions(tableId: string, fieldId: string, names: string[]): Promise<void> {
    return this.pick(tableId).addFieldOptions(tableId, fieldId, names);
  }
  /** 表清单以飞书为准（迁移期两边保持一致，飞书是原始登记处） */
  listTables(): Promise<TableRef[]> {
    return this.feishu.listTables();
  }
  createTable(tableName: string, fields: CreateTableField[]): Promise<TableRef> {
    return this.feishu.createTable(tableName, fields);
  }
}
