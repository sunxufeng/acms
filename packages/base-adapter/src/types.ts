/**
 * 数据访问层统一契约。
 *
 * 全站 36 个业务 service 只依赖 `DataStore` 这 12 个方法，具体由哪种存储实现
 * （飞书 Base / PostgreSQL）在运行时决定 —— 见 `apps/api/src/base.provider.ts`。
 *
 * ⚠️ 新增存储实现时，语义必须严格对齐 `BaseClient`（飞书实现）：
 *   - search/get 返回的 fields 已完成「读取侧转换」（datetime → 字符串等）
 *   - create/update 接收原始业务值，写入侧转换由实现内部完成
 *   - create 返回新记录 id；get 查不到返回 null（不抛错）
 */
export interface BaseRecord {
  recordId: string;
  fields: Record<string, unknown>;
  /** 记录创建时间（已转 ISO 字符串）；部分接口不返回则为 undefined */
  createdAt?: string;
  /**
   * 审计信息「创建人 / 创建时间 / 更新人 / 更新时间」。
   * 由支持审计的存储实现（SqlStore）从物理列读取；不支持的实现（飞书）不返回。
   * 放在 fields 之外，避免与业务字段混淆、也避免被写回 data。
   */
  audit?: RecordAudit;
}

/**
 * 记录级审计四件套。遵循「键值双标识」：
 * - `createdBy` / `updatedBy` 是稳定 key（飞书 openId 或 system:<来源>），改名不受影响；
 * - `createdByName` / `updatedByName` 是展示 label（真实姓名或「系统 · 邮件归档」）。
 * 只存姓名会在用户改名后对不上人，只存 openId 用户又看不懂，所以两个都要。
 */
export interface RecordAudit {
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
}

export interface FilterCondition {
  field: string;
  /** 默认 is */
  op?: string;
  value: string[];
}

/** 嵌套过滤组（支持 conjunction + conditions 嵌套） */
export interface FilterGroup {
  conjunction: 'and' | 'or';
  conditions: (FilterCondition | FilterGroup)[];
}

export interface ListOptions {
  pageSize?: number;
  pageToken?: string;
  filter?: FilterGroup;
  sort?: { field: string; desc: boolean }[];
}

export interface FieldOption {
  name: string;
  id?: string;
}

export interface FieldProperty {
  options?: FieldOption[];
  date_formatter?: string;
  /** 飞书 property 还可能携带其它字段（如 multiple、formatter 等），保留索引签名以兼容既有调用方 */
  [key: string]: unknown;
}

export interface FieldMeta {
  id: string;
  name: string;
  type: number;
  property: FieldProperty;
}

export interface ListResult {
  items: BaseRecord[];
  total: number;
  hasMore: boolean;
  pageToken?: string;
}

export interface UpdateFieldBody {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

export interface CreateFieldBody {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

export interface CreatedField {
  field_id: string;
  field_name: string;
  type: number;
}

export interface TableRef {
  tableId: string;
  name: string;
}

export interface CreateTableField {
  field_name: string;
  type: number;
  options?: string[];
}

/**
 * 存储实现契约。所有方法第一参数均为 tableId（表标识）。
 */
export interface DataStore {
  /** 检索记录（服务端过滤），游标分页 */
  search(tableId: string, opts?: ListOptions): Promise<ListResult>;
  /** 单条读取；不存在返回 null */
  get(tableId: string, recordId: string): Promise<BaseRecord | null>;
  /** 新建记录，返回新记录 id */
  create(tableId: string, fields: Record<string, unknown>): Promise<string>;
  update(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
  delete(tableId: string, recordId: string): Promise<void>;
  listFields(tableId: string): Promise<FieldMeta[]>;
  updateField(tableId: string, fieldId: string, body: UpdateFieldBody): Promise<void>;
  createField(tableId: string, body: CreateFieldBody): Promise<CreatedField>;
  deleteField(tableId: string, fieldId: string): Promise<void>;
  /** 向单选/多选字段追加选项（不改动已有选项） */
  addFieldOptions(tableId: string, fieldId: string, names: string[]): Promise<void>;
  listTables(): Promise<TableRef[]>;
  createTable(tableName: string, fields: CreateTableField[]): Promise<TableRef>;
}
