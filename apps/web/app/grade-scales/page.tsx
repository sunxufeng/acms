'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/permissions';
import { formatDateTime } from '../../lib/date';

/**
 * 成绩等级体系 + 等级（含**绩点**）（教学管理，2026-09-20 补页面）。
 *
 * 一屏两层，因为它们是一件事的两级：
 *   等级体系（`gradeScale`）─┬─ 等级（`gradeScaleLevel`）
 *                            ├─ 被成绩册列 / 成绩批次引用
 *                            └─ 等级上的「绩点」是 GPA 与班级排名的**唯一**来源
 *
 * 为什么必须有这个页面：ACMS 不做学分制，GPA 只能靠「等级 → 绩点」映射算出来。
 * 此前等级体系没有页面（只有接口），于是报表里的 GPA / 排名一直是空的，
 * 页面只提示「未配置绩点」却无处可配 —— 死循环。
 *
 * 🔴 判据方向（写在提示里，避免配反）：
 *  - **等级「序号」越小越好**（1 = 最好）
 *  - 「是否达标」= 条目等级序号 **≤** 学生个人目标序号（不是分数比及格线）
 *  - 「是否计入GPA = 否」的档不进 GPA（如「免考」「未评」这类档，绩点留空即可）
 *
 * 权限：整页（含 `/grade-scale-levels`）走 `module:gradeScales:*` —— 两级配置同属一个模块，
 * 分开授权会出现「能改体系、却改不了体系里的等级」这种半开门。
 */
interface Scale {
  id: string;
  名称: string;
  是否默认?: string;
  状态?: string;
  排序?: number | string;
  说明?: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export default function GradeScalesPage() {
  const t = useTranslations('teaching');
  const perms = usePermissions();
  const canCreate = perms.includes('module:gradeScales:create');
  const canUpdate = perms.includes('module:gradeScales:update');
  const canDelete = perms.includes('module:gradeScales:delete');

  const [scales, setScales] = useState<Scale[]>([]);
  const [activeId, setActiveId] = useState('');
  /** 正在新建/编辑的体系（null = 没在编辑；无 id = 新建） */
  const [draft, setDraft] = useState<Partial<Scale> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  /**
   * 拉体系列表。
   *
   * ⚠️ `loadScales` 用 `useCallback([])` 固定身份：它被 effect 依赖，
   * 每次 render 新建函数会让 effect 反复跑（渲染死循环那个老坑）。
   */
  const loadScales = useCallback(async (): Promise<Scale[]> => {
    try {
      const res = await api.gradeScales.list({ pageSize: '200' });
      const items: Scale[] = (res?.items ?? [])
        .map((s) => ({
          id: String((s as { id?: string }).id ?? ''),
          名称: String(s['名称'] ?? ''),
          是否默认: String(s['是否默认'] ?? ''),
          状态: String(s['状态'] ?? ''),
          排序: s['排序'] as number | string | undefined,
          说明: String(s['说明'] ?? ''),
        }))
        .filter((s) => s.id);
      items.sort((a, b) => num(a.排序) - num(b.排序) || a.名称.localeCompare(b.名称, 'zh-CN'));
      setScales(items);
      return items;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void loadScales().then((items) => {
      // 默认选中「是否默认 = 是」的那套；没有就选第一套
      const prefer = items.find((s) => s.是否默认 === '是') ?? items[0];
      if (prefer) setActiveId(prefer.id);
    });
  }, [loadScales]);

  const scaleOptions = useMemo(
    () => scales.map((s) => ({ value: s.id, label: s.名称 || t('unnamed') })),
    [scales, t],
  );
  const activeScale = scales.find((s) => s.id === activeId);

  const saveDraft = async () => {
    if (!draft) return;
    const name = String(draft.名称 ?? '').trim();
    if (!name) {
      setErr(t('errScaleName'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const body: Record<string, unknown> = {
        名称: name,
        是否默认: draft.是否默认 || '否',
        状态: draft.状态 || '启用',
        排序: draft.排序 === '' || draft.排序 == null ? 0 : num(draft.排序),
        说明: draft.说明 ?? '',
      };
      if (draft.id) {
        await api.gradeScales.update(draft.id, body);
      } else {
        const created = await api.gradeScales.create(body);
        const id = String((created as { id?: string })?.id ?? '');
        if (id) setActiveId(id);
      }
      setDraft(null);
      await loadScales();
    } catch (e) {
      setErr(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const removeScale = async (s: Scale) => {
    if (!window.confirm(t('confirmDeleteScale'))) return;
    setBusy(true);
    setErr('');
    try {
      await api.gradeScales.archive(s.id);
      const items = await loadScales();
      if (activeId === s.id) setActiveId(items[0]?.id ?? '');
    } catch (e) {
      setErr(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const sidebar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{t('scaleSidebarTitle')}</span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!canCreate || busy}
          title={canCreate ? undefined : t('noEditPerm')}
          onClick={() => {
            setErr('');
            setDraft({ 名称: '', 是否默认: scales.length === 0 ? '是' : '否', 状态: '启用', 排序: scales.length + 1, 说明: '' });
          }}
        >
          {t('newScale')}
        </button>
      </div>

      {err ? <div style={{ fontSize: 'var(--font-xs)', color: 'var(--danger, #d33)' }}>{err}</div> : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {scales.map((s) => {
          const on = s.id === activeId;
          return (
            <div
              key={s.id}
              onClick={() => {
                setActiveId(s.id);
                setDraft(null);
              }}
              style={{
                cursor: 'pointer',
                padding: '8px 10px',
                borderRadius: 8,
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                background: on ? 'var(--accent-soft)' : 'transparent',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-sm)' }}>
                <span style={{ fontWeight: on ? 600 : 500 }}>{s.名称 || t('unnamed')}</span>
                {s.是否默认 === '是' ? (
                  <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--accent)', color: '#fff' }}>
                    {t('badgeDefault')}
                  </span>
                ) : null}
                {s.状态 === '停用' ? <span className="muted" style={{ fontSize: 11 }}>{t('colStatusStop')}</span> : null}
              </span>
              <span style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={!canUpdate || busy}
                  onClick={() => {
                    setErr('');
                    setDraft({ ...s });
                  }}
                >
                  {t('edit')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={!canDelete || busy}
                  onClick={() => void removeScale(s)}
                >
                  {t('delete')}
                </button>
              </span>
            </div>
          );
        })}
        {scales.length === 0 && !draft ? (
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{t('noScaleYet')}</div>
        ) : null}
      </div>

      {draft ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px dashed var(--border)', borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{draft.id ? t('editScale') : t('newScale')}</div>
          <input
            className="form-input"
            placeholder={t('colScaleName')}
            value={String(draft.名称 ?? '')}
            onChange={(e) => setDraft((d) => ({ ...(d ?? {}), 名称: e.target.value }))}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-sm)' }}>
            <input
              type="checkbox"
              checked={draft.是否默认 === '是'}
              onChange={(e) => setDraft((d) => ({ ...(d ?? {}), 是否默认: e.target.checked ? '是' : '否' }))}
            />
            {t('colScaleDefault')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-sm)' }}>
            <input
              type="checkbox"
              checked={draft.状态 !== '停用'}
              onChange={(e) => setDraft((d) => ({ ...(d ?? {}), 状态: e.target.checked ? '启用' : '停用' }))}
            />
            {t('colStatusActive')}
          </label>
          <input
            className="form-input"
            type="number"
            placeholder={t('colSort')}
            value={String(draft.排序 ?? '')}
            onChange={(e) => setDraft((d) => ({ ...(d ?? {}), 排序: e.target.value }))}
          />
          <input
            className="form-input"
            placeholder={t('colDesc')}
            value={String(draft.说明 ?? '')}
            onChange={(e) => setDraft((d) => ({ ...(d ?? {}), 说明: e.target.value }))}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void saveDraft()}>
              {t('save')}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setDraft(null); setErr(''); }}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  const COLUMNS: CrudColumn[] = useMemo(
    () => [
      {
        key: '显示值',
        label: t('colLevelValue'),
        width: '110px',
        form: true,
        type: 'text',
        required: true,
        hint: t('hintLevelValue'),
      },
      {
        key: '序号',
        label: t('colLevelOrder'),
        width: '80px',
        form: true,
        type: 'number',
        required: true,
        hint: t('hintLevelOrder'),
      },
      { key: '分数下限', label: t('colLevelMin'), width: '100px', form: true, type: 'number', hint: t('hintLevelRange') },
      { key: '分数上限', label: t('colLevelMax'), width: '100px', form: true, type: 'number' },
      {
        key: '绩点',
        label: t('colLevelPoints'),
        width: '90px',
        form: true,
        type: 'number',
        hint: t('hintLevelPoints'),
      },
      {
        key: '是否计入GPA',
        label: t('colLevelCounted'),
        width: '110px',
        filter: true,
        filterOptions: ['是', '否'],
        form: true,
        type: 'select',
        options: ['是', '否'],
        hint: t('hintLevelCounted'),
      },
      {
        key: '是否关注',
        label: t('colLevelConcern'),
        width: '100px',
        form: true,
        type: 'select',
        options: ['是', '否'],
        hint: t('hintLevelConcern'),
      },
      {
        key: '所属体系',
        label: t('colScale'),
        width: '140px',
        list: false,
        form: true,
        type: 'link',
        linkOptions: scaleOptions,
        required: true,
      },
      { key: '说明', label: t('colDesc'), width: '140px', list: false, form: true, type: 'text' },
      {
        key: '更新时间',
        label: t('colUpdated'),
        width: '150px',
        render: (v) => <span className="muted">{formatDateTime(v)}</span>,
      },
    ],
    [t, scaleOptions],
  );

  return (
    <CrudPage
      title={t('titleGradeLevels')}
      subtitle={
        activeScale
          ? t('subtitleGradeLevelsOf', { name: activeScale.名称 || t('unnamed') })
          : t('subtitleGradeLevels')
      }
      columns={COLUMNS}
      moduleKey="gradeScales"
      inlineEdit
      standaloneForm
      sidebar={sidebar}
      // 只显示当前体系下的等级。`__contains` 走服务端 ILIKE：link 字段在 jsonb 里是
      // 数组/对象文本，等值匹配对不上，而 record id 是长随机串，子串误匹配可忽略。
      extraParams={{ 所属体系__contains: activeId || undefined }}
      // 新建等级自动归到当前体系；用户也可以在下拉里改
      createDefaults={{ 所属体系: activeId }}
      // 没有体系时不给新建等级：等级必须挂在某套体系下（否则绩点算不出来）
      hideCreate={!activeId}
      search={{ placeholder: t('searchLevels') }}
      api={{
        list: (p) => api.gradeScaleLevels.list(p),
        create: (d) => api.gradeScaleLevels.create(d),
        update: (id, d) => api.gradeScaleLevels.update(id, d),
        archive: (id) => api.gradeScaleLevels.archive(id),
      }}
    />
  );
}
