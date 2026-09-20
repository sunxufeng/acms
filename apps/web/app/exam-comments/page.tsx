'use client';

import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 常用评语库（教学管理，2026-09-16 Phase 2）。
 *
 * 为什么需要：一次期末，一个班主任要写 33 个学生的总评语、一个任课老师要写
 * 33 条单科评语。里面大量是**重复的句式**（「基础扎实，审题还需更仔细」）。
 * 没有这个库，老师就在别处存一份 Word 反复复制；有了它，批量评语页可以一键套用。
 *
 * 使用方式（见 `exam-grades` 的批量评语页）：按**当前科目**过滤 ——
 * 「科目」留空的是通用句（任何科目都能套），填了就只在该科目出现。
 *
 * 这里是标准的 CrudPage，与「考核类型」同一形态，不再自造列表。
 */
export default function ExamCommentsPage() {
  const t = useTranslations('teaching');

  /** 状态是流程值，不放字典；「标签」已改为读字典「评语标签」（运营可自行增删） */
  const STATUS = ['启用', '停用'];

  const COLUMNS: CrudColumn[] = [
    {
      key: '评语内容',
      label: t('colCommentText'),
      form: true,
      type: 'textarea',
      required: true,
      hint: t('hintCommentText'),
    },
    {
      key: '科目',
      label: t('colCommentSubject'),
      width: '120px',
      form: true,
      // 🔴 读字典「授课科目」、与成绩册列的「科目」同源（2026-09-20 改）。
      // 这里的科目是**与期末总评的科目等值匹配**的键（批量评语按当前科目筛句子）：
      // 一边写「数学课」、一边是「数学」，那条评语就永远筛不出来，且不报错。
      type: 'select',
      dictKey: '授课科目',
      filter: true,
      // 从自由文本改成下拉后，原来配的 contains 模糊筛选要撤掉 ——
      // 留着会让筛选框仍是文本框（写一半筛不到），删掉才会按 dictKey 渲染成下拉
      hint: t('hintCommentSubject'),
    },
    {
      key: '标签',
      label: t('colCommentTag'),
      width: '100px',
      form: true,
      // 读字典「评语标签」（通用 / 鼓励 / 进步 / 提醒 / 待改进），改档位去「字典管理」页
      type: 'select',
      dictKey: '评语标签',
      filter: true,
    },
    { key: '排序', label: t('colSort'), width: '80px', form: true, type: 'number', hint: t('hintCommentSort') },
    { key: '状态', label: t('colStatus'), width: '90px', filter: true, filterOptions: STATUS },
    {
      key: '使用次数',
      label: t('colCommentUsed'),
      width: '90px',
      render: (v) => <span className="muted">{String(v ?? 0) || '—'}</span>,
    },
    {
      key: '更新时间',
      label: t('colUpdated'),
      width: '150px',
      render: (v) => <span className="muted">{formatDateTime(v)}</span>,
    },
  ];

  return (
    <CrudPage
      title={t('titleExamComments')}
      subtitle={t('subtitleExamComments')}
      columns={COLUMNS}
      moduleKey="examComments"
      statusField="状态"
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchExamComments') }}
      api={{
        list: (p) => api.examComments.list(p),
        create: (d) => api.examComments.create(d),
        update: (id, d) => api.examComments.update(id, d),
        archive: (id) => api.examComments.archive(id),
      }}
    />
  );
}
