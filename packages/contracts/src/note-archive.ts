/**
 * 「我的笔记 → 飞书云盘」每日归档的口径（**定时任务 / 接口 / 报告共用一份**）。
 *
 * 2026-09-22 峰哥给的规则：
 *  - 每天 **01:00**：有效 ∧ 标题含 `IDP` → 云盘 `VULJ…`（= 全量根目录下的「IDP」子文件夹）
 *  - 每天 **01:30**：全部有效        → 云盘 `K6Ij…`
 *  - 两边都是「按人建子文件夹 + 每篇出**明细**与**总结**两份 md + 文件名前缀日期 + 已复制过跳过」
 *
 * 放在 contracts 的原因：命名、文件夹归一、日期口径都是**判据**，写两处必然漂移
 * （迁移期最典型的后果是同一人被建成两个文件夹、或同一篇笔记被复制两次）。
 */

export const NOTE_ARCHIVE_ROOT_IDP = 'VULJfnQXjlbHvEdP4clcqQbBnOc';
export const NOTE_ARCHIVE_ROOT_ALL = 'K6IjfMZuOlq8D3dwytfcnGjYnSh';

export type NoteArchiveJobKey = 'idp' | 'all';

export interface NoteArchiveJobDef {
  key: NoteArchiveJobKey;
  label: string;
  /** 北京时间（服务器时区不可信，判据一律走 `beijingClock()`） */
  hour: number;
  minute: number;
  /** 目标文件夹 token（IDP 任务的那个本身就是全量根目录下的子文件夹） */
  rootFolderToken: string;
  /**
   * 标题必须包含的词（**大小写不敏感**）；空串 = 不过滤。
   * ⚠️ 实测区分大小写的 `LIKE` 与 `ILIKE` 在同一批数据上都是 24 条，但仍用不敏感 ——
   * 将来出现小写 `idp` 的标题不至于漏掉。
   */
  titleMustInclude: string;
}

export const NOTE_ARCHIVE_JOBS: Record<NoteArchiveJobKey, NoteArchiveJobDef> = {
  idp: {
    key: 'idp',
    label: 'IDP 笔记',
    hour: 1,
    minute: 0,
    rootFolderToken: NOTE_ARCHIVE_ROOT_IDP,
    titleMustInclude: 'IDP',
  },
  all: {
    key: 'all',
    label: '全部有效笔记',
    hour: 1,
    minute: 30,
    rootFolderToken: NOTE_ARCHIVE_ROOT_ALL,
    titleMustInclude: '',
  },
};

/** 两个文件后缀：明细（原始记录/转写全文）与总结（智能总结） */
export const NOTE_ARCHIVE_KINDS = ['明细', '总结'] as const;
export type NoteArchiveKind = (typeof NOTE_ARCHIVE_KINDS)[number];

/** 归档记录的状态值（判据用常量，别在业务里手写字符串） */
export const NOTE_ARCHIVE_OK = '成功';
export const NOTE_ARCHIVE_FAIL = '失败';

/**
 * 归档记录的行 id = `<笔记ID>__<任务>`。
 * 一行 = 「某篇笔记 × 某个任务」，天然幂等（重跑 upsert，不会重复复制）。
 */
export function noteArchiveRecordId(noteId: string, job: NoteArchiveJobKey): string {
  return `${noteId}__${job}`;
}

/**
 * 归属人 → 云盘文件夹名。
 *
 * 🔴 为什么必须归一：库里同时存在 `刘佳音 | Joy`（半角竖线 + 空格）与云盘已有的
 * `刘佳音｜Joy`（全角）。不归一就会给同一个人**新建一个近似重名的文件夹**，
 * 文件被劈成两处，之后谁也说不清哪份是全的。
 *
 * 规则：去所有空白 + 半角 `|` 统一成全角 `｜`；空值给「未归属」（不要让文件散在根目录）。
 */
export function normalizeOwnerFolderName(owner: unknown): string {
  const s = String(owner ?? '')
    .replace(/\s+/g, '')
    .replace(/\|/g, '｜')
    .trim();
  return s || '未归属';
}

/** 云盘/文件系统里不能出现的字符（斜杠会把名字截成两级路径） */
const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f]/g;

/** 文件名片段安全化：去非法字符、压空白、去首尾点，按长度截断 */
export function sanitizeFileNamePart(s: unknown, maxLen = 80): string {
  const cleaned = String(s ?? '')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

/** 毫秒时间戳 → 北京时间 `YYYY-MM-DD`（服务器时区不可信，必须显式指定） */
export function beijingDate(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** 北京时间 `YYYY-MM-DD` + 当天分钟数（`01:30` → 90）——定时任务的到点判据 */
export function beijingClock(now: Date = new Date()): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
    minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
  };
}

/**
 * 文件名：`YYYY-MM-DD 标题-明细__<笔记ID>.md`
 *
 * 🔴 为什么要带笔记 ID 尾巴：库里真实存在「同一人 + 同一天 + 同标题」的多条笔记
 * （实测 `2026-09-12 无内容` 同人 2 条、`2026-08-08 国际学校学年…` 2 条）。
 * 只按「日期 + 标题 + 类型」命名会撞名，且**"已复制过"没法精确判定**。
 * 带 ID 后：名字唯一、且能直接从文件名反查是否已归档。
 */
export function noteArchiveFileName(opts: {
  date: string;
  title: unknown;
  kind: NoteArchiveKind;
  noteId: string;
}): string {
  const title = sanitizeFileNamePart(opts.title) || '无标题';
  const date = sanitizeFileNamePart(opts.date, 10);
  const base = `${title}-${opts.kind}__${sanitizeFileNamePart(opts.noteId, 40)}.md`;
  // 日期缺失时**不要**留下前导空格（实测过一个 ` 标题-明细__x.md` 这样的名字，
  // 排序会跑到最前面，看着像"文件夹里第一个文件坏了"）
  return date ? `${date} ${base}` : base;
}

/** 归档正文：统一头 + 原文（头是给人看的，正文一行不改） */
export function noteArchiveBody(opts: {
  title: unknown;
  kind: NoteArchiveKind;
  noteId: string;
  owner: unknown;
  createdAtMs: number;
  content: string;
}): string {
  const created = beijingDate(opts.createdAtMs);
  const head = [
    `# ${String(opts.title ?? '').trim() || '无标题'}`,
    '',
    `- 类型：${opts.kind}`,
    `- 归属人：${String(opts.owner ?? '').trim() || '未归属'}`,
    `- 笔记时间：${created || '未知'}`,
    `- 笔记 ID：${opts.noteId}`,
    `- 来源：ACMS「我的笔记」归档，原文未脱敏`,
    '',
    '---',
    '',
  ].join('\n');
  return head + String(opts.content ?? '').trim() + '\n';
}

/** 该笔记是否属于这个任务（标题过滤 + 有效状态由调用方另行判定） */
export function noteMatchesArchiveJob(title: unknown, job: NoteArchiveJobDef): boolean {
  if (!job.titleMustInclude) return true;
  return String(title ?? '').toLowerCase().includes(job.titleMustInclude.toLowerCase());
}
