'use client';

import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 考核类型（教学管理 / 考试与成绩的配置表，2026-09-16 参照 RosarioSIS v13）。
 *
 * 为什么要有这张表：
 *   成绩册以前把「考核类型」做成**列上手填的文本**，于是同一个东西会出现
 *   「期末 / 期末考 / 期末考试」三种写法 —— 而类型权重是**按名称匹配**的，
 *   写法不一致 ⇒ 权重匹配不上 ⇒ 总评算错，且没有任何报错。
 *   升级成配置表后：类型是下拉选出来的（消灭写法差异），并且多带三样东西：
 *
 *  - **颜色**：成绩册列头用它出色块，一眼分出作业 / 小测 / 考试。
 *  - **缺省权重**：第二层权重的**全局缺省**，与列上的「列权重」相乘。
 *    （按教学班覆盖仍走 `markbookWeight`，那是高级用法，不动存量数据。）
 *  - **计入总评**：设为「否」的整类不进期末总评。老师就能放心把「随堂练习」
 *    也录进成绩册（留痕给家长看），而不用担心把总评拉低。
 *
 * ⚠️ 删不掉的情况：已有成绩册列在引用某个类型时，删除会被服务端拒绝并提示
 *    引用数量 —— 不要提供「强制删除」，那会让历史列失去类型。
 */
export default function ExamTypesPage() {
  const t = useTranslations('teaching');

  const YES_NO = ['是', '否'];
  const STATUS = ['启用', '停用'];

  const COLUMNS: CrudColumn[] = [
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
      type: 'text',
      hint: t('hintExamTypeColor'),
      render: (v) => {
        const c = String(v ?? '').trim();
        if (!c) return <span className="muted">—</span>;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <i style={{ width: 14, height: 14, borderRadius: 4, background: c, display: 'block', flex: '0 0 14px' }} />
            <span className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{c}</span>
          </span>
        );
      },
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
      filterOptions: YES_NO,
      form: true,
      type: 'select',
      options: YES_NO,
      hint: t('hintExamTypeCounted'),
    },
    { key: '排序', label: t('colSort'), width: '80px', form: true, type: 'number', hint: t('hintExamTypeSort') },
    { key: '状态', label: t('colStatus'), width: '90px', filter: true, filterOptions: STATUS },
    { key: '说明', label: t('colDesc'), form: true, type: 'textarea', hint: t('hintExamTypeDesc') },
    {
      key: '更新时间',
      label: t('colUpdated'),
      width: '150px',
      render: (v) => <span className="muted">{formatDateTime(v)}</span>,
    },
  ];

  return (
    <CrudPage
      title={t('titleExamTypes')}
      subtitle={t('subtitleExamTypes')}
      columns={COLUMNS}
      moduleKey="examTypes"
      statusField="状态"
      inlineEdit
      standaloneForm
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
