'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api, type GetnoteLink, type MyIdpComms } from '../lib/api';
import NotePanel from './NotePanel';

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
 *   · 「手动再添加笔记里的 IDP 记录」= 下面每条的「关联笔记」面板（`NotePanel`），
 *     它与学生记录详情页用的是**同一个组件**（标签 + 映射表双写机制已具备）。
 *
 * ⚠️ 附件字段名是「沟通附件清单」（**可写**）。学生记录 meta 的 `readonly` 里那条是
 *    「沟通附件」（少一个字，是另一个字段）—— 别搞混，写进 readonly 的会被静默丢弃。
 *
 * ## 「导入笔记」（2026-09-26 新增）
 *
 * 峰哥要的：老师把自己在「我的笔记」里记的笔记**批量**挂到这个学生的 IDP 上，
 * 不用先搜索再一篇篇关联（`NotePanel` 那条路只有语义召回、一次只能加一篇）。
 *
 * 关联目标 = **本学生在本次配置里的 IDP 明细行**（`entityType='IDP学生'`、
 * `entityId = target.detailId`）。为什么不挂「学生档案」：峰哥明确要的是「和学生的 IDP
 * 关联」——挂明细行才表达得出"这篇笔记属于这个学生这一次 IDP"，
 * 而且「已导入」的判据才精确（挂学生档案会把别的场景关联的笔记一并算进来）。
 *
 * 🔴 写入是**全量覆盖式**（`PUT /getnote/links`，与 NotePanel / 邮件归档同一范式）：
 *    提交时必须带上**已有的全部关联**（`imported`），只发新增的会把旧的悄悄清掉。
 *
 * 🔴 权限与可见性（峰哥 2026-09-26 定的口径）：
 *    · 写关联要 `module:getnote:update`，生产实测 Phase1~Phase8 只有 read ⇒ 已补；
 *    · **候选列表只列老师自己的笔记**（`GET /getnote/notes?mine=1`，见 `NoteListFilters.mine`）——
 *      默认口径会在"被关联到知识库配置"时列出该配置下所有人的笔记，那不是导入场景要的；
 *      系统管理员不吃这个参数，仍然看得到全部（他本来就该看到全部）；
 *    · 「已导入的笔记」是**协作可见**的（IDP 是共享对象，同事导入的也在），
 *      所以每条标注导入人（`linkedBy`）—— 不标就分不清是谁挂上去的。
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
  /**
   * 「IDP学生」明细行的 record id —— 「导入笔记」的关联目标。
   * 两个入口（IDP 配置页 / 我的 IDP 页）都能从行数据里拿到；拿不到时导入功能禁用。
   */
  detailId?: string;
}

/** 附件条目形态：与学生记录「沟通附件清单」的存储一致（CrudPage 也按这个结构读） */
interface Attach {
  file_token: string;
  name: string;
  size?: number;
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'baseline',
  padding: '10px 0',
  borderTop: '1px solid var(--border)',
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
}: {
  target: IdpCommTarget;
  onClose: () => void;
  /** 新建成功后的回调（父页面用它刷新沟通次数） */
  onSaved?: () => void;
}) {
  const t = useTranslations('myIdp');
  const [data, setData] = useState<MyIdpComms | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 展开「关联笔记」面板的记录 id（一次只开一个，避免十几个面板同时拉数据） */
  const [noteFor, setNoteFor] = useState('');

  // 新建表单
  const [subject, setSubject] = useState('');
  const [when, setWhen] = useState(nowLocal);
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [atts, setAtts] = useState<Attach[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── 导入笔记 ──────────────────────────────────────────────
  /** 右侧面板是否展开 */
  const [importOpen, setImportOpen] = useState(false);
  /** 已导入到本学生 IDP 的笔记（全量覆盖式写入的**基准**，见文件头注释） */
  const [imported, setImported] = useState<GetnoteLink[]>([]);
  /** 候选笔记（我的笔记，已过滤掉已导入的） */
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

  const detailId = target.detailId ?? '';

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

  /** 已导入的笔记 —— 打开面板时拉一次，导入/解除后重拉 */
  const loadImported = useCallback(async () => {
    if (!detailId) return;
    try {
      setImported(await api.listGetnoteLinks('IDP学生', detailId));
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [detailId]);

  /** 我的笔记 − 已导入 = 候选。`reset` 为假时按 `pageToken` 追加下一页。 */
  const loadCands = useCallback(
    async (reset: boolean) => {
      setCandsLoading(true);
      try {
        // 🔴 `mine=1`：只列**我自己的**笔记。默认口径在"被关联到知识库配置"时会列出
        //    该配置下的全部笔记（含同事的）—— 那是知识库页面的语义，不是导入场景要的。
        const params: Record<string, string | undefined> = { pageSize: '100', mine: '1' };
        if (kw.trim()) params.q = kw.trim();
        if (!reset && candsToken) params.pageToken = candsToken;
        const r = await api.listGetnote(params);
        const linked = new Set(imported.map((l) => l.noteId));
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
    [kw, candsToken, imported],
  );

  /**
   * 打开面板：先拿「已导入」再拉候选。
   * 🔴 顺序不能反 —— 候选要按已导入的 noteId 过滤，反了会把已导入的也列出来。
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

    let linked: GetnoteLink[] = [];
    if (detailId) {
      try {
        linked = await api.listGetnoteLinks('IDP学生', detailId);
        setImported(linked);
      } catch (e) {
        setErr(errMsg(e));
      }
    }
    setCandsLoading(true);
    try {
      // 同 `loadCands`：只列我自己的笔记（`mine=1`）
      const r = await api.listGetnote({ pageSize: '100', mine: '1' });
      const linkedIds = new Set(linked.map((l) => l.noteId));
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
   * 关键词搜索（防抖 350ms，与 `NotePanel` 同节奏）。
   *
   * ⚠️ 依赖里刻意**不写** `loadCands`：它依赖 `candsToken`，翻页后就会变化，
   *    写进去会在每次翻页后自己触发一次多余的重搜、把用户翻到的页冲掉。
   *    这里唯一需要的语义是"关键词变了就重搜"。
   */
  useEffect(() => {
    if (!importOpen) return;
    const timer = setTimeout(() => {
      void loadCands(true);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw, importOpen]);

  /** 全量覆盖式写入：`next` 必须是**最终完整名单**（传空数组即清空） */
  const persistLinks = async (next: { noteId: string; title?: string }[]) => {
    await api.replaceGetnoteLinks('IDP学生', detailId, target.studentName, next);
    await loadImported();
  };

  const doImport = async () => {
    if (!picked.size) return;
    setImporting(true);
    setErr('');
    setFlash('');
    try {
      const add = [...picked].map((id) => ({
        noteId: id,
        title: cands.find((c) => c.noteId === id)?.title ?? '',
      }));
      // 🔴 必须带上已有的：接口是全量覆盖，只发新增会把旧的清掉
      await persistLinks([...imported.map((l) => ({ noteId: l.noteId, title: l.title })), ...add]);
      setFlash(t('importDone', { n: add.length }));
      setPicked(new Set());
      await loadCands(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setImporting(false);
    }
  };

  const unlinkNote = async (noteId: string) => {
    setImporting(true);
    setErr('');
    setFlash('');
    try {
      await persistLinks(
        imported.filter((l) => l.noteId !== noteId).map((l) => ({ noteId: l.noteId, title: l.title })),
      );
      await loadCands(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setImporting(false);
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
        记录类型: 'IDP沟通',
        // 「关联学生编号」在 meta 的 readonly 里 ⇒ 显式传也会被过滤；靠 linkBackfill
        // 按姓名回填（见 lifecycle.meta 的 linkBackfill 注释）
        关联学生: target.studentName,
        沟通主题: subject.trim(),
        沟通时间: when,
        沟通总结: summary,
        沟通明细: detail,
        沟通附件清单: atts,
        沟通人: target.meName ?? '',
      });
      setSubject('');
      setSummary('');
      setDetail('');
      setAtts([]);
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

  const count = data?.rows.length ?? 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="detail-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: importOpen ? 'min(1180px, 100%)' : 'min(820px, 100%)' }}
      >
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
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('close')}
          </button>
        </div>

        <div
          className="detail-modal-body"
          style={{ whiteSpace: 'normal', display: importOpen ? 'flex' : 'block', gap: 18, alignItems: 'flex-start' }}
        >
          {/* ── 左栏：沟通记录 ─────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>
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

          {/* ── 新建一次沟通：走学生记录的 create（附件/录音/AI 总结全都共用现成能力） ── */}
          {target.archived ? (
            <div className="muted" style={{ marginBottom: 10, fontSize: 12.5 }}>
              {t('archivedReadonly')}
            </div>
          ) : openForm ? (
            <div className="card" style={{ padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  className="form-input"
                  style={{ flex: '1 1 240px' }}
                  placeholder={t('fSubject')}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
                <input
                  className="form-input"
                  style={{ width: 190 }}
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </div>
              <textarea
                className="form-input"
                style={{ marginTop: 8, minHeight: 64 }}
                placeholder={t('fSummary')}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
              <textarea
                className="form-input"
                style={{ marginTop: 8, minHeight: 90 }}
                placeholder={t('fDetail')}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
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
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setOpenForm(true)}
              >
                ＋ {t('addComm')}
              </button>
              {/* 「导入笔记」：批量把「我的笔记」挂到这个学生的 IDP 上（见文件头注释） */}
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={!detailId}
                title={detailId ? undefined : t('importNoDetail')}
                onClick={() => (importOpen ? closeImport() : void openImport())}
              >
                {importOpen ? t('close') : t('importNotes')}
              </button>
            </div>
          )}

          {/* ── 已导入的笔记：导入结果必须看得见，否则"导进去了没"无从判断 ── */}
          {detailId && imported.length > 0 ? (
            <div className="card" style={{ padding: 10, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t('importedTitle')}</span>
                <span className="muted" style={{ fontSize: 12 }}>{t('importedN', { n: imported.length })}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {imported.map((l) => (
                  <span
                    key={l.id}
                    title={l.noteId}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 6px',
                      borderRadius: 6,
                      background: 'var(--accent-muted)',
                      color: 'var(--accent)',
                      fontSize: 12.5,
                    }}
                  >
                    {l.title || l.noteId}
                    {/* 谁导的：IDP 是协作对象（同事导入的笔记也看得到），标出来才不含糊 */}
                    {l.linkedBy ? (
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{l.linkedBy}</span>
                    ) : null}
                    <button
                      type="button"
                      title={t('unlinkNote')}
                      disabled={importing}
                      onClick={() => void unlinkNote(l.noteId)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        fontSize: 13,
                        lineHeight: 1,
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
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
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{r.subject || t('noSubject')}</div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {fmtTime(r.time)}
                      {r.person ? ` · ${r.person}` : ''}
                      {r.attachments ? ` · 📎 ${r.attachments}` : ''}
                      {r.status ? ` · ${r.status}` : ''}
                    </div>
                    {r.summary ? (
                      <div style={{ fontSize: 13, marginTop: 4, color: 'var(--fg-secondary)' }}>
                        {r.summary.length > 120 ? `${r.summary.slice(0, 120)}…` : r.summary}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {/* 「手动再添加笔记里的 IDP 记录」：与详情页同一个面板（标签 + 映射表双写） */}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setNoteFor((cur) => (cur === r.id ? '' : r.id))}
                    >
                      {t('notes')}
                    </button>
                    <a className="btn btn-ghost btn-sm" href={`/student-records/${r.id}`} target="_blank" rel="noreferrer">
                      {t('open')}
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}

          {noteFor ? (
            <div style={{ marginTop: 12 }}>
              <NotePanel entityType="IDP沟通" entityId={noteFor} entityName={target.studentName} />
            </div>
          ) : null}
          </div>

          {/* ── 右栏：从「我的笔记」导入 ───────────────────────── */}
          {importOpen ? (
            <aside
              style={{
                width: 380,
                flexShrink: 0,
                borderLeft: '1px solid var(--border)',
                paddingLeft: 16,
                alignSelf: 'stretch',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t('importTitle')}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeImport}>
                  {t('close')}
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
                  <input
                    className="form-input"
                    style={{ width: '100%', marginBottom: 8 }}
                    placeholder={t('importSearch')}
                    value={kw}
                    onChange={(e) => setKw(e.target.value)}
                  />

                  <div
                    style={{
                      maxHeight: 340,
                      overflowY: 'auto',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 6,
                    }}
                  >
                    {candsLoading && cands.length === 0 ? (
                      <div className="muted" style={{ fontSize: 12.5, padding: 6 }}>{t('importLoading')}</div>
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
                                <span className="muted" style={{ fontSize: 11.5 }}>{fmtDay(n.createdAt)}</span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })
                    )}
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
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {t('importSelectedN', { n: picked.size })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ marginLeft: 'auto' }}
                      disabled={importing || picked.size === 0}
                      onClick={() => void doImport()}
                    >
                      {importing ? t('importing') : t('importConfirm')}
                    </button>
                  </div>
                </>
              )}
            </aside>
          ) : null}
        </div>

        <div className="detail-modal-foot">
          <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>
            {t('footerHint')}
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}
