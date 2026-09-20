'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/permissions';
import { formatDateTime } from '../../lib/date';

/**
 * 考核类型组 + 考核类型（教学管理，2026-09-20 改为两级）。
 *
 * 结构照「成绩等级体系 → 成绩等级」那一套：
 *   考核类型组（`examTypeGroup`）─┬─ 考核类型（`examType`）
 *                                 └─ 被成绩册列引用（颜色 / 缺省权重 / 是否计入总评）
 *
 * 为什么多一层「组」：同一批类型要能**整组开关**（换学期时一个开关搞定），
 * 逐个停用 7 个类型必然漏关，漏一个就会在成绩册的下拉里留下过期选项。
 * 页面左侧维护组、右侧是该组下的类型（与「成绩等级」页同一形态，不另造一套布局）。
 *
 * 🔴 停用的组 ⇒ 该组下所有类型**在别处不可用**：成绩册「新建考核列」与「成绩类型权重」的
 *    下拉都不再出现（服务端 `MarkbookService.listTypeOptions` 按组状态过滤）。
 *    但**存量成绩册列照常计算** —— 停用是「不许再选」，不是「历史作废」。
 *
 * ⚠️ 不让删还有类型的组：删了那些类型就变成「无组」，而右侧按组筛选 ⇒
 *    页面上会一条都看不到（像是被删了，实际还在被成绩册引用）。
 */
interface Group {
  id: string;
  组名称: string;
  状态?: string;
  排序?: number | string;
  说明?: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export default function ExamTypesPage() {
  const t = useTranslations('teaching');
  const perms = usePermissions();
  const canCreate = perms.includes('module:examTypes:create');
  const canUpdate = perms.includes('module:examTypes:update');
  const canDelete = perms.includes('module:examTypes:delete');

  const [groups, setGroups] = useState<Group[]>([]);
  const [activeId, setActiveId] = useState('');
  /** 正在新建/编辑的组（null = 没在编辑；无 id = 新建） */
  const [draft, setDraft] = useState<Partial<Group> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  /**
   * 拉组列表。
   *
   * ⚠️ `loadGroups` 用 `useCallback([])` 固定身份：它被 effect 依赖，
   * 每次 render 新建函数会让 effect 反复跑（渲染死循环那个老坑）。
   */
  const loadGroups = useCallback(async (): Promise<Group[]> => {
    try {
      const res = await api.examTypeGroups.list({ pageSize: '200' });
      const items: Group[] = (res?.items ?? [])
        .map((g) => ({
          id: String((g as { id?: string }).id ?? ''),
          组名称: String(g['组名称'] ?? ''),
          状态: String(g['状态'] ?? ''),
          排序: g['排序'] as number | string | undefined,
          说明: String(g['说明'] ?? ''),
        }))
        .filter((g) => g.id);
      items.sort((a, b) => num(a.排序) - num(b.排序) || a.组名称.localeCompare(b.组名称, 'zh-CN'));
      setGroups(items);
      return items;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void loadGroups().then((items) => {
      // 默认选中第一个**启用**的组；全是停用的就选第一个（否则右侧空空如也，像是没数据）
      const prefer = items.find((g) => g.状态 !== '停用') ?? items[0];
      if (prefer) setActiveId(prefer.id);
    });
  }, [loadGroups]);

  const groupOptions = useMemo(
    () => groups.map((g) => ({ value: g.id, label: g.组名称 || t('unnamedGroup') })),
    [groups, t],
  );
  const activeGroup = groups.find((g) => g.id === activeId);

  const saveDraft = async () => {
    if (!draft) return;
    const name = String(draft.组名称 ?? '').trim();
    if (!name) {
      setErr(t('errGroupName'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const body: Record<string, unknown> = {
        组名称: name,
        状态: draft.状态 || '启用',
        排序: draft.排序 === '' || draft.排序 == null ? 0 : num(draft.排序),
        说明: draft.说明 ?? '',
      };
      if (draft.id) {
        await api.examTypeGroups.update(draft.id, body);
      } else {
        const created = await api.examTypeGroups.create(body);
        const id = String((created as { id?: string })?.id ?? '');
        if (id) setActiveId(id);
      }
      setDraft(null);
      await loadGroups();
    } catch (e) {
      setErr(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const removeGroup = async (g: Group) => {
    if (!window.confirm(t('confirmDeleteGroup'))) return;
    setBusy(true);
    setErr('');
    try {
      // 🔴 组下还有类型时不让删：删了它们就变成「无组」，而右侧按组筛 ⇒ 看着像被删了，
      // 实际还在被成绩册引用（比报错更糟：老师以为类型没了，历史列的权重就对不上账了）
      const used = await api.examTypes.list({ pageSize: '200', 所属考核类型组__contains: g.id });
      const n = (used?.items ?? []).length;
      if (n > 0) {
        setErr(t('errGroupHasTypes', { count: n }));
        return;
      }
      await api.examTypeGroups.archive(g.id);
      const items = await loadGroups();
      if (activeId === g.id) setActiveId(items[0]?.id ?? '');
    } catch (e) {
      setErr(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const sidebar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{t('groupSidebarTitle')}</span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!canCreate || busy}
          title={canCreate ? undefined : t('noEditPerm')}
          onClick={() => {
            setErr('');
            setDraft({ 组名称: '', 状态: '启用', 排序: groups.length + 1, 说明: '' });
          }}
        >
          {t('newGroup')}
        </button>
      </div>

      {err ? <div style={{ fontSize: 'var(--font-xs)', color: 'var(--danger, #d33)' }}>{err}</div> : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.map((g) => {
          const on = g.id === activeId;
          const stopped = g.状态 === '停用';
          return (
            <div
              key={g.id}
              onClick={() => {
                setActiveId(g.id);
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
                <span style={{ fontWeight: on ? 600 : 500, opacity: stopped ? 0.55 : 1 }}>
                  {g.组名称 || t('unnamedGroup')}
                </span>
                {stopped ? (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {t('colStatusStop')}
                  </span>
                ) : null}
              </span>
              <span style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={!canUpdate || busy}
                  onClick={() => {
                    setErr('');
                    setDraft({ ...g });
                  }}
                >
                  {t('edit')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={!canDelete || busy}
                  onClick={() => void removeGroup(g)}
                >
                  {t('delete')}
                </button>
              </span>
            </div>
          );
        })}
        {groups.length === 0 && !draft ? (
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{t('noGroupYet')}</div>
        ) : null}
      </div>

      {draft ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>
            {draft.id ? t('editGroup') : t('newGroup')}
          </div>
          <input
            className="form-input"
            placeholder={t('colGroupName')}
            value={String(draft.组名称 ?? '')}
            onChange={(e) => setDraft((d) => ({ ...(d ?? {}), 组名称: e.target.value }))}
          />
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
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setErr('');
              }}
            >
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
        key: '类型名称',
        label: t('colExamTypeName'),
        width: '150px',
        form: true,
        type: 'text',
        required: true,
        hint: t('hintExamTypeName'),
      },
      { key: '英文名', label: t('colExamTypeEn'), width: '140px', form: true, type: 'text' },
      {
        key: '颜色',
        label: t('colExamTypeColor'),
        width: '130px',
        form: true,
        /**
         * 色值字段用 `color` 类型 = **色板点选 + 手输 + 系统取色器**（组件见 components/ColorPicker.tsx）。
         * 原先是纯文本框：要自己记住并打出 `#4ECDC4`，打错**不报错**，
         * 只是成绩册列头不出色块 —— 看起来像功能坏了，其实是色值不合法。
         */
        type: 'color',
        hint: t('hintExamTypeColor'),
      },
      {
        key: '缺省权重',
        label: t('colExamTypeWeight'),
        width: '100px',
        form: true,
        type: 'number',
        hint: t('hintExamTypeWeight'),
      },
      {
        key: '计入总评',
        label: t('colExamTypeCounted'),
        width: '100px',
        filter: true,
        filterOptions: ['是', '否'],
        form: true,
        type: 'select',
        options: ['是', '否'],
        hint: t('hintExamTypeCounted'),
      },
      { key: '排序', label: t('colSort'), width: '80px', form: true, type: 'number', hint: t('hintExamTypeSort') },
      { key: '状态', label: t('colStatus'), width: '90px', filter: true, filterOptions: ['启用', '停用'] },
      {
        key: '所属考核类型组',
        label: t('colExamTypeGroup'),
        width: '150px',
        list: false,
        form: true,
        type: 'link',
        linkOptions: groupOptions,
        required: true,
        hint: t('hintExamTypeGroup'),
      },
      { key: '说明', label: t('colDesc'), form: true, type: 'textarea', hint: t('hintExamTypeDesc') },
      {
        key: '更新时间',
        label: t('colUpdated'),
        width: '150px',
        render: (v) => <span className="muted">{formatDateTime(v)}</span>,
      },
    ],
    [t, groupOptions],
  );

  return (
    <CrudPage
      title={t('titleExamTypes')}
      subtitle={
        activeGroup
          ? activeGroup.状态 === '停用'
            ? t('subtitleExamTypesStopped', { name: activeGroup.组名称 || t('unnamedGroup') })
            : t('subtitleExamTypesOf', { name: activeGroup.组名称 || t('unnamedGroup') })
          : t('subtitleExamTypes')
      }
      columns={COLUMNS}
      moduleKey="examTypes"
      statusField="状态"
      inlineEdit
      standaloneForm
      sidebar={sidebar}
      // 只显示当前组下的类型。`__contains` 走服务端 ILIKE：link 字段在 jsonb 里是
      // 数组/对象文本，等值匹配对不上，而 record id 是长随机串，子串误匹配可忽略。
      extraParams={{ 所属考核类型组__contains: activeId || undefined }}
      // 新建类型自动归到当前组；用户也可以在下拉里改
      createDefaults={{ 所属考核类型组: activeId }}
      // 没有组时不给新建类型：类型必须挂在某个组下（否则换学期时无处整组停用）
      hideCreate={!activeId}
      search={{ placeholder: t('searchExamTypes') }}
      api={{
        list: (p) => api.examTypes.list(p),
        create: (d) => api.examTypes.create(d),
        update: (id, d) => api.examTypes.update(id, d),
        archive: (id) => api.examTypes.archive(id),
      }}
    />
  );
}
