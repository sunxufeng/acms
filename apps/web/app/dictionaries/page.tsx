'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { api, type DictOption } from '../../lib/api';
import { useTl } from '../../lib/useTl';

type DictMap = Record<string, DictOption[]>;

export default function DictionariesPage() {

  const tl = useTl();
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [dicts, setDicts] = useState<DictMap>({});
  const [drafts, setDrafts] = useState<DictMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  /* 新增字典类型状态 */
  const [showNewDict, setShowNewDict] = useState(false);
  const [newDictName, setNewDictName] = useState('');
  const [newDictInitOption, setNewDictInitOption] = useState('');
  const [creating, setCreating] = useState(false);

  /* 正在编辑的选项：{ key(字典 key), optKey(选项 key) } */
  const [editingOpt, setEditingOpt] = useState<{ key: string; optKey: string } | null>(null);

  /* 拖拽排序：当前正在拖拽的项位置 */
  const [dragIdx, setDragIdx] = useState<{ key: string; idx: number } | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const meta = await api.dictionaryMeta();
      setDicts(meta.options);
      setDrafts(JSON.parse(JSON.stringify(meta.options)));
    } catch (e) {
      setError((e as Error).message || tc('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (key: string) => {
    setSavingKey(key);
    try {
      const res = await api.updateDictionary(key, drafts[key] ?? []);
      setDicts((d) => ({ ...d, [key]: res.options }));
      flash(`「${key}」已保存（${res.options.length} 项）`);
    } catch (e) {
      flash(`保存失败：${(e as Error).message}`);
    } finally {
      setSavingKey(null);
    }
  };

  /** 新增选项：key 默认等于 label（向后兼容存量记录） */
  const addOption = (key: string, value: string) => {
    const v = value.trim();
    if (!v) return;
    setDrafts((d) => {
      const cur = d[key] ?? [];
      if (cur.some((o) => o.key === v || o.label === v)) return d;
      return { ...d, [key]: [...cur, { key: v, label: v }] };
    });
  };

  /** 移除选项（按 key，稳定标识） */
  const removeOption = (key: string, optKey: string) => {
    setDrafts((d) => ({ ...d, [key]: (d[key] ?? []).filter((o) => o.key !== optKey) }));
  };

  /**
   * 重命名已有选项：保留 key（= 旧 label），仅改 label，并把旧 label 记入 aliases。
   * 这样存量记录里存的旧值经 resolve 仍能显示为新名，不会新旧并存。
   */
  const renameOption = (key: string, oldKey: string, newLabel: string) => {
    const v = newLabel.trim();
    if (!v || v === oldKey) {
      setEditingOpt(null);
      return;
    }
    setDrafts((d) => {
      const cur = d[key] ?? [];
      // 不能和别的选项（其 label 或 aliases）重复
      if (cur.some((o) => o.key !== oldKey && (o.label === v || o.aliases?.includes(v)))) return d;
      return {
        ...d,
        [key]: cur.map((o) =>
          o.key === oldKey
            ? { ...o, label: v, aliases: Array.from(new Set([...(o.aliases ?? []), oldKey])) }
            : o,
        ),
      };
    });
    setEditingOpt(null);
  };

  /** 拖拽 / 上下移：重排某个字典内的选项顺序（保存时按此顺序持久化） */
  const moveOption = (key: string, from: number, to: number) => {
    if (from === to) return;
    setDrafts((d) => {
      const cur = [...(d[key] ?? [])];
      if (from < 0 || from >= cur.length || to < 0 || to >= cur.length) return d;
      const [moved] = cur.splice(from, 1);
      cur.splice(to, 0, moved);
      return { ...d, [key]: cur };
    });
  };

  /** 创建新字典类型 */
  const createDict = async () => {
    const name = newDictName.trim();
    if (!name) { flash('请输入字典名称'); return; }
    if (drafts[name]) { flash('该字典已存在'); return; }
    const initOpts = newDictInitOption.trim()
      ? [newDictInitOption.trim()]
      : [];

    setCreating(true);
    try {
      const res = await api.updateDictionary(name, initOpts);
      setDicts((d) => ({ ...d, [name]: res.options }));
      setDrafts((d) => ({ ...d, [name]: res.options }));
      flash(`新字典「${name}」已创建`);
      setShowNewDict(false);
      setNewDictName('');
      setNewDictInitOption('');
    } catch (e) {
      flash(`创建失败：${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const keys = Object.keys(drafts);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">{tl('系统 / 字典数据')}</div>
          <h1 className="page-title">{tl('字典数据')}</h1>
          <p className="page-subtitle">
            维护各表单下拉项的候选项。修改后点击「保存」持久化即可（字段选项已本地化，无需再同步飞书）。
            重命名选项会保留旧名（别名），存量记录自动兼容，不会新旧并存。
          </p>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {loading && <div className="empty-state">{tl('加载中…')}</div>}
      {error && <div className="empty-state empty-state--error">{error}</div>}

      {!loading && !error && (
        <div className="dict-grid">
          {keys.map((key) => {
            const options = drafts[key] ?? [];
            const dirty = JSON.stringify(dicts[key]) !== JSON.stringify(drafts[key]);
            return (
              <div className="dict-card" key={key}>
                <div className="dict-card-head">
                  <span className="dict-card-title">{key}</span>
                  <span className="dict-count">{options.length}</span>
                </div>
                <div className="dict-options">
                  {options.length === 0 && <div className="dict-empty">{tl('暂无选项')}</div>}
                  {options.map((opt, idx) => {
                    const isEditing =
                      editingOpt?.key === key && editingOpt?.optKey === opt.key;
                    const aliasHint = opt.aliases?.length
                      ? tl('曾用') + '：' + opt.aliases.join('、')
                      : undefined;
                    if (isEditing) {
                      return (
                        <EditableOption
                          key={opt.key}
                          value={opt.label}
                          onBlur={(v) => renameOption(key, opt.key, v)}
                          onCancel={() => setEditingOpt(null)}
                          autoFocus
                        />
                      );
                    }
                    const isDragging = dragIdx?.key === key && dragIdx.idx === idx;
                    return (
                      <span
                        className={`dict-option${isDragging ? ' dragging' : ''}`}
                        key={opt.key}
                        draggable
                        title={aliasHint}
                        onDragStart={(e) => {
                          setDragIdx({ key, idx });
                          e.dataTransfer.effectAllowed = 'move';
                          e.stopPropagation();
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragIdx && dragIdx.key === key && dragIdx.idx !== idx) {
                            moveOption(key, dragIdx.idx, idx);
                          }
                          setDragIdx(null);
                        }}
                        onDragEnd={() => setDragIdx(null)}
                        onDoubleClick={() => setEditingOpt({ key, optKey: opt.key })}
                      >
                        <span className="dict-drag-handle" title={tl('拖拽排序')}>⠿</span>
                        <span className="dict-opt-label">{opt.label}</span>
                        {aliasHint && <span className="dict-opt-alias" title={aliasHint}>↺</span>}
                        <span className="dict-opt-actions">
                          <button
                            type="button"
                            className="dict-option-move"
                            onClick={() => moveOption(key, idx, idx - 1)}
                            disabled={idx === 0}
                            title={tl('上移')}
                            aria-label={`上移 ${opt.label}`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="dict-option-move"
                            onClick={() => moveOption(key, idx, idx + 1)}
                            disabled={idx === options.length - 1}
                            title={tl('下移')}
                            aria-label={`下移 ${opt.label}`}
                          >
                            ↓
                          </button>
                          <button
                            className="dict-option-remove"
                            onClick={() => removeOption(key, opt.key)}
                            title={tl('移除')}
                            aria-label={`移除 ${opt.label}`}
                          >
                            ×
                          </button>
                        </span>
                      </span>
                    );
                  })}
                </div>
                <AddRow onAdd={(v) => addOption(key, v)} />
                <div className="dict-card-foot">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => save(key)}
                    disabled={savingKey === key || !dirty}
                  >
                    {savingKey === key ? tc('saving') : tc('save')}
                  </button>
                  {dirty && <span className="dict-dirty">{tl('有未保存的修改')}</span>}
                </div>
              </div>
            );
          })}

          {/* 新增字典类型卡片 */}
          {!showNewDict ? (
            <div className="dict-card dict-new-card" onClick={() => setShowNewDict(true)}>
              <span style={{ fontSize: '2rem', color: 'var(--fg-tertiary)' }}>+</span>
              <span style={{ color: 'var(--fg-secondary)' }}>{tl('新增字典类型')}</span>
            </div>
          ) : (
            <div className="dict-card dict-new-form">
              <div className="dict-card-head">
                <span className="dict-card-title">{tl('新增字典类型')}</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setShowNewDict(false); setNewDictName(''); setNewDictInitOption(''); }}
                >
                  取消
                </button>
              </div>
              <input
                className="input"
                placeholder={tl('字典名称（如：自定义分类）')}
                value={newDictName}
                onChange={(e) => setNewDictName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createDict()}
              />
              <input
                className="input"
                placeholder={tl('第一个选项（可选，留空则创建空字典）')}
                value={newDictInitOption}
                onChange={(e) => setNewDictInitOption(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createDict()}
              />
              <div className="dict-card-foot">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={createDict}
                  disabled={creating || !newDictName.trim()}
                >
                  {creating ? t('creating') : t('create')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 可内联编辑的选项标签 */
function EditableOption({
  value,
  onBlur,
  onCancel,
  autoFocus,
}: {
  value: string;
  onBlur: (val: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [val, setVal] = useState(value);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [autoFocus]);

  return (
    <span className="dict-option editing">
      <input
        ref={ref}
        className="dict-edit-input"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => onBlur(val)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { onCancel(); }
        }}
      />
    </span>
  );
}

function AddRow({ onAdd }: { onAdd: (v: string) => void }) {
  const tl = useTl();
  const [val, setVal] = useState('');
  return (
    <div className="dict-add-row">
      <input
        className="input"
        placeholder={tl('新增选项，回车确认')}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onAdd(val);
            setVal('');
          }
        }}
      />
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => {
          onAdd(val);
          setVal('');
        }}
      >
        添加
      </button>
    </div>
  );
}
