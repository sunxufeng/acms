'use client';

import { useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { fmtDateTime, statusClassOf } from '../../components/curriculum/fields';

/**
 * 学习成果（Outcomes）—— 成果库。
 *
 * 对齐 Gibbon 的 Outcomes：一个成果要么是**全校**范围（按年级适用），
 * 要么属于某个**学习领域**（ACMS 里落成「部门 / 学科组」）。
 * 单元与课时通过关联表挂到成果上（见「课程规划」页的「单元挂成果」与「课时教案」页），
 * 这里只维护成果本体。
 *
 * 排序、状态与筛选都由后端 RecordMeta 驱动（learning-outcomes/outcomes）。
 */

const SCOPES = ['全校', '学习领域'];
const STATUSES = ['启用', '停用'];
const GRADES = [
  '幼儿园', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级',
  '初一', '初二', '初三', '高一', '高二', '高三', '全部年级',
];

/** 成果的启停是二元状态，不做删除（历史教案可能还挂着它） */
const TRANSITIONS: Record<string, string[]> = {
  启用: ['停用'],
  停用: ['启用'],
};

/**
 * ⚠️ 用 useMemo 稳定引用：CrudPage 内部把 columns 放进 effect 依赖，
 * 每次渲染都新建数组会让「关联字段候选项」的 effect 反复触发。
 */
function buildColumns(deptOptions: { value: string; label: string }[]): CrudColumn[] {
  return [
    { key: '成果名称', label: '成果名称', width: '200px', form: true, required: true, type: 'text' },
    { key: '成果简称', label: '成果简称', width: '110px', form: true, type: 'text' },
    {
      key: '适用范围', label: '适用范围', width: '110px',
      form: true, type: 'select', options: SCOPES,
      filter: true, filterOptions: SCOPES,
      hint: '「全校」按年级适用；「学习领域」按部门（学科组）适用',
    },
    {
      key: '适用年级', label: '适用年级', width: '110px',
      form: true, type: 'select', options: GRADES,
      filter: true, filterOptions: GRADES,
    },
    {
      key: '所属部门', label: '所属部门', width: '150px',
      form: true, type: 'link', linkOptions: deptOptions,
      // 关联字段存 record id，等值筛选筛不到 → 用 __has 走内存匹配（后端支持）
      filter: true, filterParam: '所属部门__has', filterOptions: deptOptions.map((o) => o.label),
      hint: '适用范围选「学习领域」时必填',
    },
    { key: '成果状态', label: '成果状态', width: '90px', filter: true, filterOptions: STATUSES },
    { key: '排序', label: '排序', width: '70px', form: true, type: 'number', hint: '同一范围内按此升序展示' },
    {
      key: '成果描述', label: '成果描述', width: '320px',
      form: true, type: 'textarea', list: false, fieldHeight: 120,
      hint: '写清「学生能做到什么」，便于单元改写时对齐口径',
    },
    {
      key: '更新时间', label: '更新时间', width: '150px',
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
    },
  ];
}

export default function LearningOutcomesPage() {
  const [depts, setDepts] = useState<{ value: string; label: string }[]>([]);

  // 部门候选项来自「组织管理 / 部门管理」已同步的飞书部门树（已删除部门不出现在树里）
  useEffect(() => {
    let alive = true;
    api
      .listDepartments()
      .then((res) => {
        if (!alive) return;
        setDepts(
          (res?.items ?? [])
            .filter((d) => d.status !== 'invalid')
            .map((d) => ({ value: d.open_department_id, label: d.name || d.open_department_id })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo(() => buildColumns(depts), [depts]);

  return (
    <CrudPage
      title="学习成果"
      subtitle="成果库：全校范围按年级、学习领域按部门（学科组）维护；单元与课时从这里挂成果"
      moduleKey="learningOutcomes"
      columns={columns}
      statusField="成果状态"
      transitions={TRANSITIONS}
      statusClass={statusClassOf}
      inlineEdit
      standaloneForm
      search={{ placeholder: '搜索成果名称 / 简称 / 描述' }}
      api={{
        list: (p) => api.learningOutcomes.list(p),
        create: (d) => api.learningOutcomes.create(d),
        update: (id, d) => api.learningOutcomes.update(id, d),
        archive: (id) => api.learningOutcomes.archive(id),
        transition: (id, to) => api.learningOutcomes.transition(id, to),
      }}
    />
  );
}
