'use client';

import { Fragment, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { usePermissions } from '../lib/permissions';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTl } from '../lib/useTl';
import { MODULE_RESOURCES } from '@acms/contracts';
import { api as apiClient, type Page, type DictMeta } from '../lib/api';
import MarkdownField from './MarkdownField';
import TagInput from './TagInput';
import MapPicker from './MapPicker';
import Combobox from './Combobox';
import Pagination from './Pagination';
import { takeConvertPayload, CONVERT_QUERY_FLAG, CONVERT_QUERY_VALUE } from '../lib/noteConvert';
import { currentUserName } from '../lib/noteAutoFill';
// 仅用于转换场景的留痕回填（把新建出的业务记录 id 写回「笔记转换记录」）。
// 注意组件内已有名为 api 的 prop，所以全局 api 必须起别名，否则会遮蔽。
import { api as globalApi } from '../lib/api';

export type CrudFieldType = 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'multiselect' | 'person' | 'student' | 'studentLink' | 'parent' | 'department' | 'attachment' | 'markdown' | 'map' | 'tags' | 'password' | 'weilingContact' | 'link';

export interface CrudColumn {
  key: string;
  label: string;
  width?: string;
  render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode;
  filter?: boolean;
  /** 列筛选控件类型：select=下拉(默认) / text=文本输入框 */
  filterType?: 'select' | 'text';
  /**
   * 文本筛选的匹配方式（**只在后端是通用 CRUD 时才需要声明**）：
   *  - `'contains'` → 参数名补 `__contains` 后缀，后端翻译成 ILIKE `%值%` 模糊匹配
   *  - `'is'` 或不声明 → 原样传参（后端默认等值匹配）
   *
   * ⚠️ 为什么不是 `filterType: 'text'` 就自动模糊：通用 CRUD 的字段筛选原本一律等值，
   *    而**自建 controller**（考勤 / 排课 / 结算 / 合作 / 合作方…）用的是自己 DTO 里的
   *    参数名且已手写 `op: 'contains'` —— 给它们加后缀后端不认识，会静默筛成空。
   *    所以模糊与否是「后端实现」决定的信息，只能由列自己声明。
   *    （2026-09-14：联系人页「关联学生」输入「赵」恒为 0 条，就是通用层漏了模糊。）
   */
  filterOp?: 'is' | 'contains';
  /** 筛选提交到后端的查询参数名（默认用 key，如审计页操作人→actor） */
  filterParam?: string;
  filterOptions?: string[];
  /**
   * 筛选项的**显示文案**（`值 → 显示名`）。用于「库里存码值、界面要出中文」的枚举：
   * 下拉里显示中文、提交给后端的仍是 `filterOptions` 里的原始值。
   *
   * ⚠️ 反过来做（把 filterOptions 直接写成中文）会**一条都筛不出来** —— 通用 CRUD 的
   * 裸字段筛选是等值匹配，而数据里存的是 `0/1/4` 这样的码值。
   * （2026-09-14 卫瓴联系人「状态」：官方枚举 0=待认领（公海）/ 1=已认领 / 4=待分配。）
   */
  filterOptionLabels?: Record<string, string>;
  /**
   * 文本筛选框的占位文案（默认走 `crud.filterBy` = 「筛选{字段名}」）。
   *
   * 个别列给「筛选」这类前缀会显得啰嗦（筛选区本身已有放大镜图标 + 周围都是筛选控件），
   * 这时可用本字段直接给一句更短的文案，例如 `filterPlaceholder: '关联学生'`。
   * 走 tl() 解析，中英文都可覆盖。
   */
  filterPlaceholder?: string;
  /**
   * 文本筛选框的宽度（px），默认 160。
   *
   * 只用于「文案本身就短」的列：筛选区是按控件数量平铺的，一个宽框会把整行撑散，
   * 视觉上也显得这个筛选比别的重要。占位文案只有三四个字时按字数收窄即可，
   * 例如「关联学生」用 100。
   */
  filterWidth?: number;
  form?: boolean;
  /** 是否在列表表格中显示（默认 true；设为 false 仅保留在表单中，例如敏感列） */
  list?: boolean;
  /** 列表列排序权重（升序）；未设置的列排在已设置列之后，并保持原有相对顺序 */
  listOrder?: number;
  type?: CrudFieldType;
  options?: string[];
  /**
   * 关联字段（type: 'link'）的候选项：value 是目标表的 record id，label 是展示名。
   * 与 options（string[]）分开，避免动到既有模块的 select 行为。
   * 提交时传 value；列表/详情显示的姓名由后端 linkFields 解析。
   */
  linkOptions?: { value: string; label: string }[];
  /**
   * 关联字段多选（如一个上游账号可属于多个分组）：
   * 表单渲染成复选组，提交 id 数组；后端 multi 字段按数组存、linkFields 解析成名称。
   * ⚠️ 必须同时在 RecordMeta 的 multi 里登记该字段，否则会被当成字符串写入。
   */
  linkMulti?: boolean;
  /** 候选项来自字典表（优先于 options；options 作为离线兜底） */
  dictKey?: string;
  required?: boolean;
  /** 联动来源字段 key（如 parent 类型从 student 类型所选学生的父亲/母亲取候选） */
  dependsOn?: string;
  /** 点击该列单元格时打开当前记录的编辑/详情表单（而非导航到其它页面） */
  openRecord?: boolean;
  /** 表单字段下方的辅助提示文字 */
  hint?: string;
  /** markdown / textarea 类型：编辑器高度（px）。markdown 不传用默认 300；textarea 不传用默认 3 行 */
  fieldHeight?: number;
  /** map 类型：写入纬度的目标字段 key */
  latKey?: string;
  /** map 类型：写入经度的目标字段 key */
  lngKey?: string;
  /** tags 类型：表单内候选建议（下拉展示未选中的项） */
  tagOptions?: string[];
  /** tags 类型：额外的快捷添加按钮（如「添加当前 WiFi」） */
  tagQuickAdd?: React.ReactNode;
  /** tags 类型：内置快捷填充动作；'wifi' = 一键读取本机当前连接的 WiFi（需运行 scripts/wifi-helper.mjs） */
  quickFill?: 'wifi';
  /** 表单字段只读（渲染为 disabled）。用于「展示但不可编辑」的派生字段，如从详情接口回填的原始记录 */
  readonly?: boolean;
  /**
   * Markdown 明细字段的专项权限（比模块读写权限更严格）：
   *  - mdEditPerm：有此权限才能在 MD tab 输入；没有则只能浏览渲染结果
   *  - mdImportPerm：有此权限才显示「MD导入」按钮（用于从本地文件整篇覆盖）
   * 不配则不限制（保持原有行为）。
   */
  mdEditPerm?: string;
  mdImportPerm?: string;
  /**
   * 自定义表单控件：替代 columns 自动生成的控件（下拉/输入框…），
   * 但**仍然复用** CrudPage 的必填校验、提交、错误处理与密级遮蔽。
   * 用于卡片选择器、多值编辑器这类声明式字段表达不了的控件。
   */
  renderField?: (ctx: {
    value: unknown;
    onChange: (v: unknown) => void;
    /** 当前表单全部字段值（用于字段联动，如按 BaseURL 探测上游模型） */
    form: Record<string, unknown>;
    /** 正在编辑的原始行（新建时为 null）。渲染值已被解析/掩码，需要 id 这类原始字段时用它 */
    row: Record<string, unknown> | null;
    column: CrudColumn;
  }) => React.ReactNode;
  /**
   * 表单分区标题：与上一列的分区名不同时会插入一条分区标题（跨整行）。
   * 让长表单能按「基本信息 / 模型限制 / 调度与额度」分块，而不是几十个字段平铺。
   */
  section?: string;
  /**
   * 行内开关：单元格渲染成开关，点击即回调 CrudPage 的 onInlineSwitch。
   * 典型用途：上游账号的「可调度」—— 列表上直接停调/恢复，不必进编辑页。
   */
  inlineSwitch?: { onValue: string; offValue: string; onHint?: string; offHint?: string };
}

/** 时间范围筛选（如审计日志按操作时间区间过滤） */
export interface RangeFilter {
  key: string;
  label: string;
  fromParam: string;
  toParam: string;
}

export interface CrudApi {
  list: (params: Record<string, string | undefined>) => Promise<Page<Record<string, unknown>>>;
  // ⚠️ 只读模块（如卫瓴联系人）只传 list：不传这三个就没有任何写入入口，
  // 配合 readonly / hideCreate 使用，避免被迫传空实现。
  create?: (data: Record<string, unknown>) => Promise<unknown>;
  update?: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  archive?: (id: string) => Promise<unknown>;
  transition?: (id: string, to: string) => Promise<unknown>;
  /** 服务端批量导入（generic-crud 提供）：逐行 create。提供后工具栏显示「导入」按钮。 */
  importRows?: (rows: Record<string, unknown>[]) => Promise<{ ok: number; failed: number }>;
}

export interface CrudPageProps {
  title: string;
  subtitle?: string;
  columns: CrudColumn[];
  api: CrudApi;
  statusField?: string;
  transitions?: Record<string, string[]>;
  statusClass?: (s: string) => string;
  extraActions?: { label: string; run: (reload: () => void) => void | Promise<void> }[];
  /** 只读模式：隐藏新建/编辑/删除按钮与弹窗（用于审计日志等仅查看的表） */
  readonly?: boolean;
  /** 隐藏「新建」按钮（如审计日志等不可新增的表；readonly 已隐含隐藏，此属性用于非只读但也不允许新增的场景） */
  hideCreate?: boolean;
  /** 时间范围筛选（起止日期） */
  rangeFilters?: RangeFilter[];
  /** 全局关键字搜索框：发送 q 参数，由后端 searchField 决定检索字段（支持关联字段跨表解析后模糊匹配） */
  search?: { placeholder: string };
  /**
   * 允许从 URL 直接读进来并透传给 list 的查询参数名（报表下钻用）。
   * 这些条件没有对应的筛选控件（如「来源组件」「跟进人」「自定义字段」），
   * 只作为隐藏查询条件生效，URL 上没有时完全不参与。
   */
  passthroughParams?: string[];
  /** 新建/编辑使用页内表单（非弹出框） */
  inlineEdit?: boolean;
  /** 新建/编辑时使用独立页面风格，隐藏列表页标题、操作与筛选区 */
  standaloneForm?: boolean;
  /** 自定义表单插槽：传入时用该组件替换 columns 自动生成的表单字段区。
   *  用于承载无法用 columns 表达的自定义富表单（如 SessionForm）。
   *  row 为编辑中的行（新建时为 null）；onDone 在保存成功后调用，用于关闭表单并刷新列表。 */
  renderForm?: (ctx: { row: Record<string, unknown> | null; onDone: () => void }) => React.ReactNode;
  /** 新建/编辑状态变化回调（true=进入表单，false=返回列表） */
  onEditingChange?: (editing: boolean) => void;
  /** 每页记录数（默认 5，参考学生列表页） */
  pageSize?: number;
  /** 额外链接按钮（如「排课与课次」跳转预检页），渲染为 <Link> */
  extraLinks?: { label: string; href: string }[];
  /** 新建改为跳转到独立页面（而非页内表单/弹窗）。设置后「新建」按钮渲染为 <Link> */
  createHref?: string;
  /** 编辑改为跳转到独立页面：行 id → href。设置后每行「编辑」按钮渲染为 <Link> */
  editHref?: (id: string) => string;
  /** 点击 openRecord 列（如学生姓名）时跳转到只读详情页（行 id → href），而非打开编辑表单 */
  detailHref?: (id: string) => string;
  /**
   * 预填增强：笔记转换时，目标模块可据此从已预填的长文本里**再解析出其它字段**
   * （如会议纪要按「会议总结」文案自动识别议题 / 地点 / 时间 / 主持人等）。
   * 只在转换场景调用；解析是纯函数，抛错也不影响主流程。
   */
  enrichPrefill?: (
    values: Record<string, unknown>,
    ctx: { userName: string },
  ) => Record<string, unknown>;
  /** studentLink 列（关联学生姓名）点击跳转：传入行，返回目标 href（如学生档案页） */
  studentDetailHref?: (row: Record<string, unknown>) => string;
  /** 行级自定义操作按钮（如「AI 总结」）。run(row, reload) 执行后刷新列表；前端仅在非只读模式渲染 */
  rowExtraActions?: { label: string; run: (row: Record<string, unknown>, reload: () => void) => void | Promise<void> }[];
  /** 表单（standalone / inline 弹窗）底部自定义操作按钮：run(values, close) 执行，
   *  需要当前表单字段值时用（如「测试连接」）。run 返回 { ok, text } 时 CrudPage 会在表单内展示结果 banner。 */
  formExtraActions?: {
    label: string;
    run: (
      values: Record<string, unknown>,
      close: () => void,
    ) => void | Promise<{ ok: boolean; text?: string } | void>;
  }[];
  /** 选择模式：列表每行前显示复选框，支持跨页保留已选；变化时通过 onSelectionChange 回传已选行 */
  selection?: boolean;
  /** 已选行变化回调（跨页合并后的全部已选记录） */
  onSelectionChange?: (rows: Record<string, unknown>[]) => void;
  /** 列表页头部返回箭头：设置后渲染一个返回链接（用于非一级导航的深层子页，如邮件账户） */
  backHref?: string;
  /**
   * 当前模块 key（DEFAULT_NAV_MENU_CONFIG 的 key，如 'students'/'grades'）。提供后，
   * 新建/编辑/删除/导出/导入按钮按 module:<key>:<action> 做按钮级门控，实现「每个按钮都能单独控」。
   * 不提供则沿用 readonly/hideCreate 的旧行为（向后兼容未迁移的页面）。
   */
  moduleKey?: string;
  /**
   * 编辑/详情打开前，用当前行预拉取完整记录并合并字段（异步）。
   * 用于列表行只含摘要、需要详情接口回填额外字段的场景（如 Get笔记 原始记录仅详情返回）。
   * 不提供则维持默认行为：直接用列表行初始化表单。
   */
  enrichEditRow?: (row: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * 行数据每次变化后的回调（供调用方做一次批量二次查询）。
   * 典型用途：笔记列表要显示「已转 N 次」，但留痕在另一张表 —— 用这个钩子
   * 拿到当前页全部行后一次性批量查，避免逐行发请求把接口打爆。
   * ⚠️ 传内联函数不会导致重复触发（内部用 ref 持有，只依赖 items 变化）。
   */
  onRowsLoaded?: (rows: Record<string, unknown>[]) => void;
  /**
   * 批量操作（需同时开启 selection）：有选中行时，列表上方出现批量操作栏，
   * 带「本页全选 / 全选所有结果 / 清除选择」与这里定义的动作。
   * run 收到的是**跨页合并后的全部已选行**；confirm 里写 `{n}` 会被替换成条数。
   */
  bulkActions?: {
    label: string;
    run: (rows: Record<string, unknown>[], reload: () => void) => void | Promise<void>;
    /** 危险动作（红色按钮 + 需确认） */
    danger?: boolean;
    /** 执行前确认文案；不传则直接执行（danger 为真时默认给一个确认） */
    confirm?: string;
  }[];
  /** 列显示设置：工具栏出现「列设置」，可勾选显示哪些列（按 moduleKey 记忆到浏览器） */
  columnSettings?: boolean;
  /** 自动刷新：给出可选间隔秒数（如 [5,10,15,30]），开启后按所选间隔静默重载 */
  autoRefresh?: number[];
  /** 行内开关（CrudColumn.inlineSwitch）的提交回调；next 是要写入的目标值 */
  onInlineSwitch?: (row: Record<string, unknown>, next: string) => void | Promise<void>;
  /**
   * 隐藏末尾的「操作」列。
   * 用于纯只读列表（如卫瓴联系人副本）—— 该列只剩一个空单元格，白占 150px 宽度。
   * 只影响渲染，不影响任何动作能力。
   */
  hideActions?: boolean;
  /**
   * 这些列的**文本值本身就是学生姓名**（而非 link 存的 record id）。
   * 提供后 CrudPage 会拉一次学生档案建「中文名 → 英文名」映射，并以
   * `__studentEnglish` 注入行上，供模块自定义 render 用 studentLabel() 显示双语。
   * 场景：卫瓴联系人的「疑似关联学生」是按姓名匹配出来的，没有 student/studentLink 类型列，
   * 默认不会触发英文名映射。
   */
  studentNameKeys?: string[];
}

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/**
 * 学生列英文名派生键：列表渲染前由 CrudPage 注入到行上，供各模块自定义 render 取用。
 * ⚠️ 一行只注入「第一个命中学生档案的列」的值 —— 若同一行有多个不同的学生字段，
 * 只有第一个能被注入（多字段场景请用 studentIdByName 自己查，别依赖这个键）。
 */
export const STUDENT_ENGLISH_KEY = '__studentEnglish';
/**
 * 学生记录 id 派生键：与英文名一起注入。
 *
 * 用途：字段里存的是**学生姓名文本**（不是 student / studentLink 类型的关联 id）时，
 * 想让这个姓名可点击跳学生详情，就需要 id —— 这里按姓名反查学生档案拿到 id 注入。
 * 典型场景：卫瓴联系人的「疑似关联学生」是按姓名匹配出来的。
 */
export const STUDENT_REF_KEY = '__studentRefId';
/** 学生基本信息页路径（与 students 列表页保持一致，避免多处硬编码） */
export function studentHref(id: string): string {
  return `/students/${encodeURIComponent(id)}`;
}
/** 学生显示名：有英文名时显示「中文名 / 英文名」，与表单下拉选项保持一致 */
export function studentLabel(name: string, englishName?: unknown): string {
  const en = typeof englishName === 'string' ? englishName.trim() : '';
  return name && en ? `${name} / ${en}` : name;
}

/**
 * 字典列的单元格显示文本：逐项翻译后用「、」连接（分隔符与 str() 保持一致）。
 * 只对候选项来自字典/枚举的列（dictKey 或 options）翻译；自由文本列（姓名、校名等）
 * 直出原文，避免误命中 labels 里的同名词条。
 */
function cellText(v: unknown, c: CrudColumn, tl: (k: string) => string, meta: DictMeta | null): string {
  // 码值列（filterOptionLabels = 「值 → 显示名」）：列表显示与导出都要出中文，
  // 不能把 0/1/4 直接丢进 Excel —— 导出一致性见 MEMORY 的「键值双标识」铁律。
  if (c.filterOptionLabels) {
    const labels = c.filterOptionLabels;
    const one = (x: unknown): string => tl(labels[str(x)] ?? str(x));
    return Array.isArray(v) ? v.map(one).join('、') : one(v);
  }
  if (!c.dictKey && !c.options) return str(v);
  // 字典列：先把存储值（旧 label/别名/key）解析为当前展示名，再翻译
  const resolve = (s: string): string =>
    c.dictKey && meta ? (meta.resolve[c.dictKey]?.[s] ?? s) : s;
  if (Array.isArray(v)) return v.map((x) => tl(resolve(str(x)))).join('、');
  return tl(resolve(str(v)));
}

/** 将存储值（"YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"）转为 <input type="datetime-local"> 所需的 "YYYY-MM-DDTHH:mm" */
function toDateTimeLocal(v: unknown): string {
  const s = str(v).trim();
  if (!s) return '';
  const t = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t + 'T00:00';
  return t;
}

/** 附件字段值：可能为数组（表单态）或 JSON 字符串（飞书存储态） */
function attachmentFiles(v: unknown): { file_token: string; name: string }[] {
  if (Array.isArray(v)) return v as { file_token: string; name: string }[];
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p as { file_token: string; name: string }[];
    } catch {
      /* ignore */
    }
  }
  return [];
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  optionLabels,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
  /** 值 → 显示名（见 CrudColumn.filterOptionLabels）：只影响显示，提交的仍是值本身 */
  optionLabels?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useTranslations();
  const tl = useTl();
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="filter-select" ref={ref}>
      <button type="button" className="filter-select-trigger" onClick={() => setOpen(!open)}>
        <span>{label}{value ? `：${tl(optionLabels?.[value] ?? value)}` : ''}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="filter-select-dropdown">
          <div className={`filter-select-opt${!value ? ' active' : ''}`} onClick={() => { onChange(''); setOpen(false); }}>{t('crud.all')}</div>
          {options.map((o) => (
            <div key={o} className={`filter-select-opt${o === value ? ' active' : ''}`} onClick={() => { onChange(o); setOpen(false); }}>{tl(optionLabels?.[o] ?? o)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 50,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto',
};
const modalStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14,
  width: 'min(880px, 100%)', boxShadow: 'var(--shadow-modal)',
};
const rowActions: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' };

/**
 * 卫瓴联系人选项缓存（模块级）。
 * 联系人 3663 条，一次要翻 8 页（pageSize 500）—— 进页面只拉一次，之后新建/编辑表单
 * 与翻页都复用同一份，避免每次打开表单都打十几秒的请求。
 */
let weilingContactCache: { value: string; label: string }[] | null = null;

export default function CrudPage({ title, subtitle, columns, api, statusField, transitions, statusClass, extraActions, readonly, rangeFilters, search, passthroughParams, inlineEdit, standaloneForm, renderForm, onEditingChange, pageSize, extraLinks, createHref, editHref, detailHref, studentDetailHref, rowExtraActions, formExtraActions, hideCreate, selection, onSelectionChange, backHref, enrichEditRow, onRowsLoaded, moduleKey, enrichPrefill, bulkActions, columnSettings, autoRefresh, onInlineSwitch, hideActions, studentNameKeys }: CrudPageProps) {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  // 每页条数可由用户在分页条上切换（默认沿用 props.pageSize，缺省 10）。
  // 切换后 buildParams → fetchPage → reload 链路自动重建，reload 的 effect 会重置游标并回到第 1 页。
  const [size, setSize] = useState(pageSize ?? 10);
  const PAGE_SIZE = size;
  const [page, setPage] = useState(1);
  const tokenStack = useRef<(string | undefined)[]>([]); // tokenStack[i] = 拉取第 i+1 页所需的 pageToken
  const fallbackRef = useRef<Record<string, unknown>[] | null>(null); // 后端一次性返回全部时的前端切片兜底
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  /**
   * 报表下钻：URL 上带的筛选条件在挂载时写入筛选状态。
   * 只认四类参数 —— 列筛选键、时间区间参数、关键字 q、以及调用方声明的透传参数，
   * 其它参数一律忽略；URL 上没有参数时完全不改行为，所以其它模块不受影响。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location.search);
    if (!Array.from(qs.keys()).length) return;
    const colKeys = new Set(columns.filter((c) => c.filter).map((c) => c.filterParam ?? c.key));
    const rangeKeys = new Set((rangeFilters ?? []).flatMap((r) => [r.fromParam, r.toParam]));
    const passKeys = new Set(passthroughParams ?? []);
    const init: Record<string, string> = {};
    for (const [k, v] of Array.from(qs.entries())) {
      if (!v) continue;
      if ((k === 'q' && search) || colKeys.has(k) || rangeKeys.has(k) || passKeys.has(k)) init[k] = v;
    }
    if (Object.keys(init).length) setFilters((prev) => ({ ...prev, ...init }));
    // 只在挂载时读一次：之后用户手动改筛选不应被 URL 覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [editing, setEditing] = useState<null | { mode: 'create' | 'edit'; row?: Record<string, unknown> }>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txMenu, setTxMenu] = useState<string | null>(null);
  const [dicts, setDicts] = useState<Record<string, string[]>>({});
  /** 字典元数据（/meta）：含旧值→当前名 resolve 映射，用于把存量旧值解析为当前展示名 */
  const [dictMeta, setDictMeta] = useState<DictMeta | null>(null);
  /** 行级自定义操作的加载态：key = `${rowId}:${label}` */
  const [rowActionBusy, setRowActionBusy] = useState<string | null>(null);
  /**
   * 是否校验必填：**只有笔记转换进入的新建态才校验**。
   * 转换的诉求就是「用户补完必填即可保存」，缺了校验会静默存进孤儿记录
   * （家校沟通缺「关联学生」在飞书侧并不报错）。
   * 普通新建不改行为 —— required 历史上只渲染红色星号，全站 30+ 模块都依赖这个宽松行为。
   */
  const strictRequiredRef = useRef(false);
  /**
   * 当前转换的留痕记录 id。非空表示「这次新建是从笔记转换进来的」，
   * 保存成功后要把生成的业务记录 id 回填过去。
   */
  const convertLogIdRef = useRef('');
  /**
   * 本次转换的**来源笔记**。非空表示「是从笔记转进来的」，保存成功后除了回填留痕，
   * 还要把笔记关联到新生成的业务记录上 —— 否则详情页的「关联笔记」面板查不到任何东西，
   * 来源就断了（2026-09-11 实测：convert-log 写了，但 /getnote/links 返回 []）。
   */
  const convertNoteRef = useRef<{ noteId: string; noteTitle: string; moduleLabel: string } | null>(null);
  /** 用 ref 持有 onRowsLoaded：调用方常传内联函数，直接进依赖数组会每次渲染都触发 */
  const onRowsLoadedRef = useRef(onRowsLoaded);
  onRowsLoadedRef.current = onRowsLoaded;
  useEffect(() => {
    onRowsLoadedRef.current?.(items);
  }, [items]);
  /** 一键读取本机 WiFi 的加载态 */
  const [wifiBusy, setWifiBusy] = useState(false);
  /** 表单内自定义动作（formExtraActions）的加载态与结果 banner */
  const [formActionBusy, setFormActionBusy] = useState<string | null>(null);
  const [formActionMsg, setFormActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  /** 选择模式：已选行（跨页保留，以 row.id 为键） */
  const [selectedRows, setSelectedRows] = useState<Map<string, Record<string, unknown>>>(new Map());
  /** 被用户在「列设置」里勾掉的列（按 moduleKey 记忆到浏览器） */
  const [hiddenCols, setHiddenCols] = useState<string[]>([]);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  /** 自动刷新间隔（秒），0 = 关闭 */
  const [autoSec, setAutoSec] = useState(0);
  const [bulkBusy, setBulkBusy] = useState('');
  /** 行内开关的忙碌标记：key = `${行 id}:${字段}` */
  const [switchBusy, setSwitchBusy] = useState('');
  /** 自动刷新要判断「是否正在编辑」，用 ref 拿最新值，避免把 editing 塞进 interval 依赖 */
  const editingRef = useRef(false);
  useEffect(() => {
    editingRef.current = Boolean(editing);
  }, [editing]);

  useEffect(() => {
    if (!columnSettings || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(`crud-cols:${moduleKey ?? title}`);
      if (raw) setHiddenCols(JSON.parse(raw) as string[]);
    } catch {
      /* 历史坏数据忽略 */
    }
  }, [columnSettings, moduleKey, title]);

  /** 勾选/取消某一列；不允许把所有列都藏掉（否则表格空白且无法恢复） */
  const toggleCol = useCallback(
    (key: string) => {
      setHiddenCols((prev) => {
        const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
        const visible = columns.filter((c) => c.list !== false);
        if (visible.filter((c) => !next.includes(c.key)).length < 1) return prev;
        try {
          window.localStorage.setItem(`crud-cols:${moduleKey ?? title}`, JSON.stringify(next));
        } catch {
          /* 隐私模式下写不了，忽略 */
        }
        return next;
      });
    },
    [columns, moduleKey, title],
  );
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  useEffect(() => {
    onSelRef.current?.(Array.from(selectedRows.values()));
  }, [selectedRows]);

  const router = useRouter();
  const t = useTranslations();
  // 业务文案（页面传入的 title/列名/字段名/按钮/占位符）以中文原文为 key，
  // 中文环境 fallback 回原文，英文环境返回 labels 命名空间映射的英文。
  const tl = useTl();

  // 模块级按钮门控：module:<key>:<action>。提供 moduleKey 时按权限点控制；
  // 未提供则沿用 readonly/hideCreate 的旧行为（向后兼容）。
  const perms = usePermissions();
  const modOk = (action: string) => (moduleKey ? perms.includes(`module:${moduleKey}:${action}`) : true);
  const canCreate = !readonly && !hideCreate && modOk('create');
  const canUpdate = !readonly && modOk('update');
  const canDelete = !readonly && modOk('delete');
  const canExport = !readonly && modOk('export');
  /**
   * 导入按钮：优先用页面显式提供的 api.importRows；否则若该模块由通用 CRUD 承载
   * （MODULE_RESOURCES.genericCrud），自动接线到 POST /<path>/import，做到「导入」
   * 不需要逐页手写、与导出/刷新统一风格。按钮可见性仍由 module:<key>:import 门控。
   */
  const modRes = moduleKey ? MODULE_RESOURCES.find((r) => r.key === moduleKey) : undefined;
  const autoImportRows = modRes?.genericCrud
    ? async (rows: Record<string, unknown>[]) =>
        globalApi.post<{ ok: number; failed: number }>(`/${modRes.path}/import`, { rows })
    : undefined;
  const importRowsFn = api.importRows ?? autoImportRows;
  const canImport = !readonly && !!importRowsFn && modOk('import');

  const filterCols = columns.filter((c) => c.filter);
  const formCols = columns.filter((c) => c.form);
  const listCols = columns
    .filter((c) => c.list !== false && !hiddenCols.includes(c.key))
    .sort((a, b) => (a.listOrder ?? Infinity) - (b.listOrder ?? Infinity));
  const showingInlineForm = Boolean(inlineEdit && editing);
  const showingStandaloneForm = Boolean(standaloneForm && editing);

  // 选择模式辅助：以 row.id 为键，跨页保留已选；提供本页全选/反选与单选切换
  const selKey = (r: Record<string, unknown>) => String(r.id);
  const pageIds = items.map(selKey);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedRows.has(id));
  const someOnPageSelected = pageIds.some((id) => selectedRows.has(id));
  const showActions = !hideActions;
  const colCount = listCols.length + (showActions ? 1 : 0) + (selection ? 1 : 0);
  const toggleRow = (row: Record<string, unknown>) => {
    const id = selKey(row);
    setSelectedRows((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, row);
      return next;
    });
  };
  const togglePage = () => {
    setSelectedRows((prev) => {
      const next = new Map(prev);
      if (allOnPageSelected) pageIds.forEach((id) => next.delete(id));
      else items.forEach((r) => next.set(selKey(r), r));
      return next;
    });
  };

  useEffect(() => {
    onEditingChange?.(!!editing);
  }, [editing, onEditingChange]);

  // 用 ref 持有最新的 api / filters / rangeFilters，避免 load 因这些依赖变化而反复重建，
  // 否则每次渲染都会重新触发拉取 -> 页面（尤其按姓名搜索时）不停刷新闪烁。
  const apiRef = useRef(api); apiRef.current = api;
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const rangeRef = useRef(rangeFilters); rangeRef.current = rangeFilters;
  const passRef = useRef(passthroughParams); passRef.current = passthroughParams;

  const buildParams = useCallback(
    (token?: string): Record<string, string | undefined> => {
      const f = filtersRef.current;
      const params: Record<string, string | undefined> = { pageSize: String(PAGE_SIZE) };
      for (const c of columns.filter((x) => x.filter)) {
        const key = c.filterParam ?? c.key;
        const v = f[key];
        if (!v) continue;
        // filterOp: 'contains' → 传 `<字段>__contains`，后端按 ILIKE 模糊匹配。
        // filterParam 已自带后缀（如 `所属单元__has` / 审计页的 `actor`）时不再叠加。
        const useContains = c.filterOp === 'contains' && !key.includes('__');
        params[useContains ? `${key}__contains` : key] = v;
      }
      for (const rf of rangeRef.current ?? []) {
        if (f[rf.fromParam]) params[rf.fromParam] = f[rf.fromParam];
        if (f[rf.toParam]) params[rf.toParam] = f[rf.toParam];
      }
      // 无筛选控件的隐藏条件（报表下钻），原样透传
      for (const k of passRef.current ?? []) {
        if (f[k]) params[k] = f[k];
      }
      if (f.q) params.q = f.q;
      if (token) params.pageToken = token;
      return params;
    },
    [PAGE_SIZE],
  );

  /** 拉取指定页（token 已知时直接拉；拉取后用返回 token 续填下一页游标） */
  const fetchPage = useCallback(
    async (target: number, token?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRef.current.list(buildParams(token));
        setTotal(res.total);
        // 后端若一次性返回超过一页（如审计日志深度筛选），改为前端切片分页
        if (!res.pageToken && res.items.length > PAGE_SIZE) {
          fallbackRef.current = res.items;
          setItems(res.items.slice(0, PAGE_SIZE));
        } else {
          fallbackRef.current = null;
          setItems(res.items);
          tokenStack.current[target] = res.pageToken; // 第 target 页之后的游标
        }
        setPage(target);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t('common.loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [buildParams],
  );

  /** 跳转到目标页：若游标未知则向前逐页补全（不渲染中间页），再拉取目标页 */
  const goToPage = useCallback(
    async (target: number) => {
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      target = Math.min(Math.max(target, 1), totalPages);
      if (fallbackRef.current) {
        setItems(fallbackRef.current.slice((target - 1) * PAGE_SIZE, target * PAGE_SIZE));
        setPage(target);
        return;
      }
      if (target - 1 < tokenStack.current.length) {
        await fetchPage(target, tokenStack.current[target - 1]);
        return;
      }
      for (let p = tokenStack.current.length; p < target; p++) {
        const data = await apiRef.current.list(buildParams(tokenStack.current[p - 1]));
        tokenStack.current[p] = data.pageToken;
      }
      await fetchPage(target, tokenStack.current[target - 1]);
    },
    [total, PAGE_SIZE, fetchPage, buildParams],
  );

  /** 重置分页并从第 1 页重新加载（筛选/搜索变化、增删改后调用） */
  const reload = useCallback(() => {
    tokenStack.current = [];
    fallbackRef.current = null;
    fetchPage(1, undefined);
  }, [fetchPage]);

  useEffect(() => { reload(); }, [filters, reload]);

  /**
   * 自动刷新：只在「页面可见 + 没打开表单」时轮询。
   * 后台标签页与编辑中都不刷 —— 否则用户正在填表，一刷新列表把上下文打散。
   */
  useEffect(() => {
    if (!autoSec || !autoRefresh?.length) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !editingRef.current) void reload();
    }, autoSec * 1000);
    return () => window.clearInterval(timer);
  }, [autoSec, autoRefresh, reload]);

  /** 「全选所有结果」：按当前筛选把全部命中的行拉进已选（上限 500，够内部规模） */
  const selectAllResults = useCallback(async () => {
    try {
      const res = await api.list({ ...buildParams(), pageSize: '500' });
      setSelectedRows((prev) => {
        const next = new Map(prev);
        for (const r of res.items ?? []) next.set(String(r.id), r);
        return next;
      });
    } catch {
      /* 拉不到就保持现状，不弹错打断操作 */
    }
  }, [api, buildParams]);

  /** 执行一个批量动作：确认 → 调回调 → 刷新 → 清空选择 */
  const runBulk = useCallback(
    async (a: NonNullable<CrudPageProps['bulkActions']>[number]) => {
      const rows = Array.from(selectedRows.values());
      if (!rows.length) return;
      const text = (a.confirm ?? (a.danger ? `确认对选中的 {n} 项执行「${a.label}」？此操作不可撤销。` : '')).replace(
        '{n}',
        String(rows.length),
      );
      if (text && !window.confirm(text)) return;
      setBulkBusy(a.label);
      try {
        await a.run(rows, () => reload());
        setSelectedRows(new Map());
      } finally {
        setBulkBusy('');
      }
    },
    [selectedRows, reload],
  );

  // 字典表候选项（供带 dictKey 的字段使用），加载前用字段自带 options 兜底。
  // 同时拉取 /meta（含 resolve 映射），用于把存量旧值/别名解析为当前展示名。
  useEffect(() => {
    if (!columns.some((c) => c.dictKey)) return;
    let alive = true;
    apiClient
      .dictionaryMeta()
      .then((m) => {
        if (!alive) return;
        setDictMeta(m);
        // 下拉候选项用当前 labels（与旧 /dictionaries 端点一致）
        const labels: Record<string, string[]> = {};
        for (const [k, opts] of Object.entries(m.options)) labels[k] = opts.map((o) => o.label);
        setDicts(labels);
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  // 人员字段（person）候选项：从用户管理读取姓名列表（供内部对接人等下拉选择）
  const [userNames, setUserNames] = useState<string[]>([]);
  useEffect(() => {
    if (!columns.some((c) => c.type === 'person')) return;
    let alive = true;
    const collected: string[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const params: Record<string, string | undefined> = { pageSize: '100' };
      if (token) params.pageToken = token;
      // ⚠️ 用 /users/names（全员可读）而不是 listUsers（需 admin:user）：
      // 一线老师/教务没有 admin:user，用后者会 403、下拉永远为空（2026-09-11 实测）。
      const names = await apiClient.listUserNames();
      for (const n of names) if (n) collected.push(n);
    };
    fetchPage()
      .then(() => { if (alive) setUserNames(Array.from(new Set(collected))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [columns]);

  // 学生字段（student / studentLink / parent 联动）候选项：从学生档案读取「学生姓名 → 父亲/母亲 + record id」
  const [studentOptions, setStudentOptions] = useState<{ value: string; label: string }[]>([]);
  const [studentLinkOptions, setStudentLinkOptions] = useState<{ value: string; label: string }[]>([]);
  const [studentMap, setStudentMap] = useState<Record<string, { father: string; mother: string }>>({});
  const [studentIdByName, setStudentIdByName] = useState<Record<string, string>>({});
  /** 学生姓名 → 英文名：列表里学生列要显示「中文名 / 英文名」，表单下拉已带英文名，这里补列表用 */
  const [studentEnglishByName, setStudentEnglishByName] = useState<Record<string, string>>({});
  useEffect(() => {
    const needStudentMap =
      columns.some((c) => c.type === 'student' || c.type === 'studentLink' || c.type === 'parent') ||
      Boolean(studentNameKeys?.length);
    if (!needStudentMap) return;
    let alive = true;
    const collected: { id: string; name: string; englishName: string; father: string; mother: string }[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const params: Record<string, string | undefined> = { pageSize: '100' };
      if (token) params.pageToken = token;
      const p = await apiClient.listStudents(params);
      for (const s of p.items) {
        const name = String(s['学生姓名'] ?? '');
        const id = String((s as { id?: string }).id ?? '');
        if (name && id) collected.push({
          id,
          name,
          englishName: String(s['英文名'] ?? ''),
          father: String(s['父亲姓名'] ?? ''),
          mother: String(s['母亲姓名'] ?? ''),
        });
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => {
        if (!alive) return;
        const map: Record<string, { father: string; mother: string }> = {};
        const idByName: Record<string, string> = {};
        const enByName: Record<string, string> = {};
        for (const s of collected) {
          map[s.name] = { father: s.father, mother: s.mother };
          idByName[s.name] = s.id;
          if (s.englishName) enByName[s.name] = s.englishName;
        }
        setStudentMap(map);
        setStudentIdByName(idByName);
        setStudentEnglishByName(enByName);
        const seen = new Set<string>();
        const opts = collected
          .filter((s) => {
            if (seen.has(s.name)) return false;
            seen.add(s.name);
            return true;
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        setStudentOptions(opts.map((s) => ({ value: s.name, label: s.englishName ? `${s.name} / ${s.englishName}` : s.name })));
        setStudentLinkOptions(opts.map((s) => ({ value: s.id, label: s.englishName ? `${s.name} / ${s.englishName}` : s.name })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [columns, studentNameKeys]);

  // 学生列补英文名：把「中文名 → 英文名」以 __studentEnglish 注入行上，
  // 这样既有通用单元格渲染、也有各模块自定义 render（如家校沟通的学生列）都能显示双语。
  const studentCols = useMemo(
    () => [
      ...columns.filter((c) => c.type === 'student' || c.type === 'studentLink').map((c) => c.key),
      // 值本身是学生姓名的列（如「疑似关联学生」）也要参与注入
      ...(studentNameKeys ?? []),
    ],
    [columns, studentNameKeys],
  );
  const rows = useMemo(() => {
    if (!studentCols.length) return items;
    // 英文名与记录 id 都要注入：有的学生没英文名，但「姓名可点击跳详情」依然需要 id
    if (!Object.keys(studentEnglishByName).length && !Object.keys(studentIdByName).length) return items;
    return items.map((r) => {
      for (const k of studentCols) {
        const n = str(r[k]);
        if (!n) continue;
        const en = studentEnglishByName[n] ?? '';
        const refId = studentIdByName[n] ?? '';
        if (!en && !refId) continue;
        return {
          ...r,
          ...(en ? { [STUDENT_ENGLISH_KEY]: en } : {}),
          ...(refId ? { [STUDENT_REF_KEY]: refId } : {}),
        };
      }
      return r;
    });
  }, [items, studentCols, studentEnglishByName, studentIdByName]);

  // 卫瓴联系人候选项（招生跟进的「关联联系人」）：value=contact_id，label=姓名｜手机号。
  // 存 id 而不是姓名：联系人有重名、也会改名，存 id 由后端解析显示才不会串。
  const [weilingContactOptions, setWeilingContactOptions] = useState<{ value: string; label: string }[]>(
    () => weilingContactCache ?? [],
  );
  useEffect(() => {
    if (!columns.some((c) => c.type === 'weilingContact')) return;
    if (weilingContactCache) {
      setWeilingContactOptions(weilingContactCache);
      return;
    }
    let alive = true;
    const collected: { value: string; label: string }[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const p = await apiClient.listWeilingContacts({ pageSize: '500', pageToken: token });
      for (const r of p.items ?? []) {
        const id = String(r['id'] ?? '');
        const name = String(r['联系人姓名'] ?? '');
        if (!id || !name) continue;
        const phone = String(r['手机号'] ?? '');
        collected.push({ value: id, label: phone ? `${name}｜${phone}` : name });
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => {
        if (!alive) return;
        collected.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
        weilingContactCache = collected;
        setWeilingContactOptions(collected);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [columns]);

  // 部门字段（department）候选项：从「组织管理 / 部门管理」读取已同步的飞书部门树
  // （已删除部门 status='invalid' 不出现在树中，这里也一并过滤掉）
  const [departmentOptions, setDepartmentOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (!columns.some((c) => c.type === 'department')) return;
    let alive = true;
    apiClient
      .listDepartments()
      .then((res) => {
        if (!alive) return;
        const items = (res?.items ?? []).filter((d) => d.status !== 'invalid');
        setDepartmentOptions(items.map((d) => ({ value: d.name, label: d.name })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [columns]);

  /** 字段有效候选项：优先字典，其次字段 options */
  const optionsFor = (c: CrudColumn): string[] =>
    c.dictKey ? (dicts[c.dictKey] ?? c.options ?? []) : (c.options ?? []);

  /**
   * @param prefill 预填值（笔记转换用）。只覆盖表单里真实存在的字段，
   *   未知字段一律丢弃 —— 否则会把笔记的 title/content 之类写进飞书表导致报错。
   */
  function openCreate(prefill?: Record<string, unknown>) {
    strictRequiredRef.current = false;
    const init: Record<string, unknown> = {};
    for (const c of formCols) {
      if (c.type === 'map') {
        if (c.latKey) init[c.latKey] = '';
        if (c.lngKey) init[c.lngKey] = '';
      } else {
        init[c.key] = c.type === 'multiselect' || c.type === 'attachment' || c.type === 'tags' ? [] : '';
      }
    }
    if (prefill) {
      for (const c of formCols) {
        if (prefill[c.key] !== undefined && prefill[c.key] !== null) init[c.key] = prefill[c.key];
      }
    }
    setForm(init);
    setEditing({ mode: 'create' });
    setError(null);
    setFormActionMsg(null);
  }

  /**
   * 笔记转换落地：URL 带 `?acmsConvert=1` 时消费一次 sessionStorage 里的预填值，
   * 直接进入新建态并填好字段。
   *
   * 做在 CrudPage 里而不是各个业务页里，是为了让**所有用 CrudPage 的模块自动具备
   * 预填能力** —— 未来新开发的模块只要在转换配置里登记字段映射即可，不用改代码。
   *
   * ⚠️ 用 window.location.search 而非 useSearchParams：后者在 App Router 下要求
   * 整页包 Suspense，会把所有列表页都卷进去，代价不值得。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (readonly || hideCreate) return;
    const flag = new URLSearchParams(window.location.search).get(CONVERT_QUERY_FLAG);
    if (flag !== CONVERT_QUERY_VALUE) return;
    const payload = takeConvertPayload();
    // 清掉 URL 标记：payload 已经读走，留着标记会让刷新/分享链接时行为诡异
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch { /* ignore */ }
    if (!payload) return;
    convertLogIdRef.current = payload.logId ?? '';
    convertNoteRef.current = payload.noteId
      ? { noteId: String(payload.noteId), noteTitle: String(payload.noteTitle ?? ''), moduleLabel: payload.label }
      : null;
    // 预填增强：让目标模块从长文本里再解析出结构化字段（解析失败就退回原值）。
    // 先取登录用户名：沟通人/观察人这类字段的默认值就是当前用户（笔记谁录的，跟进人就是谁）。
    void (async () => {
      let values = payload.values ?? {};
      if (enrichPrefill) {
        const userName = await currentUserName();
        try {
          values = enrichPrefill(values, { userName });
        } catch {
          /* 解析失败不影响预填 */
        }
      }
      openCreate(values);
      // 必须在 openCreate 之后设：openCreate 会把它重置为 false
      strictRequiredRef.current = true;
    })();
    // 仅在挂载时执行一次：openCreate 每次渲染都是新函数，进依赖数组会反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 猜一条记录的可读标题（写关联表时作为 entityName，仅用于事后核对）。
   * 各模块标题字段不统一，按常见度依次尝试，都没有就留空。
   */
  function titleOf(values: Record<string, unknown>): string {
    for (const k of ['会议议题', '沟通主题', '标题', '名称', '学生姓名', '活动名称']) {
      const v = values[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  function openEdit(row: Record<string, unknown>) {
    const init: Record<string, unknown> = {};
    for (const c of formCols) {
      if (c.type === 'map') {
        if (c.latKey) init[c.latKey] = row[c.latKey] ?? '';
        if (c.lngKey) init[c.lngKey] = row[c.lngKey] ?? '';
      } else if (c.type === 'attachment') init[c.key] = attachmentFiles(row[c.key]);
      else if (c.type === 'multiselect')
        init[c.key] = (Array.isArray(row[c.key]) ? row[c.key] : str(row[c.key]).split('、').filter(Boolean));
      else if (c.type === 'tags')
        init[c.key] = Array.isArray(row[c.key]) ? row[c.key] : str(row[c.key]).split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
      else if (c.type === 'link' && c.linkMulti) {
        // 多选关联：__link 里是全部 id
        const ids = row[c.key + '__link'];
        init[c.key] = Array.isArray(ids) ? ids : [];
      } else if (c.type === 'studentLink' || c.type === 'weilingContact' || c.type === 'link') {
        // 行中关联字段已被后端解析为可读名，但 __link 仍保留 record id —— 必须用 id 回填选择器，
        // 否则编辑时把「姓名」当 id 提交，保存后关联就断了。
        const linkIds = row[c.key + '__link'];
        init[c.key] = (Array.isArray(linkIds) && linkIds[0]) || '';
      } else init[c.key] = row[c.key] ?? '';
    }
    setForm(init);
    setEditing({ mode: 'edit', row });
    setError(null);
    setFormActionMsg(null);
    // 预拉取详情合并额外字段（如 Get笔记 原始记录仅 detail 返回）。失败则保留列表行初始值。
    if (enrichEditRow) {
      enrichEditRow(row)
        .then((full) => {
          if (!full) return;
          setForm((f) => {
            const merged = { ...f };
            for (const c of formCols) {
              if (full[c.key] !== undefined) merged[c.key] = full[c.key];
            }
            return merged;
          });
        })
        .catch(() => {
          /* 保持列表行初始值，不影响编辑 */
        });
    }
  }

  /** 自定义表单（renderForm）保存成功后的收尾：关闭表单并刷新列表 */
  function handleFormDone() {
    setEditing(null);
    reload();
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    // 笔记转换进入的新建态才校验必填，普通新建维持历史行为（不校验）
    if (strictRequiredRef.current) {
      const missing = formCols
        .filter((c) => {
          if (!c.required) return false;
          const v = form[c.key];
          if (Array.isArray(v)) return v.length === 0;
          return v === '' || v == null;
        })
        .map((c) => tl(c.label));
      if (missing.length) {
        setError(t('crud.fillRequired', { fields: missing.join('、') }));
        setSubmitting(false);
        return;
      }
    }
    try {
      const payload: Record<string, unknown> = {};
      for (const c of formCols) {
        const v = form[c.key];
        if (c.type === 'map') {
          // 经纬度已写入 latKey/lngKey 子字段，这里直接取子字段并转为数字
          if (c.latKey) payload[c.latKey] = form[c.latKey] === '' || form[c.latKey] == null ? undefined : Number(form[c.latKey]);
          if (c.lngKey) payload[c.lngKey] = form[c.lngKey] === '' || form[c.lngKey] == null ? undefined : Number(form[c.lngKey]);
        } else if (c.type === 'multiselect') payload[c.key] = Array.isArray(v) ? v : [];
        else if (c.type === 'tags') payload[c.key] = Array.isArray(v) && v.length ? (v as string[]).join('\n') : undefined;
        else if (c.type === 'attachment') payload[c.key] = Array.isArray(v) && (v as unknown[]).length ? JSON.stringify(v) : undefined;
        else if (c.type === 'number') payload[c.key] = v === '' || v == null ? undefined : Number(v);
        else payload[c.key] = v === '' ? undefined : v;
      }
      if (editing?.mode === 'create') {
        const created = api.create
          ? ((await api.create(payload)) as Record<string, unknown> | undefined)
          : undefined;
        // 转换场景：把生成的业务记录 id 回填留痕，日后能直接跳到「转成的那条记录」。
        // 回填失败不影响业务记录本身 —— 它已经存下来了，所以这里静默降级。
        const logId = convertLogIdRef.current;
        if (logId && created) {
          const newId = String(created.id ?? created.recordId ?? '');
          if (newId) {
            try {
              await globalApi.linkNoteConvert(logId, newId);
            } catch { /* 留痕回填失败不阻断业务 */ }
            // 同时把笔记关联到这条新记录：详情页「关联笔记」面板与笔记侧都靠这张关联表反查，
            // 只写留痕会导致查无关联、来源不可追溯。关联是全量覆盖式写入，
            // 新建场景这条笔记就是唯一来源，直接传 [note]。
            const note = convertNoteRef.current;
            if (note?.noteId) {
              try {
                await globalApi.replaceGetnoteLinks(note.moduleLabel, newId, titleOf(payload), [
                  { noteId: note.noteId, title: note.noteTitle },
                ]);
              } catch { /* 关联失败不阻断业务 */ }
              convertNoteRef.current = null;
            }
            convertLogIdRef.current = '';
          }
        }
      } else if (editing?.row && api.update) await api.update(String(editing.row.id), payload);
      setEditing(null);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(row: Record<string, unknown>) {
    if (!api.archive) return;
    if (!confirm(t('crud.confirmDelete', { name: String(str(row[columns[0]?.key ?? 'id'])) }))) return;
    try {
      await api.archive(String(row.id));
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('crud.deleteFailed'));
    }
  }

  async function doTransition(row: Record<string, unknown>, to: string) {
    if (!api.transition) return;
    try {
      await api.transition(String(row.id), to);
      setTxMenu(null);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.statusChangeFailed'));
    }
  }

  async function runRowAction(row: Record<string, unknown>, action: { label: string; run: (row: Record<string, unknown>, reload: () => void) => void | Promise<void> }) {
    const key = `${String(row.id)}:${action.label}`;
    if (rowActionBusy) return;
    setRowActionBusy(key);
    setError(null);
    try {
      await action.run(row, () => reload());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.operationFailed'));
    } finally {
      setRowActionBusy(null);
    }
  }

  /** 表单内自定义动作（formExtraActions）：拿到当前表单字段快照，执行后若返回 {ok,text} 则在表单内展示结果 banner */
  async function runFormAction(action: {
    label: string;
    run: (values: Record<string, unknown>, close: () => void) => void | Promise<{ ok: boolean; text?: string } | void>;
  }) {
    if (formActionBusy) return;
    setFormActionMsg(null);
    setFormActionBusy(action.label);
    try {
      const r = await action.run(form, () => setEditing(null));
      if (r && typeof r === 'object' && 'ok' in r) {
        setFormActionMsg({ ok: r.ok, text: r.text ?? (r.ok ? t('common.ok') : t('common.failed')) });
      }
    } catch (e: unknown) {
      setFormActionMsg({ ok: false, text: e instanceof Error ? e.message : t('common.operationFailed') });
    } finally {
      setFormActionBusy(null);
    }
  }

  /** 客户端导出当前列表为 CSV（UTF-8 BOM，避免 Excel 乱码） */
  function downloadCsv() {
    const cols = listCols;
    const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = cols.map((c) => esc(tl(c.label))).join(',');
    const body = items.map((row) =>
      cols.map((c) => esc(cellText(row[c.key], c, tl, dictMeta))).join(','),
    );
    const csv = '﻿' + header + '\n' + body.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 解析 CSV（支持双引号转义），首行为表头 */
  function parseCsv(text: string): Record<string, string>[] {
    const splitLine = (line: string): string[] => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
          } else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur);
      return out;
    };
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) return [];
    const headers = splitLine(lines[0]).map((h) => h.trim());
    const labelToKey = new Map(listCols.map((c) => [tl(c.label).trim(), c.key]));
    return lines.slice(1).map((l) => {
      const vals = splitLine(l);
      const o: Record<string, string> = {};
      headers.forEach((h, i) => {
        const key = labelToKey.get(h) ?? h;
        o[key] = vals[i] ?? '';
      });
      return o;
    });
  }

  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (!importRowsFn) throw new Error(t('common.notSupported'));
      const res = await importRowsFn(rows);
      setError(t('crud.importDone', { ok: res.ok, failed: res.failed }));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('crud.importFailed'));
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  }

  /** 一键读取本机当前连接的 WiFi（SSID + 最佳努力 BSSID），填入对应 tags 字段 */
  async function quickFillWifi(c: CrudColumn) {
    setWifiBusy(true);
    setError(null);
    try {
      const res = await fetch('http://127.0.0.1:8787/current-wifi');
      if (!res.ok) throw new Error('bad');
      const data = (await res.json()) as { ssid?: string; bssid?: string };
      const ssid = (data.ssid ?? '').trim();
      if (!ssid) throw new Error('empty');
      setForm((f) => {
        const arr = Array.isArray(f[c.key]) ? (f[c.key] as string[]) : [];
        const next = arr.includes(ssid) ? arr : [...arr, ssid];
        const out: Record<string, unknown> = { ...f, [c.key]: next };
        const b = (data.bssid ?? '').trim();
        if (b) {
          const bkey = 'WiFi_BSSID列表';
          const barr = Array.isArray(f[bkey]) ? (f[bkey] as string[]) : [];
          out[bkey] = barr.includes(b) ? barr : [...barr, b];
        }
        return out;
      });
    } catch {
      setError(t('crud.wifiError'));
    } finally {
      setWifiBusy(false);
    }
  }

  const formFields = (
    <div className="form-grid">
      {formCols.map((c, ci) => (
        <Fragment key={c.key}>
        {/* 分区标题：与上一列分区不同时插入一行（跨整行），让长表单分块可读 */}
        {c.section && c.section !== formCols[ci - 1]?.section ? (
          <div
            style={{
              gridColumn: '1 / -1',
              marginTop: ci === 0 ? 0 : 'var(--space-md)',
              paddingBottom: 6,
              borderBottom: '1px solid var(--border)',
              fontSize: 'var(--font-sm)',
              fontWeight: 600,
              color: 'var(--fg-secondary)',
            }}
          >
            {tl(c.section)}
          </div>
        ) : null}
        <div className="form-label" style={c.type === 'textarea' || c.type === 'markdown' || c.renderField ? { gridColumn: '1 / -1' } : undefined}>
          <span className="form-label-text">{tl(c.label)}{c.required && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
          {c.renderField ? (
            c.renderField({
              value: form[c.key],
              onChange: (v) => setForm((f) => ({ ...f, [c.key]: v })),
              form,
              row: editing?.row ?? null,
              column: c,
            })
          ) : c.type === 'map' ? (
            <MapPicker
              lat={form[c.latKey ?? ''] as string | number}
              lng={form[c.lngKey ?? ''] as string | number}
              onChange={(la, ln) => setForm((f) => ({ ...f, [c.latKey ?? '']: la, [c.lngKey ?? '']: ln }))}
            />
          ) : c.type === 'tags' ? (
            <div>
              <TagInput
                value={Array.isArray(form[c.key]) ? (form[c.key] as string[]) : []}
                onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))}
                options={c.tagOptions}
                placeholder={t('crud.tagPlaceholder')}
                quickAdd={c.tagQuickAdd}
              />
              {c.quickFill === 'wifi' && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ marginTop: 6 }}
                  disabled={wifiBusy}
                  onClick={() => quickFillWifi(c)}
                >
                  {wifiBusy ? t('crud.readingWifi') : t('crud.fillWifi')}
                </button>
              )}
            </div>
          ) : c.type === 'textarea' ? (
            <textarea
              className="form-input"
              value={str(form[c.key])}
              onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}
              rows={c.fieldHeight ? undefined : 3}
              readOnly={c.readonly}
              style={{
                height: c.fieldHeight ? `${c.fieldHeight}px` : undefined,
                resize: 'vertical',
                overflowY: 'auto',
                lineHeight: 1.6,
                ...(c.readonly
                  ? { background: 'var(--bg-subtle)', borderColor: 'var(--border)', color: 'var(--fg)', opacity: 1 }
                  : null),
              }}
            />
          ) : c.type === 'markdown' ? (
            <MarkdownField
              value={str(form[c.key])}
              // 明细专项权限：没配权限点就不限制；配了则必须持有才能输入 / 导入。
              // 两者都无权限时仍可浏览渲染结果，只是改不了。
              onChange={
                c.readonly || (c.mdEditPerm && !perms.includes(c.mdEditPerm))
                  ? undefined
                  : (v) => setForm((f) => ({ ...f, [c.key]: v }))
              }
              canImport={c.mdImportPerm ? perms.includes(c.mdImportPerm) : undefined}
              height={c.fieldHeight ?? 300}
            />
          ) : c.type === 'select' ? (
            <select className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}>
              <option value="">{t('common.notFilled')}</option>
              {optionsFor(c).map((o) => <option key={o} value={o}>{tl(o)}</option>)}
            </select>
          ) : c.type === 'multiselect' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {optionsFor(c).map((o) => {
                const arr = Array.isArray(form[c.key]) ? (form[c.key] as string[]) : [];
                const on = arr.includes(o);
                return (
                  <label key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999, border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'transparent', fontSize: 'var(--font-sm)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.checked ? [...arr, o] : arr.filter((x) => x !== o) }))} />
                    {o}
                  </label>
                );
              })}
            </div>
          ) : c.type === 'number' ? (
            <input className="form-input" type="number" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          ) : c.type === 'person' ? (
            <select className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}>
              <option value="">{t('common.notFilled')}</option>
              {userNames.map((o) => <option key={o} value={o}>{tl(o)}</option>)}
            </select>
          ) : c.type === 'student' ? (
            <Combobox value={str(form[c.key])} onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))} options={studentOptions} placeholder="输入学生姓名筛选…" />
          ) : c.type === 'studentLink' ? (
            <Combobox value={str(form[c.key])} onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))} options={studentLinkOptions} placeholder="输入学生姓名筛选…" />
          ) : c.type === 'weilingContact' ? (
            <Combobox value={str(form[c.key])} onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))} options={weilingContactOptions} placeholder="输入联系人姓名或手机号筛选…" />
          ) : c.type === 'link' && c.linkMulti ? (
            (() => {
              const cur = Array.isArray(form[c.key])
                ? (form[c.key] as unknown[]).map(String)
                : str(form[c.key]).split(',').map((x) => x.trim()).filter(Boolean);
              return (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(c.linkOptions ?? []).map((o) => {
                    const on = cur.includes(o.value);
                    return (
                      <label
                        key={o.value}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 10px',
                          borderRadius: 999,
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                          background: on ? 'var(--accent-soft)' : 'transparent',
                          fontSize: 'var(--font-sm)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              [c.key]: e.target.checked
                                ? [...cur, o.value]
                                : cur.filter((x) => x !== o.value),
                            }))
                          }
                        />
                        {o.label}
                      </label>
                    );
                  })}
                  {(c.linkOptions ?? []).length === 0 ? (
                    <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>暂无可选项</span>
                  ) : null}
                </div>
              );
            })()
          ) : c.type === 'link' ? (
            <Combobox
              value={str(form[c.key])}
              onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))}
              options={c.linkOptions ?? []}
              placeholder={`输入${c.label}筛选…`}
            />
          ) : c.type === 'department' ? (
            <Combobox value={str(form[c.key])} onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))} options={departmentOptions} placeholder="输入部门名称筛选…" />
          ) : c.type === 'parent' ? (
            (() => {
              const dep = form[c.dependsOn ?? ''] as string;
              const sm = studentMap[dep] ?? { father: '', mother: '' };
              const opts = [sm.father, sm.mother].filter(Boolean);
              const listId = `parent-opt-${c.key}`;
              return (
                <>
                  <input className="form-input" list={listId} value={str(form[c.key])} placeholder={t('crud.parentPlaceholder')} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
                  <datalist id={listId}>{opts.map((o) => <option key={o} value={o} />)}</datalist>
                </>
              );
            })()
          ) : c.type === 'attachment' ? (
            <div>
              <input type="file" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const res = await apiClient.uploadFile(file);
                  setForm((f) => ({ ...f, [c.key]: [...(Array.isArray(f[c.key]) ? (f[c.key] as { file_token: string; name: string }[]) : []), { file_token: res.file_token, name: res.name }] }));
                } catch (err) {
                  setError(err instanceof Error ? err.message : t('common.uploadFailed'));
                } finally {
                  e.target.value = '';
                }
              }} />
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(Array.isArray(form[c.key]) ? (form[c.key] as { file_token: string; name: string }[]) : []).map((a, i) => (
                  <div key={a.file_token ?? i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)' }}>
                    <a href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{a.name}</a>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm((f) => ({ ...f, [c.key]: (Array.isArray(f[c.key]) ? (f[c.key] as { file_token: string; name: string }[]) : []).filter((_, j) => j !== i) }))}>{t('crud.remove')}</button>
                  </div>
                ))}
              </div>
            </div>
          ) : c.type === 'date' ? (
            <input className="form-input" type="date" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          ) : c.type === 'datetime' ? (
            <input className="form-input" type="datetime-local" value={toDateTimeLocal(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          ) : c.type === 'password' ? (
            // 凭证字段：后端读取侧恒返回掩码 ******，原样回传 = 不修改；输入新值才覆盖
            <input
              className="form-input"
              type="password"
              autoComplete="new-password"
              value={str(form[c.key])}
              onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}
            />
          ) : (
            <input className="form-input" type="text" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          )}
          {c.hint && <p className="form-hint">{tl(c.hint)}</p>}
        </div>
        </Fragment>
      ))}
    </div>
  );

  return (
    <div className="page">
      {!showingStandaloneForm && (
        <div className="page-header page-header-row">
          {backHref && (
            <Link
              href={backHref}
              className="btn btn-icon"
              title={t('crud.back')}
              aria-label={t('crud.back')}
              style={{ marginRight: 'var(--space-md)' }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
          )}
          <div>
            <h1 className="page-title">{tl(title)}</h1>
            {subtitle && <p className="page-subtitle">{tl(subtitle)}</p>}
          </div>
          <div className="page-actions">
            {extraActions?.map((a) => (
              <button key={a.label} className="btn btn-outline" disabled={loading}
                onClick={() => a.run(() => reload())}>{tl(a.label)}</button>
            ))}
            {extraLinks?.map((l) => (
              <Link key={l.href} href={l.href} className="btn btn-outline">{tl(l.label)}</Link>
            ))}
            {autoRefresh?.length ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{t('crud.autoRefresh')}</span>
                <select
                  className="form-input"
                  style={{ width: 104 }}
                  value={String(autoSec)}
                  onChange={(e) => setAutoSec(Number(e.target.value))}
                >
                  <option value="0">{t('crud.off')}</option>
                  {autoRefresh.map((sec) => (
                    <option key={sec} value={sec}>{sec} {t('crud.seconds')}</option>
                  ))}
                </select>
              </span>
            ) : null}
            {columnSettings ? (
              <span style={{ position: 'relative' }}>
                <button className="btn btn-outline" onClick={() => setColMenuOpen((v) => !v)}>
                  {t('crud.columns')}
                </button>
                {colMenuOpen ? (
                  <span
                    style={{
                      position: 'absolute', right: 0, top: '100%', zIndex: 30, marginTop: 4,
                      display: 'block', padding: 10, width: 210, maxHeight: 320, overflow: 'auto',
                      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                      borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
                    }}
                  >
                    {columns.filter((c) => c.list !== false).map((c) => (
                      <label
                        key={c.key}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 'var(--font-sm)' }}
                      >
                        <input type="checkbox" checked={!hiddenCols.includes(c.key)} onChange={() => toggleCol(c.key)} />
                        {tl(c.label)}
                      </label>
                    ))}
                  </span>
                ) : null}
              </span>
            ) : null}
            {canImport && (
              <>
                <button className="btn btn-outline" disabled={loading || importing} onClick={() => fileInputRef.current?.click()}>
                  {importing ? `${t('crud.importing')}…` : t('crud.import')}
                </button>
                <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImportFile} />
              </>
            )}
            {canExport && (
              <button className="btn btn-outline" disabled={loading || items.length === 0} onClick={downloadCsv}>
                {t('crud.export')}
              </button>
            )}
            <button className="btn btn-ghost" disabled={loading} onClick={() => reload()} title={t('crud.refresh')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
            </button>
            {canCreate && (createHref ? (
              <Link href={createHref} className="btn btn-primary">+ {t('crud.create')}</Link>
            ) : (
              <button className="btn btn-primary" onClick={() => openCreate()} disabled={loading || readonly}>+ {t('crud.create')}</button>
            ))}
          </div>
        </div>
      )}

      {!showingStandaloneForm && (filterCols.length > 0 || (rangeFilters ?? []).length > 0 || search) && (
        <div className="filter-bar">
          {search && (
            <form
              className="search-bar"
              style={{ flex: 1, minWidth: 200, maxWidth: 360 }}
              onSubmit={(e) => { e.preventDefault(); reload(); }}
            >
              <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
              <input
                placeholder={tl(search.placeholder)}
                value={filters.q ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              />
              <button type="submit">{t('common.search')}</button>
            </form>
          )}
          {filterCols.map((c) =>
            c.filterType === 'text' ? (
              <input
                key={c.key}
                className="form-input"
                style={{ width: c.filterWidth ?? 160 }}
                placeholder={c.filterPlaceholder ? tl(c.filterPlaceholder) : t('crud.filterBy', { label: tl(c.label) })}
                value={filters[c.filterParam ?? c.key] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [c.filterParam ?? c.key]: e.target.value }))}
              />
            ) : (
              <FilterSelect key={c.key} label={tl(c.label)} value={filters[c.key] ?? ''}
                optionLabels={c.filterOptionLabels}
                onChange={(v) => setFilters((f) => ({ ...f, [c.key]: v }))}
                options={c.filterOptions ?? (c.dictKey ? (dicts[c.dictKey] ?? c.options ?? []) : c.type === 'department' ? departmentOptions.map((d) => d.value) : (c.options ?? []))} />
            ),
          )}
          {(rangeFilters ?? []).map((rf) => (
            <span key={rf.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{tl(rf.label)}</span>
              <input className="form-input" type="date" style={{ width: 150 }}
                value={filters[rf.fromParam] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [rf.fromParam]: e.target.value }))} />
              <span style={{ color: 'var(--fg-tertiary)' }}>~</span>
              <input className="form-input" type="date" style={{ width: 150 }}
                value={filters[rf.toParam] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [rf.toParam]: e.target.value }))} />
            </span>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters({})}>{t('crud.reset')}</button>
        </div>
      )}

      {showingInlineForm && editing && (
        <div className="crud-inline-form">
          <div className="crud-inline-form-head">
            {showingStandaloneForm ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
                <button className="btn btn-icon" title={t('crud.back')} aria-label={t('crud.back')} onClick={() => setEditing(null)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <div>
                  <div className="page-eyebrow">{editing.mode === 'create' ? 'CREATE' : 'EDIT'} / {tl(title)}</div>
                  <h1 className="page-title">{editing.mode === 'create' ? `${t('crud.create')}${tl(title)}` : `${t('crud.edit')}${tl(title)}`}</h1>
                </div>
              </div>
            ) : (
              <>
                <h3 className="crud-inline-form-title">{editing.mode === 'create' ? `${t('crud.create')}${tl(title)}` : `${t('crud.edit')}${tl(title)}`}</h3>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>×</button>
              </>
            )}
          </div>
          {renderForm ? (
            renderForm({ row: editing.row ?? null, onDone: handleFormDone })
          ) : (
            <>
              {error && <p className="msg-error">{error}</p>}
              <fieldset className="form-fieldset">
                <legend className="form-legend">{title} {t('crud.info')}</legend>
                {formFields}
              </fieldset>
              <div className="crud-inline-form-actions">
                {formExtraActions?.map((a) => (
                  <button
                    key={a.label}
                    className="btn btn-outline"
                    disabled={Boolean(formActionBusy) || submitting}
                    onClick={() => void runFormAction(a)}
                  >
                    {formActionBusy === a.label ? `${a.label}…` : a.label}
                  </button>
                ))}
                <button className="btn btn-ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                <button className="btn btn-primary" onClick={submit} disabled={submitting}>{submitting ? t('common.saving') : t('common.save')}</button>
              </div>
              {formActionMsg && (
                <p className={formActionMsg.ok ? 'msg-ok' : 'msg-error'}>{formActionMsg.text}</p>
              )}
            </>
          )}
        </div>
      )}

      {/* 仅在没有打开表单时显示：表单内的错误由内联表单（上方）或弹窗（下方）各自渲染一份，
          否则打开表单时同一条错误会显示两遍。 */}
      {!editing && error && <p className="msg-error">{error}</p>}

      {!(inlineEdit && editing) && (
      <>{/* 编辑/新建（inline）时不显示列表，避免表单下方仍展示整张用户表 */}
      {selection && bulkActions?.length ? (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '8px 12px', marginBottom: 8, borderRadius: 10,
            border: '1px solid var(--border)', background: 'var(--bg-subtle)',
          }}
        >
          <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>
            {t('crud.selectedCount', { count: selectedRows.size })}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={togglePage}>
            {allOnPageSelected ? t('crud.unselectPage') : t('crud.selectPage')}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(bulkBusy)} onClick={() => void selectAllResults()}>
            {t('crud.selectAllResults', { count: total })}
          </button>
          {selectedRows.size ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRows(new Map())}>
              {t('crud.clearSelection')}
            </button>
          ) : null}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {bulkActions.map((a) => (
              <button
                key={a.label}
                className="btn btn-outline btn-sm"
                style={a.danger ? { color: '#b3261e', borderColor: '#b3261e' } : undefined}
                disabled={!selectedRows.size || Boolean(bulkBusy)}
                onClick={() => void runBulk(a)}
              >
                {bulkBusy === a.label ? `${tl(a.label)}…` : tl(a.label)}
              </button>
            ))}
          </span>
        </div>
      ) : null}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {selection && (
                <th style={{ width: '44px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    ref={(el) => { if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected; }}
                    onChange={togglePage}
                    aria-label={t('crud.selectAllPage')}
                  />
                </th>
              )}
              {listCols.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{tl(c.label)}</th>)}
              {showActions && <th style={{ width: '150px' }}>{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const st = statusField ? str(row[statusField]) : '';
              const allowed = transitions && st ? transitions[st] ?? [] : [];
              return (
                <tr key={String(row.id)}>
                  {selection && (
                    <td style={{ textAlign: 'center', width: '44px' }}>
                      <input
                        type="checkbox"
                        checked={selectedRows.has(selKey(row))}
                        onChange={() => toggleRow(row)}
                        aria-label={t('crud.selectRow')}
                      />
                    </td>
                  )}
                  {listCols.map((c) => (
                    <td
                      key={c.key}
                      onClick={c.openRecord ? () => (detailHref ? router.push(detailHref(String(row.id))) : openEdit(row)) : undefined}
                      style={c.openRecord ? { cursor: 'pointer' } : undefined}
                    >
                      {c.inlineSwitch ? (
                        (() => {
                          const cur = str(row[c.key]);
                          const on = cur === c.inlineSwitch.onValue;
                          const busy = switchBusy === `${String(row.id)}:${c.key}`;
                          return (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={on}
                              disabled={busy || !onInlineSwitch}
                              title={on ? c.inlineSwitch.onHint : c.inlineSwitch.offHint}
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!onInlineSwitch) return;
                                const key = `${String(row.id)}:${c.key}`;
                                setSwitchBusy(key);
                                try {
                                  await onInlineSwitch(row, on ? c.inlineSwitch!.offValue : c.inlineSwitch!.onValue);
                                } finally {
                                  setSwitchBusy('');
                                }
                              }}
                              style={{
                                width: 38, height: 20, borderRadius: 999, border: '1px solid transparent',
                                background: on ? 'var(--accent)' : 'var(--border)',
                                opacity: busy ? 0.5 : 1, cursor: onInlineSwitch ? 'pointer' : 'default',
                                padding: 0, position: 'relative', transition: 'background .15s',
                              }}
                            >
                              <span
                                style={{
                                  position: 'absolute', top: 1, left: on ? 19 : 1, width: 16, height: 16,
                                  borderRadius: '50%', background: '#fff', transition: 'left .15s',
                                }}
                              />
                            </button>
                          );
                        })()
                      ) : statusField === c.key && st
                        ? <span className={`status-dot ${statusClass ? statusClass(st) : ''}`}>{tl(st)}</span>
                        : c.type === 'attachment'
                          ? (() => {
                            const files = attachmentFiles(row[c.key]);
                            if (!files.length) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
                            return (
                              <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                                {files.map((a, i) => (
                                  <a key={a.file_token ?? i} href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{a.name}</a>
                                ))}
                              </span>
                            );
                          })()
                          : (c.type === 'studentLink' && studentDetailHref
                            ? <Link href={studentDetailHref(row)} style={{ color: 'var(--accent)', fontWeight: 600 }}>{studentLabel(str(row[c.key]), row[STUDENT_ENGLISH_KEY])}</Link>
                            : c.render
                              ? c.render(row[c.key], row)
                              : (c.type === 'student' || c.type === 'studentLink'
                                ? studentLabel(str(row[c.key]), row[STUDENT_ENGLISH_KEY])
                                : cellText(row[c.key], c, tl, dictMeta)))}
                    </td>
                  ))}
                  {showActions && (
                  <td>
                    <div style={rowActions}>
                      {canUpdate && editHref ? (
                        <Link href={editHref(String(row.id))} className="btn btn-ghost btn-sm">{t('crud.edit')}</Link>
                      ) : canUpdate && (
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(row)}>{t('crud.edit')}</button>
                      )}
                      {!readonly && api.transition && allowed.length > 0 && (
                        <div style={{ position: 'relative' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => setTxMenu(txMenu === String(row.id) ? null : String(row.id))}>{t('common.status')}▾</button>
                          {txMenu === String(row.id) && (
                            <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 20, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 6, minWidth: 120, boxShadow: 'var(--shadow-lg)' }}>
                              {allowed.map((to) => (
                                <div key={to} onClick={() => doTransition(row, to)}
                                  style={{ padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 'var(--font-sm)' }}
                                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>{tl(to)}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {!readonly && rowExtraActions?.map((a) => {
                        const busyKey = `${String(row.id)}:${a.label}`;
                        return (
                          <button
                            key={a.label}
                            className="btn btn-ghost btn-sm"
                            disabled={Boolean(rowActionBusy) || loading}
                            onClick={() => runRowAction(row, a)}
                          >
                            {rowActionBusy === busyKey ? `${a.label}…` : a.label}
                          </button>
                        );
                      })}
                      {canDelete && <button className="btn btn-danger btn-sm" onClick={() => remove(row)}>{t('crud.delete')}</button>}
                    </div>
                  </td>
                  )}
                </tr>
              );
            })}
            {items.length === 0 && !loading && (
              <tr><td colSpan={colCount}>
                <div className="empty-state"><div className="empty-state-text">{t('crud.noData')}</div></div>
              </td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="empty-state"><div className="empty-state-text">{t('crud.loading')}</div></div>}
      </div>

      <Pagination
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        loading={loading}
        onPageChange={goToPage}
        onPageSizeChange={setSize}
      />
      </>)}

      {!inlineEdit && editing && (
        <div style={overlayStyle} onClick={() => setEditing(null)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700 }}>{editing.mode === 'create' ? `${t('crud.create')}${tl(title)}` : `${t('crud.edit')}${tl(title)}`}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>×</button>
            </div>
            <div style={{ padding: '20px 22px', maxHeight: '64vh', overflowY: 'auto' }}>
              {error && <p className="msg-error">{error}</p>}
              <fieldset className="form-fieldset">
                <legend className="form-legend">{tl(title)} {t('crud.info')}</legend>
                {formFields}
              </fieldset>
              {formActionMsg && (
                <p className={formActionMsg.ok ? 'msg-ok' : 'msg-error'} style={{ marginTop: 12 }}>{formActionMsg.text}</p>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 22px', borderTop: '1px solid var(--border)' }}>
              {formExtraActions?.map((a) => (
                <button
                  key={a.label}
                  className="btn btn-outline"
                  disabled={Boolean(formActionBusy) || submitting}
                  onClick={() => void runFormAction(a)}
                >
                  {formActionBusy === a.label ? `${a.label}…` : a.label}
                </button>
              ))}
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={submit} disabled={submitting}>{submitting ? t('common.saving') : t('common.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
