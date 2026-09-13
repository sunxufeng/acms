'use client';

import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 考勤码（教学管理 / 组织考勤口径，2026-09-13 参照 GibbonEdu/core 的 attendance code 移植）。
 *
 * 为什么要有这张表：原先「出勤 / 迟到 / 早退 / 事假 / 病假 / 缺勤 / 校内活动」是**写死在前端**的，
 * 想加一种口径（如「公假」）就得改代码。现在升级成可配置码表，并带两个口径开关：
 *
 *  - **方向**（在校 / 不在校）：出勤率统计的**主判定轴**，决定这个码算不算「在校」。
 *  - **语义范围**（在校 / 在校-迟到 / 离校 / 离校-提前）：决定显示与细口径归类。
 *  - **可预填**：能否被上学期末的考勤状态自动带入下一节课。
 *  - **计入统计**：关闭后该码不进出勤率分母/分子（如「校内活动」）。
 *
 * ⚠️ 铁律：码表的**简写是稳定标识**（历史考勤记录按它引用），一旦被引用过就不要再改简写；
 *    要改显示叫法只改「名称」。这也是列表把简写放在第一列的原因。
 */
export default function AttendanceCodesPage() {
  const t = useTranslations('teaching');

  const DIR_OPTS = ['在校', '不在校'];
  const SCOPE_OPTS = ['在校', '在校-迟到', '离校', '离校-提前'];
  const YES_NO = ['是', '否'];

  const COLUMNS: CrudColumn[] = [
    { key: '简写', label: t('colCode'), width: '90px', form: true, type: 'text', required: true, hint: t('hintCode') },
    { key: '名称', label: t('colName'), width: '130px', form: true, type: 'text', required: true },
    {
      key: '方向',
      label: t('colDirection'),
      width: '100px',
      filter: true,
      filterOptions: DIR_OPTS,
      form: true,
      type: 'select',
      options: DIR_OPTS,
      hint: t('hintDirection'),
    },
    {
      key: '语义范围',
      label: t('colScope'),
      width: '120px',
      filter: true,
      filterOptions: SCOPE_OPTS,
      form: true,
      type: 'select',
      options: SCOPE_OPTS,
      hint: t('hintScope'),
    },
    {
      key: '可预填',
      label: t('colPrefill'),
      width: '90px',
      form: true,
      type: 'select',
      options: YES_NO,
      hint: t('hintPrefill'),
    },
    {
      key: '计入统计',
      label: t('colCounted'),
      width: '90px',
      form: true,
      type: 'select',
      options: YES_NO,
      hint: t('hintCounted'),
    },
    { key: '排序', label: t('colSort'), width: '70px', form: true, type: 'number', hint: t('hintSort') },
    { key: '状态', label: t('colStatus'), width: '90px', filter: true, filterOptions: ['启用', '停用'] },
    {
      key: '更新时间',
      label: t('colUpdated'),
      width: '150px',
      render: (v) => <span className="muted">{formatDateTime(v)}</span>,
    },
  ];

  return (
    <CrudPage
      title={t('titleAttendanceCodes')}
      subtitle={t('subtitleAttendanceCodes')}
      columns={COLUMNS}
      moduleKey="attendanceCodes"
      statusField="状态"
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchAttendanceCodes') }}
      api={{
        list: (p) => api.attendanceCodes.list(p),
        create: (d) => api.attendanceCodes.create(d),
        update: (id, d) => api.attendanceCodes.update(id, d),
        archive: (id) => api.attendanceCodes.archive(id),
      }}
    />
  );
}
