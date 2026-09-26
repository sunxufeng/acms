'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api, type GetnoteLink, type MyIdpComms } from '../lib/api';
import { IDP_COMM_RECORD_TYPE } from '@acms/contracts';
import MarkdownField from './MarkdownField';
import GetnoteNoteModal from './GetnoteNoteModal';
// 行内播放 / 音频判据：与学生记录列表**同一套**（单 Audio 实例 + ▶/⏸ 切换，不给每行挂 audio 元素）
import { attachmentAudioSrc, isAudioFile, useRowAudio } from '../lib/rowAudio';

/**
 * IDP 沟通抽屉（老师端与管理员端共用）。
 *
 * ## 沟通记录**不是**独立表
 *
 * 它就是「学生记录」里 `记录类型=IDP沟通` 的那批 ⇒
 *   · 读：`GET /my-idp/comms`（服务端按本配置的学年学期区间过滤）
 *   · 写：`POST /student-records`（**复用学生记录的完整能力**：附件、录音、AI 总结、
 *         关联笔记、闭环状态……所以峰哥要的「学生记录里已关联的 IDP 记录自动出现在这里」
 *         天生成立 —— 本来就是一个池子，不存在"同步"问题）
 *   · 「关联笔记」= 每条沟通记录**自己的**关联笔记。点**标题**打开：
 *     有笔记 ⇒ 直接是那篇笔记的详情（总结 / 原始记录，与「我的笔记」页同一个组件）；
 *     没有笔记 ⇒ 这条记录自己的「沟通总结 / 沟通明细」。
 *     附件（名称 · 时间，可下载 / 删除 / 加）在标题下面那行的**最右侧**。
 *
 * ## 两种形态共用一套内容（2026-09-26 峰哥定）
 *
 * `variant='modal'`（IDP 配置页）与 `variant='inline'`（我的 IDP 行内展开）渲染的是
 * 同一份 `cards` + 同一批子弹窗 —— 两处各写一份必然漂移（本项目反复踩过）。
 * 行内形态里没有 modal 外壳，所以「关闭」由宿主（表格行的箭头 / 收起按钮）负责。
 *
 * ⚠️ 附件字段名是「沟通附件清单」（**可写**）。学生记录 meta 的 `readonly` 里那条是
 *    「沟通附件」（少一个字，是另一个字段）—— 别搞混，写进 readonly 的会被静默丢弃。
 *
 * ## 「导入笔记」（2026-09-26 新增，当日按峰哥反馈重做了一版）
 *
 * 老师把自己在「我的笔记」里记的笔记**批量**导入进来。
 *
 * 🔴 导入 = **每条笔记各建一条「IDP沟通」学生记录**，并把笔记挂到那条记录上
 *    （主题 = 笔记主题、时间 = 笔记时间、沟通方式 = 面谈、沟通人 = 当前登录人）。
 *    为什么不是"只挂个关联"：导进来的笔记要能在时间线上直接看到，附件也挂在记录上 ——
 *    笔记于是成了这条沟通的来源。**不再**挂到「IDP学生」明细行（一处内容两个地方）。
 *    「已导入」的判据因此变成：`data.linkedNoteIds`（后端按 `实体类型=IDP沟通` +
 *    该生记录 id 现算），候选列表用它过滤 —— 必须与写入侧同一判据。
 *    ⚠️ 写 `PUT /getnote/links` 是**全量覆盖式**：改关联时要么带上已有的，要么明确写空。
 *
 * 🔴 权限与可见性（峰哥 2026-09-26 定的口径）：
 *    · 建记录 / 改记录要学生记录的 create / update（老师们两个来源任一即有，已实测）；
 *      写笔记关联要 `module:getnote:update`，生产实测 Phase1~Phase8 只有 read ⇒ 已补；
 *    · **候选列表只列老师自己的笔记**（`GET /getnote/notes?mine=1`，见 `NoteListFilters.mine`）——
 *      判据 = 本人凭证 + **归属人是自己**的知识库配置（只认「关联用户含我」会把同事账号的
 *      笔记带进来；只认个人凭证文件又会让"凭证挂在配置上"的老师（如曹德强）恒为 0 条）；
 *      系统管理员不吃这个参数，仍然看得到全部；
 *    · 附件是**挂在这条记录上**的，同一条时间线行里就能加 / 删 / 下载。
 */
export interface IdpCommTarget {
  configId: string;
  configName: string;
  studentId: string;
  studentName: string;
  cls: string;
  /** 归档批次：只读（不给新建） */
  archived: boolean;
  /** 当前登录人姓名（新建时填「沟通人」） */
  meName?: string;
}

/** 附件条目形态：与学生记录「沟通附件清单」的存储一致（CrudPage 也按这个结构读） */
interface Attach {
  file_token: string;
  name: string;
  size?: number;
  /** 上传时间（ms）—— 界面要显示「附件名 + 时间」，历史附件没有则 0 */
  at?: number;
  /** MIME（如 `audio/ogg`）—— 靠它辨认录音（见 `isAudioFile`） */
  type?: string;
}

/** 时间线一条记录：标题 + 元信息行（附件在元信息行最右侧） */
const rowStyle: CSSProperties = {
  padding: '11px 0',
  borderTop: '1px solid var(--border)',
};

/** 标题做成链接的样子（用 button 而不是 a：这里只弹窗，不跳页） */
const titleBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 0,
  padding: 0,
  font: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--accent)',
  cursor: 'pointer',
  textAlign: 'left',
  borderBottom: '1px dashed rgba(14,155,142,.45)',
  wordBreak: 'break-word',
};

const metaRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  flexWrap: 'wrap',
  marginTop: 5,
};

const rightClusterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
};

/** 附件 chip：名称 · 时间 × */
const attChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12.5,
  padding: '1px 3px 1px 8px',
  border: '1px solid var(--border)',
  borderRadius: 999,
  background: 'var(--bg-subtle)',
};

/** 行内展开时的外壳（「我的 IDP」把整套内容挂在表格行的展开区里） */
const inlinePanelStyle: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--accent)',
  borderRadius: 10,
  padding: '13px 15px',
  boxShadow: 'var(--shadow-sm)',
};

/** 行内展开时的顶部一行：次数 / 区间 + 收起 */
const panelMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  flexWrap: 'wrap',
  paddingBottom: 10,
  marginBottom: 10,
  borderBottom: '1px dashed var(--border)',
};

/** 导入候选：全宽网格（原来是右侧栏里的单列） */
const candBoxStyle: CSSProperties = {
  maxHeight: 260,
  overflowY: 'auto',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 6,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 2,
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本机当前时间 → `YYYY-MM-DDTHH:mm`（datetime 表单格式） */
function nowLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「我的笔记」列表行里我们要用到的字段（上游结构，其余忽略） */
interface NoteItem {
  noteId: string;
  title: string;
  createdAt: number;
}

/**
 * 上游笔记 → 列表行。
 * ⚠️ `note_id` 是 int64 的**字符串**形态，绝不能转 Number（丢精度后 id 就查不到了）。
 */
function toNoteItem(r: Record<string, unknown>): NoteItem {
  const title = String(r.title ?? '').trim();
  const snippet = String(r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return {
    noteId: String(r.note_id ?? r.id ?? ''),
    title: title || snippet,
    createdAt: Number(r.created_at ?? 0) || 0,
  };
}

/** 笔记时间只要日期：列表里带时分是噪音 */
function fmtDay(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function IdpCommDrawer({
  target,
  onClose,
  onSaved,
  variant = 'modal',
}: {
  target: IdpCommTarget;
  onClose: () => void;
  /** 新建成功后的回调（父页面用它刷新沟通次数） */
  onSaved?: () => void;
  /**
   * 呈现方式（两种宿主共用这一份内容与全部写入口）：
   *  · `modal`（默认）—— 弹窗形态，「IDP 配置」页用
   *  · `inline` —— 只出内容卡片，「我的 IDP」把它挂在表格行展开区里
   */
  variant?: 'modal' | 'inline';
}) {
  const t = useTranslations('myIdp');
  const [data, setData] = useState<MyIdpComms | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * 点标题打开的那条记录（记录 id）。
   * 有关联笔记 ⇒ 直接看**笔记详情**；没有笔记 ⇒ 看这条记录的「沟通总结 / 明细」。
   */
  const [openRecId, setOpenRecId] = useState('');
  /** 一条记录关联多篇笔记时，当前看第几篇（0 起） */
  const [noteIdx, setNoteIdx] = useState(0);

  // 新建表单
  const [subject, setSubject] = useState('');
  const [when, setWhen] = useState(nowLocal);
  const [way, setWay] = useState('面谈');
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [atts, setAtts] = useState<Attach[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 正在操作的记录 id（附件上传/删除时禁用该行按钮，避免连点写坏附件数组） */
  const [busyAtt, setBusyAtt] = useState('');
  const attRef = useRef<HTMLInputElement>(null);
  /** 附件上传的目标记录 id（input 是复用的一个，点哪行就指向哪条记录） */
  const attTargetRef = useRef('');

  // ── 导入笔记 ──────────────────────────────────────────────
  /** 右侧面板是否展开 */
  const [importOpen, setImportOpen] = useState(false);
  /** 候选笔记（我的笔记，已过滤掉「该生 IDP沟通 记录已关联」的） */
  const [cands, setCands] = useState<NoteItem[]>([]);
  const [candsToken, setCandsToken] = useState('');
  const [candsMore, setCandsMore] = useState(false);
  const [candsLoading, setCandsLoading] = useState(false);
  const [kw, setKw] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  /** 得到大脑凭证是否已配（没配就拉不到笔记，提前拦住并引导，别让用户撞 412） */
  const [credOk, setCredOk] = useState<boolean | null>(null);
  /** 一次性提示（导入成功） */
  const [flash, setFlash] = useState('');
  /**
   * 沟通方式选项：读**字典** `沟通方式`（字典改了这里跟着变，别硬编码）。
   * 还没加载完时先给「面谈」兜底 —— 这正是峰哥要的默认值。
   */
  const [ways, setWays] = useState<string[]>(['面谈']);
  useEffect(() => {
    api
      .dictionaries()
      .then((d) => {
        const list = d?.['沟通方式'] ?? [];
        if (list.length) setWays(list);
      })
      .catch(() => {
        /* 读不到就只用「面谈」，不阻断新建 */
      });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await api.myIdpComms(target.configId, target.studentId));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [target.configId, target.studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 候选笔记 = 我的笔记 − 「该生 IDP沟通 记录**已关联**的笔记」。
   *
   * 判据来自 `data.linkedNoteIds`（后端按 `实体类型=IDP沟通` + 该生记录 id 现算），
   * 与写入时挂的那一侧**同一判据** —— 前端不能另算一套（必然漂移，
   * 症状是"刚导入的又出现在候选里"）。
   */
  const loadCands = useCallback(
    async (reset: boolean, linkedIds?: Set<string>) => {
      setCandsLoading(true);
      try {
        // `mine=1`：只列**我自己的**笔记（见 NoteListFilters.mine 的注释）
        const params: Record<string, string | undefined> = { pageSize: '100', mine: '1' };
        if (kw.trim()) params.q = kw.trim();
        if (!reset && candsToken) params.pageToken = candsToken;
        const r = await api.listGetnote(params);
        const linked = linkedIds ?? new Set(data?.linkedNoteIds ?? []);
        const fresh = ((r.items ?? []) as Record<string, unknown>[])
          .map(toNoteItem)
          .filter((n) => n.noteId && !linked.has(n.noteId));
        setCands((cur) =>
          reset ? fresh : [...cur, ...fresh.filter((n) => !cur.some((x) => x.noteId === n.noteId))],
        );
        setCandsToken(r.pageToken ?? '');
        setCandsMore(Boolean(r.hasMore));
      } catch (e) {
        setErr(errMsg(e));
        if (reset) setCands([]);
      } finally {
        setCandsLoading(false);
      }
    },
    [kw, candsToken, data],
  );

  /**
   * 打开面板：先拿一次最新的沟通记录（要它的 `linkedNoteIds` 做过滤），再拉候选。
   * 🔴 顺序不能反 —— 反了会把已导入的也列出来（用户会以为没导入成功）。
   */
  const openImport = async () => {
    setFlash('');
    setImportOpen(true);
    setPicked(new Set());
    setErr('');
    setCredOk(null);
    api
      .getGetnoteCredential()
      .then((c) => setCredOk(Boolean(c?.configured)))
      .catch(() => setCredOk(false));

    setCandsLoading(true);
    try {
      const cur = await api.myIdpComms(target.configId, target.studentId);
      setData(cur);
      const linkedIds = new Set(cur.linkedNoteIds ?? []);
      const r = await api.listGetnote({ pageSize: '100', mine: '1' });
      const items = ((r.items ?? []) as Record<string, unknown>[])
        .map(toNoteItem)
        .filter((n) => n.noteId && !linkedIds.has(n.noteId));
      setCands(items);
      setCandsToken(r.pageToken ?? '');
      setCandsMore(Boolean(r.hasMore));
    } catch (e) {
      setErr(errMsg(e));
      setCands([]);
    } finally {
      setCandsLoading(false);
    }
  };

  const closeImport = () => {
    setImportOpen(false);
    setPicked(new Set());
    setKw('');
  };

  /**
   * 关键词搜索（防抖 350ms）。
   *
   * ⚠️ **打开面板后的首次不重搜**：`openImport` 已经拉过一次候选，这里再拉一次就是
   *    白白多打一轮上游（QPS 2，用户还要多等 1~2 秒）。用 ref 记住上次的关键词，
   *    只有真的变了才重搜。
   * ⚠️ 依赖里刻意**不写** `loadCands`：它依赖 `candsToken`，翻页后就会变化，
   *    写进去会在每次翻页后自己触发一次多余的重搜、把用户翻到的页冲掉。
   */
  const kwRef = useRef<string | null>(null);
  useEffect(() => {
    if (!importOpen) {
      kwRef.current = null;
      return;
    }
    if (kwRef.current === null) {
      kwRef.current = kw; // 刚打开：openImport 已经拉过
      return;
    }
    if (kwRef.current === kw) return;
    kwRef.current = kw;
    const timer = setTimeout(() => {
      void loadCands(true);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw, importOpen]);

  /**
   * 变更后刷新：沟通时间线 + 候选列表。
   * 候选必须用**新的**已关联集合过滤（`myIdpComms` 现算），否则刚导入的还留在列表里。
   */
  const refreshAll = async () => {
    const cur = await api.myIdpComms(target.configId, target.studentId);
    setData(cur);
    await loadCands(true, new Set(cur.linkedNoteIds ?? []));
  };

  /**
   * 导入 = **每条选中的笔记各建一条「IDP沟通」学生记录**，并把笔记挂到那条记录上。
   *
   * 为什么是"建记录"而不是只挂个关联（峰哥 2026-09-26 要求）：导进来的笔记要能在
   * 「我的 IDP」时间线上**直接看到**（主题 = 笔记主题、时间 = 笔记时间、沟通人 = 我），
   * 附件也挂在记录上 —— 笔记于是成了这条沟通的来源。
   *
   * 逐条独立 try：某条失败不影响其余，失败的照实报出来（不吞错）。
   */
  const doImport = async () => {
    if (!picked.size) return;
    setImporting(true);
    setErr('');
    setFlash('');
    const failed: string[] = [];
    let ok = 0;
    for (const noteId of picked) {
      const note = cands.find((c) => c.noteId === noteId);
      const title = note?.title ?? '';
      try {
        const rec = await api.createStudentRecord({
          记录类型: IDP_COMM_RECORD_TYPE,
          // 「关联学生编号」在 meta 的 readonly 里 ⇒ 靠 linkBackfill 按姓名回填
          关联学生: target.studentName,
          沟通主题: title || t('noSubject'),
          // 毫秒时间戳（meta 的 dateFields 会按它转）；笔记没有时间就退回"现在"
          沟通时间: note?.createdAt || Date.now(),
          沟通方式: way,
          沟通人: target.meName ?? '',
        });
        const rid = String((rec as { id?: string } | null)?.id ?? '');
        if (!rid) throw new Error('NO_RECORD_ID');
        // 新建的记录此前必然没有关联 ⇒ 直接覆盖式写入这一篇（覆盖式接口只认最终名单）
        await api.replaceGetnoteLinks(IDP_COMM_RECORD_TYPE, rid, title, [{ noteId, title }]);
        ok += 1;
      } catch {
        failed.push(title || noteId);
      }
    }
    setPicked(new Set());
    try {
      await refreshAll();
      onSaved?.();
    } catch (e) {
      setErr(errMsg(e));
    }
    setFlash(
      failed.length
        ? t('importDonePartial', { n: ok, failed: failed.length, list: failed.slice(0, 3).join('、') })
        : t('importDone', { n: ok }),
    );
    setImporting(false);
  };

  /**
   * 给某条 IDP沟通 记录加附件。
   *
   * 🔴 「合并已有 + 本次新增」再整字段写回：`沟通附件清单` 是**数组字段**，
   *    `PUT` 是合并语义但数组会整体替换 —— 只传新上传的那几个会把旧附件抹掉。
   */
  const addAttach = async (recordId: string, files: FileList | null, already: Attach[]) => {
    if (!files?.length) return;
    setBusyAtt(recordId);
    setErr('');
    try {
      const added: Attach[] = [];
      for (const f of Array.from(files)) {
        const up = await api.uploadFile(f);
        added.push({ file_token: up.file_token, name: up.name, at: Date.now() });
      }
      await api.updateStudentRecord(recordId, { 沟通附件清单: [...already, ...added] });
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusyAtt('');
      if (attRef.current) attRef.current.value = '';
    }
  };

  const removeAttach = async (recordId: string, fileToken: string, already: Attach[]) => {
    setBusyAtt(recordId);
    setErr('');
    try {
      await api.updateStudentRecord(recordId, {
        沟通附件清单: already.filter((a) => a.file_token !== fileToken),
      });
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusyAtt('');
    }
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setErr('');
    try {
      const added: Attach[] = [];
      for (const f of Array.from(files)) {
        const r = await api.uploadFile(f);
        added.push({ file_token: r.file_token, name: r.name });
      }
      setAtts((cur) => [...cur, ...added]);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = async () => {
    if (!subject.trim() && !summary.trim()) {
      setErr(t('needSubjectOrSummary'));
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.createStudentRecord({
        记录类型: IDP_COMM_RECORD_TYPE,
        // 「关联学生编号」在 meta 的 readonly 里 ⇒ 显式传也会被过滤；靠 linkBackfill
        // 按姓名回填（见 lifecycle.meta 的 linkBackfill 注释）
        关联学生: target.studentName,
        沟通主题: subject.trim(),
        沟通时间: when,
        沟通方式: way,
        沟通总结: summary,
        沟通明细: detail,
        沟通附件清单: atts,
        沟通人: target.meName ?? '',
      });
      setSubject('');
      setSummary('');
      setDetail('');
      setAtts([]);
      setWay('面谈');
      setWhen(nowLocal());
      setOpenForm(false);
      await load();
      onSaved?.();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  /** 某条记录当前已有的附件（写回时必须带上，否则数组字段会被整体替换掉） */
  const filesOfRecord = (id: string): Attach[] =>
    ((data?.rows ?? []).find((x) => x.id === id)?.files ?? []) as Attach[];

  /**
   * 行内播放：附件里的**录音**。
   *
   * 为什么要这一步：录音是「我的笔记」转出 / 老师上传时作为附件写进「沟通附件清单」的。
   * 只给一个下载链接的话，同事还得下载到本地用播放器听 —— 而这条录音正是这条沟通记录的
   * 原始素材（峰哥 2026-09-26：显示成播放按钮就行、**不可删除**）。
   * 判据 `isAudioFile` 与学生记录列表用的是**同一份**（MIME 优先 + 扩展名兜底）。
   */
  const audioSrcOf = useCallback((row: Record<string, unknown>) => {
    const first = ((row.files as Attach[]) ?? []).find((f) => isAudioFile(f));
    return first?.file_token ? attachmentAudioSrc(first.file_token) : null;
  }, []);
  const { playingId, toggle: toggleAudio } = useRowAudio(audioSrcOf);

  /** 一条记录里的录音（渲染成播放按钮；**不给删除**，见 `audioNoDelete`） */
  const audiosOf = (r: MyIdpComms['rows'][number]): Attach[] =>
    ((r.files as Attach[]) ?? []).filter((f) => isAudioFile(f));
  /** 其余的普通附件（下载 / 显示时间 / 可删除） */
  const plainFilesOf = (r: MyIdpComms['rows'][number]): Attach[] =>
    ((r.files as Attach[]) ?? []).filter((f) => !isAudioFile(f));

  const count = data?.rows.length ?? 0;

  /**
   * 点沟通标题要打开的那条记录（'' = 没打开）。
   *
   * 打开什么由**数据**决定：
   *  · 这条记录挂着得到大脑笔记 ⇒ 直接弹**笔记详情**（峰哥 2026-09-26 指定：
   *    不要再中间夹一层「记录详情」）
   *  · 没有笔记 ⇒ 弹这条记录自己的「沟通总结 / 沟通明细」
   * 判据是后端现算的 `linkedNoteIds`，与导入侧写关联时用的**同一份**（不会一边有一边没有）。
   */
  const rec = (data?.rows ?? []).find((x) => x.id === openRecId) ?? null;
  const recNotes = rec?.linkedNoteIds ?? [];
  const noteIdxSafe = recNotes.length ? Math.min(noteIdx, recNotes.length - 1) : 0;
  const noteId = recNotes.length ? recNotes[noteIdxSafe] : '';

  const openRecordOf = (id: string) => {
    setOpenRecId(id);
    setNoteIdx(0);
  };
  const closeRecord = () => {
    setOpenRecId('');
    setNoteIdx(0);
  };

  /** 两种宿主（弹窗 / 行内展开）共用的内容 */
  const cards = (
    <>
      {data && !data.rangeOk ? (
        <div className="notice notice-warn" style={{ marginBottom: 10 }}>
          {t('rangeBad')}
        </div>
      ) : null}
      {data && data.noTime > 0 ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          {t('noTimeWarn', { n: data.noTime })}
        </div>
      ) : null}
      {err ? (
        <div className="notice notice-error" style={{ marginBottom: 10 }}>
          {err}
        </div>
      ) : null}
      {flash ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          {flash}
        </div>
      ) : null}

      {/* 行内展开时，学生名 / 班级已经在表格行上 ⇒ 这里只补一句区间与次数，顺带给个收起 */}
      {variant === 'inline' ? (
        <div style={panelMetaStyle}>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {t('commCountIs', { n: count })}
            {data?.rangeOk && data.rangeText ? ` · ${t('rangeIs', { range: data.rangeText })}` : ''}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('collapse')} ▲
          </button>
        </div>
      ) : null}

      {/* ── 记录一次沟通：走学生记录的 create（附件 / 录音 / AI 总结全都共用现成能力） ── */}
      {target.archived ? (
        <div className="muted" style={{ marginBottom: 10, fontSize: 12.5 }}>
          {t('archivedReadonly')}
        </div>
      ) : openForm ? (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          {/* 沟通类型 / 学生 / 记录人：都由上下文决定，不给改（改类型要回「学生记录」页） */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, marginBottom: 8 }}>
            <span className="muted">
              {t('fType')}：<b style={{ color: 'var(--fg)' }}>{IDP_COMM_RECORD_TYPE}</b>
            </span>
            <span className="muted">
              {t('fStudent')}：<b style={{ color: 'var(--fg)' }}>{target.studentName}</b>
            </span>
            <span className="muted">
              {t('fPerson')}：<b style={{ color: 'var(--fg)' }}>{target.meName || '—'}</b>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="form-input"
              style={{ flex: '1 1 240px' }}
              placeholder={t('fSubject')}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
            {/* 沟通方式：默认「面谈」，选项读字典（字典改了这里跟着变） */}
            <select
              className="form-input"
              style={{ width: 130 }}
              value={way}
              onChange={(e) => setWay(e.target.value)}
            >
              {ways.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <input
              className="form-input"
              style={{ width: 190 }}
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>

          {/* 总结 / 明细：**全站统一的 Markdown 组件**（MD / 浏览双 Tab + MD 导入），
              与学生记录那边同一种录入体验 —— 可录入、可浏览校对、可从 .md 文件导入 */}
          <div style={{ marginTop: 10 }}>
            <MarkdownField label={t('fSummary')} value={summary} onChange={setSummary} height={150} />
          </div>
          <div style={{ marginTop: 10 }}>
            <MarkdownField label={t('fDetail')} value={detail} onChange={setDetail} height={190} />
          </div>

          {/* 附件：上传后写进「沟通附件清单」（与 CrudPage 的 attachment 字段同结构） */}
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? t('uploading') : t('uploadAttachment')}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => void pickFiles(e.target.files)}
            />
            {atts.map((a) => (
              <span key={a.file_token} className="tag">
                {a.name}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAtts((cur) => cur.filter((x) => x.file_token !== a.file_token))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void submit()}>
              {saving ? t('saving') : t('save')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenForm(false)}>
              {t('cancel')}
            </button>
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
              {t('fullFormHint')}
            </span>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {/* 顺序与底色（峰哥 2026-09-26 定）：导入在前、实心主色；手记在后、描边 */}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => (importOpen ? closeImport() : void openImport())}
          >
            {importOpen ? t('collapse') : t('importNotes')}
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              // 两个面板互斥：开表单时把导入面板收掉（同时铺开两块会互相挤，也看不清在干啥）
              closeImport();
              setOpenForm(true);
            }}
          >
            ＋ {t('addComm')}
          </button>
        </div>
      )}

      {/* ── 从「我的笔记」导入：**全宽面板**（行内展开时右侧放不下 380px 的栏） ── */}
      {importOpen ? (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t('importTitle')}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={closeImport}>
              {t('collapse')}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
            {t('importHint')}
          </p>

          {credOk === false ? (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              {t('importNeedCred')}{' '}
              <Link href="/getnote" style={{ color: 'var(--accent)' }}>
                {t('importNeedCredLink')}
              </Link>
            </p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <input
                  className="form-input"
                  style={{ flex: '1 1 260px' }}
                  placeholder={t('importSearch')}
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                />
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {t('importSelectedN', { n: picked.size })}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={importing || picked.size === 0}
                  onClick={() => void doImport()}
                >
                  {importing ? t('importing') : t('importConfirm')}
                </button>
              </div>

              <div style={candBoxStyle}>
                {candsLoading && cands.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12.5, padding: 6 }}>
                    {t('importLoading')}
                  </div>
                ) : cands.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12.5, padding: 6 }}>
                    {kw.trim() ? t('importNoMatch') : t('importEmpty')}
                  </div>
                ) : (
                  cands.map((n) => {
                    const on = picked.has(n.noteId);
                    return (
                      <label
                        key={n.noteId}
                        title={n.noteId}
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                          padding: '6px 6px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          background: on ? 'var(--accent-muted)' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setPicked((cur) => {
                              const next = new Set(cur);
                              if (e.target.checked) next.add(n.noteId);
                              else next.delete(n.noteId);
                              return next;
                            })
                          }
                          style={{ marginTop: 3 }}
                        />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ fontSize: 13, display: 'block', wordBreak: 'break-word' }}>
                            {n.title || n.noteId}
                          </span>
                          {n.createdAt ? (
                            <span className="muted" style={{ fontSize: 11.5 }}>
                              {fmtDay(n.createdAt)}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>

              {candsMore ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={candsLoading}
                  style={{ width: '100%', marginTop: 4 }}
                  onClick={() => void loadCands(false)}
                >
                  {t('importLoadMore')}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* ── 时间线（就是学生记录里那批，按本配置学年学期过滤） ── */}
      {loading ? (
        <div className="muted">{t('loading')}</div>
      ) : count === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🗒️</div>
          <div className="empty-state-text">{t('noComm')}</div>
        </div>
      ) : (
        <div>
          {(data?.rows ?? []).map((r) => (
            <div key={r.id} style={rowStyle}>
              {/* 标题就是入口：有关联笔记 ⇒ 笔记详情；没有 ⇒ 这条记录的总结 / 明细 */}
              <button type="button" style={titleBtnStyle} title={t('openCommHint')} onClick={() => openRecordOf(r.id)}>
                {r.subject || t('noSubject')}
              </button>

              {/* 元信息一行打尽，附件挂在**最右侧**（峰哥 2026-09-26：别再单占一行） */}
              <div style={metaRowStyle}>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {fmtTime(r.time)}
                  {r.way ? ` · ${r.way}` : ''}
                  {r.person ? ` · ${r.person}` : ''}
                  {r.status ? ` · ${r.status}` : ''}
                  {r.linkedNoteIds?.length ? ` · 🔗 ${t('linkedNotesN', { n: r.linkedNoteIds.length })}` : ''}
                </span>
                <span style={rightClusterStyle}>
                  {/* 录音 → 播放按钮（与学生记录列表同一形态），**不给删除**：
                      它是这条记录自带的原始素材（峰哥 2026-09-26 定） */}
                  {audiosOf(r).length ? (
                    <button
                      type="button"
                      className={playingId === r.id ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                      title={
                        `${playingId === r.id ? t('stop') : t('play')}：${audiosOf(r)[0].name || ''}` +
                        (audiosOf(r).length > 1 ? t('playAudioN', { n: audiosOf(r).length }) : '') +
                        ` · ${t('audioNoDelete')}`
                      }
                      onClick={() => toggleAudio({ id: r.id, files: r.files })}
                    >
                      {playingId === r.id ? `⏸ ${t('stop')}` : `▶ ${t('play')}`}
                    </button>
                  ) : null}

                  {plainFilesOf(r).map((f) => (
                    <span key={f.file_token} style={attChipStyle}>
                      <a
                        href={`/api/v1/files/${encodeURIComponent(f.file_token)}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent)' }}
                      >
                        📎 {f.name || f.file_token}
                      </a>
                      {f.at ? <span className="muted">{fmtDay(f.at)}</span> : null}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busyAtt === r.id || target.archived}
                        title={t('removeAttach')}
                        onClick={() => void removeAttach(r.id, f.file_token, r.files as Attach[])}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={busyAtt === r.id || target.archived}
                    onClick={() => {
                      attTargetRef.current = r.id;
                      attRef.current?.click();
                    }}
                  >
                    ＋ {t('addAttach')}
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );

  /** 子弹窗 + 复用的隐藏附件 input（两种宿主共用） */
  const popups = (
    <>
      {rec && noteId ? (
        <GetnoteNoteModal
          noteId={noteId}
          onClose={closeRecord}
          switcher={
            recNotes.length > 1 ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 6 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={t('notePrev')}
                  disabled={noteIdxSafe <= 0}
                  onClick={() => setNoteIdx(noteIdxSafe - 1)}
                >
                  ‹
                </button>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {`${noteIdxSafe + 1}/${recNotes.length}`}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={t('noteNext')}
                  disabled={noteIdxSafe >= recNotes.length - 1}
                  onClick={() => setNoteIdx(noteIdxSafe + 1)}
                >
                  ›
                </button>
              </span>
            ) : null
          }
        />
      ) : rec ? (
        <RecordSummaryModal record={rec} onClose={closeRecord} />
      ) : null}

      {/* 附件上传：一个复用的隐藏 input，`attTargetRef` 指向目标记录 */}
      <input
        ref={attRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => void addAttach(attTargetRef.current, e.target.files, filesOfRecord(attTargetRef.current))}
      />
    </>
  );

  /**
   * 行内展开（「我的 IDP」用）：只出内容卡片，不带 modal 外壳 ——
   * 展开区嵌在表格行里，再套一层遮罩就点不动别处了。
   */
  if (variant === 'inline') {
    return (
      <>
        <div style={inlinePanelStyle}>{cards}</div>
        {popups}
      </>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(880px, 100%)' }}>
        <div className="detail-modal-head">
          <div>
            <h3 className="detail-modal-title">
              {target.studentName}
              {target.cls ? <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>{target.cls}</span> : null}
            </h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
              {target.configName}
              {data?.rangeText ? ` · ${t('rangeIs', { range: data.rangeText })}` : ''}
              {` · ${t('commCountIs', { n: count })}`}
            </div>
          </div>
          {/* 关闭一律用右上角的 ×（全站弹窗统一这个定式，不再放文字「关闭」按钮） */}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title={t('close')} aria-label={t('close')}>
            ×
          </button>
        </div>

        <div className="detail-modal-body" style={{ whiteSpace: 'normal' }}>
          {cards}
        </div>

        {popups}

        <div className="detail-modal-foot">
          <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>
            {t('footerHint')}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title={t('close')} aria-label={t('close')}>
            ×
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * 「这条记录**没有**关联笔记」时点标题看到的内容：沟通总结 / 沟通明细。
 *
 * 为什么按 id 再拉一次详情，而不是让列表接口把明细一起带回来：
 * 沟通明细可能是逐字稿（生产实测最长 3.8 万字），20 条一起返回就是几十万字 ——
 * 打开一次面板的代价会高到不可接受。点开哪条才拉哪条，代价刚好。
 *
 * 查看用**只读**的 Markdown 组件（不传 onChange ⇒ 只有「浏览」一个 Tab）：
 * 能改的那一份在「记录一次沟通」表单里，两边都是同一个组件 → 呈现与录入一致。
 */
function RecordSummaryModal({
  record,
  onClose,
}: {
  record: MyIdpComms['rows'][number];
  onClose: () => void;
}) {
  const t = useTranslations('myIdp');
  const [tab, setTab] = useState<'summary' | 'detail'>('summary');
  const [fields, setFields] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');

  /**
   * 这条记录自带的录音（附件里的音频）。
   * 弹窗里用**原生 controls 播放器**（与笔记详情弹窗同一个样子，进度条可拖）——
   * 行内那个 ▶ 只是个开关，听细节还得能拖进度。
   */
  const audio = ((record.files ?? []) as Attach[]).find((f) => isAudioFile(f));

  useEffect(() => {
    let alive = true;
    setFields(null);
    setErr('');
    api
      .getStudentRecord(record.id)
      .then((r) => {
        if (!alive) return;
        // 详情可能把字段包在 fields 里，也可能直接铺平 —— 两种都认（免得维度一变就白屏）
        const flat = (
          r && typeof r === 'object' && 'fields' in (r as Record<string, unknown>)
            ? (r as Record<string, unknown>).fields
            : r
        ) as Record<string, unknown> | undefined;
        setFields(flat ?? {});
      })
      .catch((e) => {
        if (alive) setErr(errMsg(e));
      });
    return () => {
      alive = false;
    };
  }, [record.id]);

  return (
    <div
      className="modal-overlay"
      style={{ zIndex: 70 }}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="detail-modal" style={{ width: 'min(860px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="detail-modal-head">
          <div>
            <h3 className="detail-modal-title">{record.subject || t('noSubject')}</h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
              {fmtTime(record.time)}
              {record.way ? ` · ${record.way}` : ''}
              {record.person ? ` · ${record.person}` : ''}
              {record.status ? ` · ${record.status}` : ''}
            </div>
          </div>
          {/* 关闭一律用右上角的 ×（全站弹窗统一这个定式） */}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            title={t('close')}
            aria-label={t('close')}
          >
            ×
          </button>
        </div>
        <div className="detail-modal-body" style={{ whiteSpace: 'normal' }}>
          {/* 录音播放器：这条记录的声音就在这儿（附件里的音频，走通用附件接口） */}
          {audio ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 12,
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                🎧 {t('audio')}
              </span>
              <audio
                controls
                preload="none"
                style={{ flex: 1, height: 32 }}
                src={attachmentAudioSrc(audio.file_token)}
              />
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 8, marginBottom: 11 }}>
            <button
              type="button"
              className={tab === 'summary' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
              onClick={() => setTab('summary')}
            >
              {t('tabSummary')}
            </button>
            <button
              type="button"
              className={tab === 'detail' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
              onClick={() => setTab('detail')}
            >
              {t('tabDetail')}
            </button>
          </div>
          {err ? <div className="notice notice-error">{err}</div> : null}
          {!fields && !err ? <div className="muted">{t('loading')}</div> : null}
          {fields ? (
            <MarkdownField
              value={String((tab === 'summary' ? fields['沟通总结'] : fields['沟通明细']) ?? '')}
              height={300}
              emptyText={tab === 'summary' ? t('noSummary') : t('noDetail')}
            />
          ) : null}
        </div>
        <div className="detail-modal-foot">
          <a
            className="btn btn-outline btn-sm"
            style={{ marginRight: 'auto' }}
            href={`/student-records/${record.id}`}
            target="_blank"
            rel="noreferrer"
          >
            {t('openRecord')}
          </a>
        </div>
      </div>
    </div>
  );
}
