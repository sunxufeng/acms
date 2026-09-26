/**
 * 「我的笔记 → 飞书云盘」定时归档的口径（**定时任务 / 页面 / 接口 / 报告共用一份**）。
 *
 * 2026-09-22 峰哥给的规则：
 *  - 每天 **01:00**：有效 ∧ 标题含 `IDP` → 云盘 `VULJ…`（= 全量根目录下的「IDP」子文件夹）
 *  - 每天 **01:30**：全部有效        → 云盘 `K6Ij…`
 *  - 两边都是「按人建子文件夹 + 每篇出**明细**与**总结**两份 md + 文件名前缀日期 + 已复制过跳过」
 *
 * 2026-09-22 晚扩展为**可在页面上增删改**（菜单「定时任务」）：任务从代码常量搬到数据表，
 * 所以这里的重点是「**任务行 ⇄ 运行口径**」的解析与判据（见文件下半部分）。
 *
 * 放在 contracts 的原因：命名、文件夹归一、日期口径、到点判据都是**判据**，写两处必然漂移
 * （迁移期最典型的后果是同一人被建成两个文件夹、或同一篇笔记被复制两次）。
 */

export const NOTE_ARCHIVE_ROOT_IDP = 'VULJfnQXjlbHvEdP4clcqQbBnOc';
export const NOTE_ARCHIVE_ROOT_ALL = 'K6IjfMZuOlq8D3dwytfcnGjYnSh';

/**
 * 任务标识。
 *
 * 🔴 它是**归档记录的外键**（`noteArchiveRecordId(noteId, jobId)`）⇒ 一旦确定就不能改，
 *    所以页面上它是只读的、由系统生成（种子任务沿用 `idp` / `all`，这样 2026-09-22 首跑
 *    的 1412 个文件不会因为"任务上云"而被重新归档一遍）。
 *    用户能改的是**任务名称**（label），那只是个显示名。
 */
export type NoteArchiveJobKey = string;

export interface NoteArchiveJobDef {
  /** 稳定标识（= 任务行的 record id；归档记录的外键） */
  key: NoteArchiveJobKey;
  /** 显示名（可改，不参与任何判据） */
  label: string;
  /** 停用的任务不参与定时触发（但**仍可手动运行** —— 手动就是要立刻跑一次） */
  enabled: boolean;
  /** 到点执行什么：笔记归档 / 卫瓴联系人同步 / 邮件收取 */
  kind: JobKind;
  /** 多久跑一次：每天（按 HH:MM）/ 每小时（按第 N 分）/ 每15分钟 */
  freq: JobFreq;
  /** 北京时间（服务器时区不可信，判据一律走 `beijingClock()`） */
  hour: number;
  minute: number;
  /**
   * 周几执行：`0`=周日 … `6`=周六。**空数组 = 每天**。
   * 空表示每天而不是"从不"，是为了让"没配过"与"配了每天"落到同一个语义上（少一个状态）。
   */
  weekdays: number[];
  /** 目标文件夹 token（页面上允许粘链接，见 `parseFolderToken`） */
  rootFolderToken: string;
  /**
   * 标题必须包含的词（**大小写不敏感**）；空串 = 不过滤。
   * ⚠️ 实测区分大小写的 `LIKE` 与 `ILIKE` 在同一批数据上都是 24 条，但仍用不敏感 ——
   * 将来出现小写 `idp` 的标题不至于漏掉。
   */
  titleMustInclude: string;
  /** 输出哪些内容（可只出总结 / 只出明细） */
  kinds: NoteArchiveKind[];
  /** 是否按归属人建子文件夹；关掉则所有文件平铺在目标文件夹根下 */
  groupByOwner: boolean;
  /**
   * 「补跑窗口」：到点后的多少小时内仍算「今天这一次」。
   *
   * 🔴 为什么必须有：判据若是「当前时刻 ≥ 计划时刻 ⇒ 该跑」，那么在**任何时候**重启进程
   *    （蓝绿部署每天好几次）都会被判成「今天该跑却还没跑」⇒ **立刻跑一遍全量**。
   *    2026-09-22 实测踩到：部署重启（21:13）把两个任务当场都触发了。
   * 窗口默认 6 小时（01:00 → 07:00）：覆盖「凌晨重启/宕机后补跑」，又不会在白天/晚上乱跑。
   */
  catchUpHours: number;
}

/** 两个文件后缀：明细（原始记录/转写全文）与总结（智能总结） */
export const NOTE_ARCHIVE_KINDS = ['明细', '总结'] as const;
export type NoteArchiveKind = (typeof NOTE_ARCHIVE_KINDS)[number];

/** 归档记录的状态值（判据用常量，别在业务里手写字符串） */
export const NOTE_ARCHIVE_OK = '成功';
export const NOTE_ARCHIVE_FAIL = '失败';

/** 任务表里的字段名（建表、解析、页面列都用这一份，避免三处手抄） */
export const ARCHIVE_JOB_FIELDS = {
  任务名称: '任务名称',
  启用: '启用',
  /**
   * 任务类型（2026-09-24 新增，「定时任务」升级为通用调度器）：
   * `笔记归档` / `卫瓴联系人同步` / `邮件收取`。
   * ⚠️ 存量行没有这个字段 ⇒ 一律按 `笔记归档` 处理（见 `parseArchiveJobRow`），
   *    否则上线当天两条归档任务会被当成"未知类型"而**静默不跑**。
   */
  任务类型: '任务类型',
  /** 频率：`每天`（用 执行时间 的 HH:MM）/ `每小时`（每小时的第 N 分，取 执行时间 的分钟）/ `每15分钟` */
  频率: '频率',
  执行时间: '执行时间',
  执行日: '执行日',
  目标文件夹: '目标文件夹',
  标题关键词: '标题关键词',
  输出内容: '输出内容',
  按人分文件夹: '按人分文件夹',
  补跑窗口: '补跑窗口',
  上次运行: '上次运行',
  上次运行详情: '上次运行详情',
} as const;

/** 任务类型（决定「到点了执行什么」） */
/**
 * 任务类型（决定**谁来执行**，不只是显示名）。
 *
 * ⚠️ 加一个类型要**三处一起改**，漏一处就是"任务到点跑了但什么都没发生"：
 *   ① 这里（清单）
 *   ② `ScheduledTasksRunner.dispatch()`（后端分发）
 *   ③ `apps/web/app/scheduled-tasks/page.tsx` 的「运行」按钮（手动跑要能对应上）
 *   另：种子（`NOTE_ARCHIVE_JOB_SEEDS`）+ 生产任务行（`seedJobs()` 只在空表时播种，
 *   存量表要手工补行）。
 */
export const JOB_KINDS = ['笔记归档', '卫瓴联系人同步', '邮件收取', '知识库同步'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
/** 缺省类型：存量任务都是笔记归档（**兼容老数据**，别改成空串） */
export const JOB_KIND_DEFAULT: JobKind = '笔记归档';
/** 只有这个类型才需要「目标文件夹 / 标题关键词 / 输出内容 / 按人分文件夹」 */
export const JOB_KIND_NOTE_ARCHIVE: JobKind = '笔记归档';

/** 频率档位 */
export const JOB_FREQS = ['每天', '每小时', '每15分钟'] as const;
export type JobFreq = (typeof JOB_FREQS)[number];
export const JOB_FREQ_DEFAULT: JobFreq = '每天';


export const ARCHIVE_JOB_ON = '是';
export const ARCHIVE_JOB_OFF = '否';
/** 「执行日」的全选值：勾了它就等于每天（与空数组同义，见 `normalizeWeekdays`） */
export const ARCHIVE_JOB_WEEKDAY_ANY = '每天';
export const ARCHIVE_JOB_WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 页面「执行日」下拉的候选（顺序即展示顺序） */
export const ARCHIVE_JOB_WEEKDAY_OPTIONS = [
  ARCHIVE_JOB_WEEKDAY_ANY,
  ...ARCHIVE_JOB_WEEKDAY_LABELS,
];

/** 建表用的种子（新环境初始化用）；已有环境不会重写用户改过的任务 */
export const NOTE_ARCHIVE_JOB_SEEDS: NoteArchiveJobDef[] = [
  {
    key: 'idp',
    label: 'IDP 笔记',
    enabled: true,
    kind: '笔记归档',
    freq: '每天',
    hour: 1,
    minute: 0,
    weekdays: [],
    rootFolderToken: NOTE_ARCHIVE_ROOT_IDP,
    titleMustInclude: 'IDP',
    kinds: [...NOTE_ARCHIVE_KINDS],
    groupByOwner: true,
    catchUpHours: 6,
  },
  {
    key: 'all',
    label: '全部有效笔记',
    enabled: true,
    kind: '笔记归档',
    freq: '每天',
    hour: 1,
    minute: 30,
    weekdays: [],
    rootFolderToken: NOTE_ARCHIVE_ROOT_ALL,
    titleMustInclude: '',
    kinds: [...NOTE_ARCHIVE_KINDS],
    groupByOwner: true,
    catchUpHours: 6,
  },
  {
    // 2026-09-24 新增：替代原先硬编码的 `setInterval(24h)`
    //（那个写法每次部署重启都会把 24 小时计时清零，时间点会一直漂）
    key: 'weilingSync',
    label: '卫瓴联系人同步',
    enabled: true,
    kind: '卫瓴联系人同步',
    freq: '每天',
    hour: 7,
    minute: 0,
    weekdays: [],
    rootFolderToken: '',
    titleMustInclude: '',
    kinds: [],
    groupByOwner: false,
    catchUpHours: 6,
  },
  {
    // 2026-09-24 新增：替代 mail-archive.module 里硬编码的 `*/15 * * * *`
    // 频率保持「每15分钟」⇒ 与改造前的行为等价；账户自己的「收取频率」仍然生效（在 syncAll 内节流）
    key: 'mailFetch',
    label: '邮件收取',
    enabled: true,
    kind: '邮件收取',
    freq: '每15分钟',
    hour: 0,
    minute: 0,
    weekdays: [],
    rootFolderToken: '',
    titleMustInclude: '',
    kinds: [],
    groupByOwner: false,
    catchUpHours: 6,
  },
  {
    // 2026-09-26 新增：替代 getnote sources.module 里硬编码的 `*/15 * * * *`
    //（与「邮件收取」同模型：这里只决定**多久检查一次**，每条知识库配置自己的
    //  「收取频率」仍然生效 —— 节流在 `GetnoteSourceService.syncAllDue` 内）
    key: 'getnoteSync',
    label: '知识库同步',
    enabled: true,
    kind: '知识库同步',
    freq: '每15分钟',
    hour: 0,
    minute: 0,
    weekdays: [],
    rootFolderToken: '',
    titleMustInclude: '',
    kinds: [],
    groupByOwner: false,
    catchUpHours: 6,
  },
];

/** 任务的默认值（页面新建表单用；`RecordMeta.defaults` 直接引用这一份） */
export const NOTE_ARCHIVE_JOB_DEFAULTS: Record<string, unknown> = {
  [ARCHIVE_JOB_FIELDS.启用]: ARCHIVE_JOB_ON,
  [ARCHIVE_JOB_FIELDS.任务类型]: JOB_KIND_DEFAULT,
  [ARCHIVE_JOB_FIELDS.频率]: JOB_FREQ_DEFAULT,
  [ARCHIVE_JOB_FIELDS.执行时间]: '01:00',
  [ARCHIVE_JOB_FIELDS.执行日]: [ARCHIVE_JOB_WEEKDAY_ANY],
  [ARCHIVE_JOB_FIELDS.标题关键词]: '',
  [ARCHIVE_JOB_FIELDS.输出内容]: [...NOTE_ARCHIVE_KINDS],
  [ARCHIVE_JOB_FIELDS.按人分文件夹]: ARCHIVE_JOB_ON,
  [ARCHIVE_JOB_FIELDS.补跑窗口]: 6,
};

/**
 * 「目标文件夹」的输入归一：**允许粘飞书链接**，也允许直接填 token。
 *
 * 为什么必须容错：用户复制的是浏览器地址
 * （`https://xxx.feishu.cn/drive/folder/VULJ…?from=…`），让人肉眼抠出 26 位 token
 * 是纯粹的自找麻烦，而填错的后果是**凌晨静默失败**（或更糟：写进别的文件夹）。
 */
export function parseFolderToken(input: unknown): string {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const m = s.match(/\/folder\/([A-Za-z0-9]+)/);
  if (m) return m[1] ?? '';
  // 纯 token（飞书的 folder token 是 26 位左右的 base62）
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return s;
  return '';
}

/** `01:00` / `1:00` / `0100` / `01：00`（全角冒号）→ 时分；解析不出返回 null */
export function parseTimeOfDay(input: unknown): { hour: number; minute: number } | null {
  const s = String(input ?? '').trim().replace(/：/g, ':');
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1] ?? '');
  const minute = Number(m[2] ?? '');
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 「执行日」多选值 → 周几数组。
 * 含「每天」或空数组 ⇒ `[]`（= 每天，见 `NoteArchiveJobDef.weekdays` 的说明）。
 * 认不出的值一律丢掉（不让一个错字把整个任务变成"每天都跑"或"从不跑"）。
 */
export function normalizeWeekdays(input: unknown): number[] {
  const arr = Array.isArray(input) ? input : input == null || input === '' ? [] : [input];
  const out = new Set<number>();
  for (const raw of arr) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (s === ARCHIVE_JOB_WEEKDAY_ANY) return [];
    const idx = ARCHIVE_JOB_WEEKDAY_LABELS.indexOf(s);
    // 也接受 `0`~`6` 这类已归一的值
    if (idx >= 0) out.add(idx);
    else if (/^[0-6]$/.test(s)) out.add(Number(s));
  }
  return [...out].sort((a, b) => a - b);
}

/** 周几数组 → 展示文案（`[]` → 「每天」） */
export function weekdaySummary(weekdays: number[]): string {
  if (!weekdays.length) return ARCHIVE_JOB_WEEKDAY_ANY;
  return weekdays.map((d) => ARCHIVE_JOB_WEEKDAY_LABELS[d] ?? String(d)).join('、');
}

/** 输出内容多选值 → 类型数组（至少回落到「总结」，否则任务等于什么都不做） */
export function normalizeKinds(input: unknown): NoteArchiveKind[] {
  const arr = Array.isArray(input) ? input : input == null || input === '' ? [] : [input];
  const hit = NOTE_ARCHIVE_KINDS.filter((k) => arr.some((x) => String(x ?? '').trim() === k));
  return hit.length ? [...hit] : ['总结'];
}

/** 「是/否」字段解析（空值走默认值，别把没填当成否） */
export function parseYesNo(input: unknown, fallback: boolean): boolean {
  const s = String(input ?? '').trim();
  if (!s) return fallback;
  if (s === ARCHIVE_JOB_ON || s === 'true' || s === '1') return true;
  if (s === ARCHIVE_JOB_OFF || s === 'false' || s === '0') return false;
  return fallback;
}

/**
 * 任务行（表字段）→ 运行口径。
 *
 * 容错是刻意的：这些字段是人手填的，填错不该让定时器崩掉（崩掉的后果是**当天不归档**，
 * 而没人会注意到）。解析不出的部分回落到安全默认值，问题清单交给 `validateArchiveJob`，
 * 由页面显式提示 —— 「静默不跑」是最坏的失败方式。
 */
export function parseArchiveJobRow(
  id: string,
  fields: Record<string, unknown> | null | undefined,
): NoteArchiveJobDef {
  const f = (fields ?? {}) as Record<string, unknown>;
  const seed = NOTE_ARCHIVE_JOB_SEEDS.find((s) => s.key === id);
  const time = parseTimeOfDay(f[ARCHIVE_JOB_FIELDS.执行时间]) ?? {
    hour: seed?.hour ?? 1,
    minute: seed?.minute ?? 0,
  };
  return {
    key: id,
    label: String(f[ARCHIVE_JOB_FIELDS.任务名称] ?? '').trim() || seed?.label || `任务 ${id}`,
    enabled: parseYesNo(f[ARCHIVE_JOB_FIELDS.启用], true),
    // 🔴 缺省必须是「笔记归档 / 每天」：存量行的这两个字段是空的，
    //    给成别的值时，上线当天两条归档任务会静默不跑（且不报错）。
    kind: normalizeJobKind(f[ARCHIVE_JOB_FIELDS.任务类型]) ?? seed?.kind ?? JOB_KIND_DEFAULT,
    freq: normalizeJobFreq(f[ARCHIVE_JOB_FIELDS.频率]) ?? seed?.freq ?? JOB_FREQ_DEFAULT,
    hour: time.hour,
    minute: time.minute,
    weekdays: normalizeWeekdays(f[ARCHIVE_JOB_FIELDS.执行日]),
    rootFolderToken: parseFolderToken(f[ARCHIVE_JOB_FIELDS.目标文件夹]) || seed?.rootFolderToken || '',
    titleMustInclude: String(f[ARCHIVE_JOB_FIELDS.标题关键词] ?? '').trim(),
    kinds: normalizeKinds(f[ARCHIVE_JOB_FIELDS.输出内容]),
    groupByOwner: parseYesNo(f[ARCHIVE_JOB_FIELDS.按人分文件夹], true),
    catchUpHours: Math.max(0, Number(f[ARCHIVE_JOB_FIELDS.补跑窗口] ?? seed?.catchUpHours ?? 6) || 0),
  };
}

/** 运行口径 → 任务行字段（建种子用） */
export function archiveJobRowFields(job: NoteArchiveJobDef): Record<string, unknown> {
  return {
    [ARCHIVE_JOB_FIELDS.任务名称]: job.label,
    [ARCHIVE_JOB_FIELDS.启用]: job.enabled ? ARCHIVE_JOB_ON : ARCHIVE_JOB_OFF,
    [ARCHIVE_JOB_FIELDS.任务类型]: job.kind,
    [ARCHIVE_JOB_FIELDS.频率]: job.freq,
    [ARCHIVE_JOB_FIELDS.执行时间]: `${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')}`,
    [ARCHIVE_JOB_FIELDS.执行日]: job.weekdays.length
      ? job.weekdays.map((d) => ARCHIVE_JOB_WEEKDAY_LABELS[d])
      : [ARCHIVE_JOB_WEEKDAY_ANY],
    [ARCHIVE_JOB_FIELDS.目标文件夹]: job.rootFolderToken,
    [ARCHIVE_JOB_FIELDS.标题关键词]: job.titleMustInclude,
    [ARCHIVE_JOB_FIELDS.输出内容]: [...job.kinds],
    [ARCHIVE_JOB_FIELDS.按人分文件夹]: job.groupByOwner ? ARCHIVE_JOB_ON : ARCHIVE_JOB_OFF,
    [ARCHIVE_JOB_FIELDS.补跑窗口]: job.catchUpHours,
  };
}

/**
 * 配置体检：返回「人话问题清单」（空数组 = 没问题）。
 *
 * 用途有两个：① 页面列表上标红（配错的当场能看到，而不是等凌晨静默失败）；
 * ② `check` 接口的体检结果。**只报告不阻断保存** —— 半配好的任务先存下来是正常需求。
 *
 * ⚠️ 按**任务类型**分支（2026-09-24）：`目标文件夹` / `输出内容` 只有笔记归档才需要 ——
 *    卫瓴同步与邮件收取没有这些概念，不分支的话那两类任务会永远标红。
 */
export function validateArchiveJob(job: NoteArchiveJobDef): string[] {
  const out: string[] = [];
  if (!Number.isInteger(job.hour) || !Number.isInteger(job.minute)) out.push('执行时间不是 HH:MM');
  if (job.kind === JOB_KIND_NOTE_ARCHIVE) {
    if (!job.rootFolderToken) out.push('目标文件夹解析不出 token（请粘文件夹链接或 26 位 token）');
    if (!Array.isArray(job.kinds) || !job.kinds.length) out.push('输出内容没选（明细/总结至少选一个）');
  }
  if (job.freq === '每小时' && !(job.minute >= 0 && job.minute <= 59)) {
    out.push('「每小时」频率用的是执行时间的分钟（0–59）');
  }
  return out;
}

/**
 * 归档记录的行 id = `<笔记ID>__<任务标识>`。
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

/** 北京时间 `YYYY-MM-DD` + 当天分钟数（`01:30` → 90）+ 周几（0=周日）——定时任务的到点判据 */
export function beijingClock(now: Date = new Date()): {
  day: string;
  minutes: number;
  weekday: number;
} {
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
  const y = Number(pick('year'));
  const mo = Number(pick('month'));
  const d = Number(pick('day'));
  // 周几**从日期本身算**，不用 `weekday` 选项 —— 那个在不同 ICU 版本里给
  // `Sun` / `周日` / `星期日`，是个跨环境差异点。
  const valid = Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d);
  return {
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
    minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
    weekday: valid ? new Date(Date.UTC(y, mo - 1, d)).getUTCDay() : now.getDay(),
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

/** 任务是否在给定的周几执行（`weekdays` 为空 = 每天） */
export function jobRunsOnWeekday(job: NoteArchiveJobDef, weekday: number): boolean {
  if (!job.weekdays.length) return true;
  return job.weekdays.includes(weekday);
}

/** 任务类型归一：认不出的值返回 undefined，调用方回退缺省（**不要让脏值变成"未知类型不跑"**） */
export function normalizeJobKind(input: unknown): JobKind | undefined {
  const s = String(input ?? '').trim();
  return (JOB_KINDS as readonly string[]).includes(s) ? (s as JobKind) : undefined;
}

/** 频率归一，同上 */
export function normalizeJobFreq(input: unknown): JobFreq | undefined {
  const s = String(input ?? '').trim();
  return (JOB_FREQS as readonly string[]).includes(s) ? (s as JobFreq) : undefined;
}

/** 任务类型 → 展示名（列表用） */
export function jobKindLabel(kind: JobKind): string {
  return kind;
}

/**
 * 任务展示用的「执行安排」文案：`每天 01:00` / `每小时第 30 分` / `每15分钟`。
 * 给人看的，别拿它做判据（判据在 `shouldRunArchiveJob`）。
 */
export function archiveJobScheduleText(job: NoteArchiveJobDef): string {
  const time = `${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')}`;
  const days = weekdaySummary(job.weekdays);
  // ⚠️ 频率=每小时/每15分钟时，`weekdaySummary([])` 会给出「每天」——
  //    拼起来变成「每天 每小时第 57 分」这种自相矛盾的文案（日志里一眼就看得见）。
  //    所以非「每天」频率下，只在**真的限定了星期**时才带前缀。
  if (job.freq === '每小时') return job.weekdays.length ? `${days} 每小时第 ${job.minute} 分` : `每小时第 ${job.minute} 分`;
  if (job.freq === '每15分钟') return job.weekdays.length ? `${days} 每 15 分钟` : '每 15 分钟';
  return `${days} ${time}`;
}

/**
 * 本次触发属于哪个「时间槽」—— **同一槽位内只跑一次**的去重键。
 *
 * 为什么需要槽位而不是"今天跑过没跑过"：
 *   `每小时` / `每15分钟` 频率下，"今天跑过一次"会让它一天只跑一次。
 *   槽位键按频率取不同粒度（天 / 小时 / 15 分钟格），语义与频率严格对应。
 * ⚠️ 进程内即可（蓝绿重启只丢这个标记）：这三个任务本身都是幂等的
 *    （归档按「笔记×任务」upsert、联系人同步按 id upsert、邮件按 UID 去重）。
 */
export function jobSlotKey(job: NoteArchiveJobDef, day: string, nowMinutes: number): string {
  const hour = Math.floor(nowMinutes / 60);
  if (job.freq === '每15分钟') return `${job.key}:${day}:${hour}:${Math.floor((nowMinutes % 60) / 15)}`;
  if (job.freq === '每小时') return `${job.key}:${day}:${hour}`;
  return `${job.key}:${day}`;
}

/**
 * 这个任务此刻该不该跑（**纯函数，定时器与测试共用同一份判据**）。
 *
 * 四个条件同时满足才跑：
 *  ① 任务启用
 *  ② 今天还没跑过（`ranToday` 由调用方维护，进程内即可 —— 任务本身幂等）
 *  ③ 今天在它的执行日里（`weekdays` 空 = 每天）
 *  ④ 已到点，**且还在补跑窗口内**：`到点 ≤ 现在 ≤ 到点 + catchUpHours`
 *
 * 🔴 ④ 的后半段（补跑窗口）是 2026-09-22 补上的：只看「已到点」的话，
 *    **任何一次重启**（蓝绿部署每天好几次）都会被判成「今天该跑却没跑」⇒ 立刻跑全量。
 *    实测部署重启（21:13）把两个任务当场都触发了。
 *
 * ⚠️ 定时器**必须**传 `weekday`（来自 `beijingClock()`）；不传则跳过周几校验，
 *    只给"某任务是否到点"这类单测用。
 */
export function shouldRunArchiveJob(
  job: NoteArchiveJobDef,
  nowMinutes: number,
  ranToday: boolean,
  weekday?: number,
): boolean {
  if (!job.enabled) return false;
  // `ranToday` 实际含义是「**本时间槽**已跑过」（见 `jobSlotKey`）——参数名保留是为兼容旧调用
  if (ranToday) return false;
  if (weekday !== undefined && !jobRunsOnWeekday(job, weekday)) return false;
  if (job.freq === '每15分钟') {
    // 槽位 = 每小时 4 格（:00 / :15 / :30 / :45）；给 6 分钟容差，
    // 免得某一分钟 tick 被别的活占住就整天漏掉这一格（槽位去重保证一格只跑一次）。
    return nowMinutes - Math.floor(nowMinutes / 15) * 15 <= 6;
  }
  if (job.freq === '每小时') {
    // 每小时的第 N 分（N = 执行时间的分钟）。同样是「到点之后这一小时内都算到点」——
    // 部署重启错过那一刻时，本小时内下一次 tick 能补上；槽位去重保证一小时只跑一次。
    return nowMinutes % 60 >= job.minute;
  }
  const start = job.hour * 60 + job.minute;
  if (nowMinutes < start) return false;
  return nowMinutes <= start + Math.max(0, job.catchUpHours) * 60;
}
