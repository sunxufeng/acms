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

  const TAGS = ['通用', '鼓励', '进步', '提醒', '待改进'];
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
      type: 'text',
      filter: true,
      // 文本筛选默认是**等值**匹配，要模糊必须显式声明（否则输入部分文字恒 0 条）
      filterType: 'text',
      filterOp: 'contains',
      hint: t('hintCommentSubject'),
    },
    {
      key: '标签',
      label: t('colCommentTag'),
      width: '100px',
      form: true,
      type: 'select',
      options: TAGS,
      filter: true,
      filterOptions: TAGS,
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
