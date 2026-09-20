'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 学生成绩目标（教学管理，2026-09-20 补页面）。
 *
 * 存在的意义：成绩册里「是否达标」这一列**必须有个人目标才算得出来** ——
 * 判定是 `条目等级序号 ≤ 目标等级序号`。没有目标记录时，成绩册在该列写「未设目标」，
 * 而不是「不达标」（两者语义差得远，别混）。
 *
 * 🔴 两个容易搞反的点，直接写在字段提示里：
 *  1. **等级序号越小越好**（1 为最好）—— 所以「达标」是序号 **≤** 目标序号，
 *     与直觉的「分数 ≥ 及格线」方向相反。
 *  2. 「班级」要与成绩册的班级一致（= 学生档案的「当前年级」），
 *     因为成绩册是按班级分组取名单的。
 *
 * 学生字段存的是学生档案的 record id（与成绩册条目的「学生」同口径），
 * 因此本页**沿用同一套学生档案数据范围**：老师看不到授权范围之外的学生目标。
 */
export default function MarkbookTargetsPage() {
  const t = useTranslations('teaching');

  const COLUMNS: CrudColumn[] = useMemo(
    () => [
      {
        key: '学生',
        label: t('colTargetStudent'),
        width: '150px',
        form: true,
        // studentLink：候选来自学生档案，存的 value 是 record id（列表由后端解析成姓名）
        type: 'studentLink',
        required: true,
      },
      {
        key: '班级',
        label: t('colTargetClass'),
        width: '130px',
        filter: true,
        form: true,
        // 读字典「当前年级」：成绩册是按「学生档案.当前年级」分组的，用同一份名单才不会写错班名
        type: 'select',
        dictKey: '当前年级',
        hint: t('hintTargetClass'),
      },
      {
        key: '目标等级序号',
        label: t('colTargetOrder'),
        width: '120px',
        form: true,
        type: 'number',
        required: true,
        hint: t('hintTargetOrder'),
      },
      {
        key: '目标分',
        label: t('colTargetScore'),
        width: '100px',
        form: true,
        type: 'number',
        hint: t('hintTargetScore'),
      },
      { key: '备注', label: t('colDesc'), width: '160px', form: true, type: 'text' },
      {
        key: '更新时间',
        label: t('colUpdated'),
        width: '150px',
        render: (v) => <span className="muted">{formatDateTime(v)}</span>,
      },
    ],
    [t],
  );

  return (
    <CrudPage
      title={t('titleTargets')}
      subtitle={t('subtitleTargets')}
      columns={COLUMNS}
      moduleKey="markbookTargets"
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchTargets') }}
      extraLinks={[{ label: t('linkToMarkbook'), href: '/markbook' }]}
      api={{
        list: (p) => api.markbookTargets.list(p),
        create: (d) => api.markbookTargets.create(d),
        update: (id, d) => api.markbookTargets.update(id, d),
        archive: (id) => api.markbookTargets.archive(id),
      }}
    />
  );
}
