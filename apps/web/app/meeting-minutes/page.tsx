'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { buildMeetingColumns, deptName, parseMeetingFromSummary } from './columns';

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function MeetingMinutesPage() {
  const ts = useTranslations('students');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  /**
   * 「指定部门可见」新建时的默认选中值 = **我所属的部门**。
   *
   * 放在页面层查、再喂给列定义，这样通用组件不必知道「当前用户属于哪个部门」这件事
   * （别的模块也不需要这个语义）。
   */
  const [myDeptIds, setMyDeptIds] = useState<string[]>([]);
  useEffect(() => {
    api
      .myDepartments()
      .then((r) => setMyDeptIds(Array.isArray(r?.ids) ? r.ids : []))
      .catch(() => {});
  }, []);

  /**
   * 部门 id → 该部门**含下级**的成员姓名。用于「选了部门 → 参会人员默认选中部门下的人」。
   *
   * 数据来自三个现成接口，一次拼好（都在本地快照里，不打上游）：
   *   `/departments`（层级，用来展开子树）
   * + `/departments/member-index`（部门 → openId）
   * + `/users/directory`（openId → 姓名）
   *
   * ⚠️ 成员快照里虽然也有姓名，但 `member-index` 只给 openId（它是给「算人数」用的轻量索引），
   *    所以必须 join 一次目录才能拿到姓名 —— 而「参会人员」存的正是**姓名数组**。
   */
  const [deptMembers, setDeptMembers] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let alive = true;
    Promise.all([api.listDepartments(), api.departmentMemberIndex(), api.listUserDirectory()])
      .then(([depts, index, dir]) => {
        if (!alive) return;
        const nodes = (depts?.items ?? []).filter((d) => d.status !== 'invalid');
        const children = new Map<string, string[]>();
        for (const d of nodes) {
          const p = String(d.parent_department_id ?? '');
          if (!p) continue;
          const cur = children.get(p) ?? [];
          cur.push(String(d.open_department_id));
          children.set(p, cur);
        }
        const nameOfOpenId = new Map(dir.map((u) => [String(u.openId), String(u.name)]));
        /** 部门 → 直属成员姓名 */
        const direct = new Map<string, string[]>();
        for (const r of index ?? []) {
          const n = nameOfOpenId.get(String(r.openId));
          if (!n) continue;
          const cur = direct.get(String(r.departmentId)) ?? [];
          if (!cur.includes(n)) cur.push(n);
          direct.set(String(r.departmentId), cur);
        }
        /** 部门 → 自身 + 全部下级的成员姓名（带环保护：部门树理论上无环，但不赌） */
        const out: Record<string, string[]> = {};
        const collect = (id: string, seen: Set<string>): string[] => {
          if (out[id]) return out[id];
          if (seen.has(id)) return [];
          seen.add(id);
          const names = [...(direct.get(id) ?? [])];
          for (const c of children.get(id) ?? []) {
            for (const n of collect(c, seen)) if (!names.includes(n)) names.push(n);
          }
          out[id] = names;
          return names;
        };
        for (const d of nodes) collect(String(d.open_department_id), new Set());
        setDeptMembers(out);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 被手动从「参会人员」删掉的人：再改部门时不自动加回（跨渲染保留，故用 ref） */
  const manuallyRemoved = useRef<Set<string>>(new Set());

  /**
   * 列定义随联动数据变化重建（`deptMembers` 是运行期数据，写死在 columns.tsx 里必然过期）。
   * `manuallyRemoved` 是 ref，引用稳定，不会引起重建。
   */
  const columns = useMemo(
    () => buildMeetingColumns({ deptMembers, manuallyRemoved, myDeptIds }),
    [deptMembers, myDeptIds],
  );

  // 按部门聚合已选会议纪要，构建 AI 上下文
  const context = useMemo(() => {
    if (selected.length === 0) return '（未选择会议纪要记录）';
    const byDept = new Map<string, Record<string, unknown>[]>();
    for (const row of selected) {
      const name = deptName(row) || '未指定部门';
      if (!byDept.has(name)) byDept.set(name, []);
      byDept.get(name)!.push(row);
    }
    const lines: string[] = [];
    lines.push(
      '你是 ACMS 会议纪要智能分析助手。用户从会议纪要列表勾选了若干条记录，请基于以下聚合信息回答关于会议议题、决议、待办跟进、风险与下一步建议等问题。若信息不足请明确说明。',
    );
    lines.push('');
    lines.push(`【已选会议纪要记录】（共 ${selected.length} 条，涉及 ${byDept.size} 个部门）`);
    for (const [name, rows] of byDept) {
      lines.push(`◆ 部门：${name}（${rows.length} 条）`);
      for (const r of rows) {
        const parts = [
          `会议类型：${str(r['会议类型']) || '—'}`,
          `会议议题：${str(r['会议议题']) || '—'}`,
          `会议地点：${str(r['会议地点']) || '—'}`,
          `会议时间：${str(r['会议时间']) || '—'}`,
          `状态：${str(r['状态']) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const summary = str(r['会议总结']);
        const detail = str(r['会议明细']);
        const todo = str(r['待办事宜']);
        if (summary) lines.push(`    会议总结：${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`);
        else if (detail) lines.push(`    会议明细：${detail.slice(0, 200)}${detail.length > 200 ? '...' : ''}`);
        if (todo) lines.push(`    待办事宜：${todo.slice(0, 160)}${todo.length > 160 ? '...' : ''}`);
      }
    }
    return lines.join('\n');
  }, [selected]);

  const deptCount = useMemo(() => new Set(selected.map((r) => deptName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length
    ? ts('aiSubjectSelected', { count: selected.length, students: deptCount })
    : ts('aiSubjectNone');

  return (
    <>
      <CrudPage
        title="会议纪要"
        subtitle="部门会议记录与决议闭环（组织管理域）"
        search={{ placeholder: '搜索会议议题…' }}
        columns={columns}
        // 模块 key：让按钮级授权、导入按钮、以及「会议明细」的写权限保护都能生效
        moduleKey="meetingMinutes"
        // 从笔记转换进来时，按会议总结文案自动识别议题/地点/时间/人员等字段
        enrichPrefill={parseMeetingFromSummary}
        // ⚠️ 这里**不再**预填「可见部门」：可见部门由「部门」字段派生
        // （列定义的 onChangePatch + 后端 meetingDefaults 兜底）。若在此写死「我所属部门」，
        // 用户不选部门直接保存就会得到一条「可见部门 = 我的部门」的记录，范围是错的。
        statusField="状态"
        // 会议时间范围筛选（后端 rangeField='会议时间'，走 listDeep 内存过滤）
        rangeFilters={[{ key: 'meetingTime', label: '会议时间', fromParam: 'from', toParam: 'to' }]}
        inlineEdit
        standaloneForm
        detailHref={(id) => `/meeting-minutes/${id}`}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listMeetingMinutes(p),
          create: (d) => api.createMeetingMinute(d),
          update: (id, d) => api.updateMeetingMinute(id, d),
          archive: (id) => api.archiveMeetingMinute(id),
        }}
      />

      {/* 右侧悬浮「AI」：按勾选的一条或多条会议纪要做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条会议纪要记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="meeting-minutes-ai-dialog"
        placeholder="输入与会议纪要相关的问题，Enter 发送…"
      />
    </>
  );
}
