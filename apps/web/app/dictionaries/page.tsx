'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api';

type DictMap = Record<string, string[]>;

export default function DictionariesPage() {
  const [dicts, setDicts] = useState<DictMap>({});
  const [drafts, setDrafts] = useState<DictMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState('');

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.dictionaries();
      setDicts(data);
      setDrafts(JSON.parse(JSON.stringify(data)));
    } catch (e) {
      setError((e as Error).message || '加载失败');
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

  const syncToBase = async () => {
    setSyncing(true);
    try {
      const res = (await api.syncDictionaries()) as {
        synced?: string[];
        skipped?: string[];
        errors?: string[];
      };
      const ok = (res.synced ?? []).length;
      const err = (res.errors ?? []).length;
      flash(`已同步到飞书 Base：成功 ${ok}${err ? `，失败 ${err}` : ''}`);
    } catch (e) {
      flash(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const addOption = (key: string, value: string) => {
    const v = value.trim();
    if (!v) return;
    setDrafts((d) => {
      const cur = d[key] ?? [];
      if (cur.includes(v)) return d;
      return { ...d, [key]: [...cur, v] };
    });
  };

  const removeOption = (key: string, value: string) => {
    setDrafts((d) => ({ ...d, [key]: (d[key] ?? []).filter((o) => o !== value) }));
  };

  const keys = Object.keys(drafts);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="eyebrow">系统 / 字典数据</div>
          <h1 className="page-title">字典数据</h1>
          <p className="page-subtitle">
            维护各表单下拉项的候选项。修改后点击「保存」持久化；再点「同步到飞书 Base」将新选项写入对应字段。
          </p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-outline" onClick={syncToBase} disabled={syncing}>
            {syncing ? '同步中…' : '同步到飞书 Base'}
          </button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {loading && <div className="empty-state">加载中…</div>}
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
                  {options.length === 0 && <div className="dict-empty">暂无选项</div>}
                  {options.map((opt) => (
                    <span className="dict-option" key={opt}>
                      {opt}
                      <button
                        className="dict-option-remove"
                        onClick={() => removeOption(key, opt)}
                        title="移除"
                        aria-label={`移除 ${opt}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <AddRow onAdd={(v) => addOption(key, v)} />
                <div className="dict-card-foot">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => save(key)}
                    disabled={savingKey === key || !dirty}
                  >
                    {savingKey === key ? '保存中…' : '保存'}
                  </button>
                  {dirty && <span className="dict-dirty">有未保存的修改</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddRow({ onAdd }: { onAdd: (v: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <div className="dict-add-row">
      <input
        className="input"
        placeholder="新增选项，回车确认"
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
