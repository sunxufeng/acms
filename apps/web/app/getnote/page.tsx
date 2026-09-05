'use client';

import { useCallback, useEffect, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { useTranslations } from 'next-intl';

/**
 * 把 Get笔记 的 note 对象适配成 CrudPage 的行数据。
 *
 * ⚠️ 两条硬约束：
 * 1. **CrudPage 用 `row.id` 作行键**（取值、编辑、删除全走它），而 Get笔记 的 ID 字段叫
 *    `note_id`，且是 int64 的字符串形态 —— 映射过去，**绝不能转 Number**（会丢精度，
 *    末几位变 0，导致编辑/删除命中错误的笔记）。
 * 2. `tags` 是对象数组 `[{id,name,type}]`，列表里渲染成「、」连接的名称串。
 */
function toRow(n: Record<string, unknown>): Record<string, unknown> {
  const tags = Array.isArray(n.tags) ? (n.tags as { name?: string }[]) : [];
  return {
    ...n,
    id: String(n.note_id ?? n.id ?? ''),
    标签: tags.map((t) => t?.name).filter(Boolean).join('、'),
  };
}

/**
 * 表单提交前的转换：把「标签」文本拆成数组。
 * Get笔记 的 tags 是**替换语义**（传了就整体覆盖原标签），所以要显式拆成数组再提交。
 */
function withTags(d: Record<string, unknown>): Record<string, unknown> {
  const raw = d.标签;
  const list =
    typeof raw === 'string'
      ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(raw)
        ? (raw as string[])
        : undefined;
  const { 标签, ...rest } = d;
  return { ...rest, ...(list ? { tags: list } : {}) };
}

const COLUMNS: CrudColumn[] = [
  { key: 'title', label: '标题', form: true, type: 'text', required: true, width: '280px', listOrder: 1 },
  { key: 'note_type', label: '类型', width: '100px', listOrder: 2 },
  {
    key: '标签',
    label: '标签',
    form: true,
    type: 'text',
    width: '180px',
    listOrder: 3,
    hint: '多个标签用逗号分隔；保存后会整体替换原有标签',
  },
  { key: 'updated_at', label: '更新时间', width: '170px', listOrder: 4 },
  { key: 'content', label: '正文', form: true, type: 'textarea', list: false, listOrder: 5 },
];

/**
 * ⚠️ 每页条数必须与 Get笔记 服务端返回的单页条数一致。
 * Get笔记 的列表接口**不支持自定义 pageSize**，而 CrudPage 用 `total / pageSize` 推算总页数，
 * 两边不一致会让分页条显示的页数不对。拿到 API Key 实测后校准这个常量。
 */
const PAGE_SIZE = 20;

interface Cred {
  configured: boolean;
  masked: string;
  updatedAt: string;
  verifiedAt: string;
  clientIdConfigured: boolean;
}

export default function GetnotePage() {
  const tl = useTl();
  const t = useTranslations('getnote');

  const [cred, setCred] = useState<Cred | null>(null); // null = 加载中
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const load = useCallback(() => {
    api
      .getGetnoteCredential()
      .then(setCred)
      .catch(() => setCred(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await api.saveGetnoteCredential(input.trim());
      setInput('');
      setOk(t('keySaved'));
      load();
    } catch (e) {
      const m = (e as Error).message ?? '';
      setErr(m.includes('gk_') ? t('keyFormatError') : t('keyVerifyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('confirmRemoveKey'))) return;
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await api.clearGetnoteCredential();
      setOk('');
      load();
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Key 输入表单。三种场景共用：未配置引导、折叠区展开、服务器未就绪时不渲染。 */
  const form = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <input
        type="password"
        value={input}
        placeholder="gk_live_xxx"
        onChange={(e) => setInput(e.target.value)}
        style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13 }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !input.trim()}
          onClick={save}
        >
          {busy ? t('keySaving') : t('save')}
        </button>
        {cred?.configured && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={remove}>
            {t('removeKey')}
          </button>
        )}
      </div>
      {err && <span style={{ color: 'var(--fg-error)', fontSize: 12 }}>{err}</span>}
      {ok && (
        <span className="muted" style={{ fontSize: 12 }}>
          {ok}
        </span>
      )}
    </div>
  );

  if (cred === null) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          {t('loading')}
        </p>
      </div>
    );
  }

  // Client ID 是应用级的，服务器配一份。没配属于运维问题，用户自己解决不了。
  if (!cred.clientIdConfigured) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          {t('clientIdMissing')}
        </p>
      </div>
    );
  }

  // 用户还没配自己的 Key：整页引导，不进列表
  if (!cred.configured) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          {t('keyIntro')}
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          {t('keyHowTo')}
        </p>
        {form}
      </div>
    );
  }

  return (
    <>
      <div className="card" style={{ padding: '10px 16px', margin: '24px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            {t('keySet', { masked: cred.masked })}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setOpen((v) => !v);
              setErr('');
              setOk('');
            }}
          >
            {open ? t('cancel') : t('setKey')}
          </button>
        </div>
        {open && form}
      </div>

      <CrudPage
        title="知识库"
        subtitle="得到大脑笔记"
        columns={COLUMNS}
        pageSize={PAGE_SIZE}
        inlineEdit
        standaloneForm
        search={{ placeholder: t('searchPlaceholder') }}
        api={{
          list: async (p) => {
            const res = await api.listGetnote(p);
            return { ...res, items: res.items.map(toRow) };
          },
          create: (d) => api.createGetnote(withTags(d)),
          update: (id, d) => api.updateGetnote(id, withTags(d)),
          // 删除 = 移入回收站，可恢复
          archive: (id) => api.deleteGetnote(id),
        }}
      />
    </>
  );
}
