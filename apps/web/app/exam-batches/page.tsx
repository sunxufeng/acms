'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 成绩批次（教学管理 / 考试与成绩的配置表，2026-09-20 补页面）。
 *
 * 为什么必须有这个页面：期末总评的结转是**按批次**跑的，而批次里装的是「哪些成绩册列参与结转」——
 * 起止日期决定列的入选范围，舍入 / 免考 / 缺考口径决定分母怎么算。
 * 此前只有接口没有页面：老师在「考试与成绩」里选批次时看到下拉是空的，
 * 页面提示「先去『成绩批次』建一个」，而那个页面在侧边栏里根本不存在 —— 死循环。
 *
 * 三个口径字段的含义（写死在服务端，这里只做录入）：
 *  - **舍入口径**：总评保留几位（默认保留 1 位小数）
 *  - **免考处理**：免考的格子算不算分母（默认「不计入分母」—— 免考不该拉低总评）
 *  - **缺考处理**：缺考的格子算不算分母（默认「计 0 分」—— 缺考必须有代价）
 *
 * ⚠️ 状态：`草稿 / 已发布` 目前**不参与运行时判定**（服务端不按状态拦结转），
 *    它只是给人看的进度标记，所以这里不做状态流转按钮，避免误导。
 */
export default function ExamBatchesPage() {
  const t = useTranslations('teaching');

  /** 结转口径的取值与服务端常量一一对应（见 exam-grade.logic.ts），不要改文案 —— 判据是字面量 */
  const TERMS = ['第一学期', '第二学期', '全学年'];
  const STATUS = ['草稿', '已发布'];
  const ROUND_MODES = ['四舍五入', '保留1位小数', '向上取整', '向下取整', '不处理'];
  const EXCUSED_MODES = ['不计入分母', '计0分'];
  const ABSENT_MODES = ['计0分', '不计入分母'];

  /**
   * 「等级体系」是 link 字段（存 record id），候选项是运行期数据 ⇒ 页面自己拉一份给 linkOptions。
   * 留空是可以的：结转时若批次没指定体系，服务端会用等级体系表里「是否默认 = 是」的那套。
   */
  const [scaleOptions, setScaleOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .gradeScales
      .list({ pageSize: '200' })
      .then((res) => {
        if (!alive) return;
        setScaleOptions(
          (res?.items ?? []).map((s) => ({
            value: String((s as { id?: string }).id ?? ''),
            label: String(s['名称'] ?? '未命名体系'),
          })).filter((o) => o.value),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const COLUMNS: CrudColumn[] = useMemo(
    () => [
      {
        key: '批次名称',
        label: t('colBatchName'),
        width: '180px',
        form: true,
        type: 'text',
        required: true,
        hint: t('hintBatchName'),
      },
      { key: '学年', label: t('colSchoolYear'), width: '110px', form: true, type: 'text', hint: t('hintSchoolYear') },
      {
        key: '学期',
        label: t('colTerm'),
        width: '100px',
        filter: true,
        filterOptions: TERMS,
        form: true,
        type: 'select',
        options: TERMS,
      },
      { key: '起日期', label: t('colFrom'), width: '110px', form: true, type: 'date', hint: t('hintDateRange') },
      { key: '止日期', label: t('colTo'), width: '110px', form: true, type: 'date' },
      {
        key: '等级体系',
        label: t('colScale'),
        width: '140px',
        list: false,
        form: true,
        type: 'link',
        linkOptions: scaleOptions,
        hint: t('hintBatchScale'),
      },
      {
        key: '舍入口径',
        label: t('colRound'),
        width: '110px',
        list: false,
        form: true,
        type: 'select',
        options: ROUND_MODES,
        hint: t('hintRound'),
      },
      {
        key: '免考处理',
        label: t('colExcused'),
        width: '110px',
        list: false,
        form: true,
        type: 'select',
        options: EXCUSED_MODES,
        hint: t('hintExcused'),
      },
      {
        key: '缺考处理',
        label: t('colAbsent'),
        width: '110px',
        list: false,
        form: true,
        type: 'select',
        options: ABSENT_MODES,
        hint: t('hintAbsent'),
      },
      // ── 异常成绩审查的三个阈值：只提示、不改分（见「考试与成绩」页的审查面板） ──
      {
        key: '异常阈值高倍',
        label: t('colThresholdHigh'),
        width: '110px',
        list: false,
        form: true,
        type: 'number',
        section: t('secThreshold'),
        hint: t('hintThresholdHigh'),
      },
      {
        key: '异常阈值低倍',
        label: t('colThresholdLow'),
        width: '110px',
        list: false,
        form: true,
        type: 'number',
        hint: t('hintThresholdLow'),
      },
      {
        key: '异常突变分差',
        label: t('colThresholdDelta'),
        width: '120px',
        list: false,
        form: true,
        type: 'number',
        hint: t('hintThresholdDelta'),
      },
      {
        key: '状态',
        label: t('colStatus'),
        width: '90px',
        filter: true,
        filterOptions: STATUS,
        form: true,
        type: 'select',
        options: STATUS,
        defaultFirstOption: true,
      },
      { key: '备注', label: t('colDesc'), width: '160px', form: true, type: 'textarea', section: t('secRemark') },
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
      title={t('titleExamBatches')}
      subtitle={t('subtitleExamBatches')}
      columns={COLUMNS}
      moduleKey="examBatches"
      statusField="状态"
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchExamBatches') }}
      // 配完批次自然要去结转，给一个直达入口（省得回菜单再找）
      extraLinks={[{ label: t('linkToExamGrades'), href: '/exam-grades' }]}
      api={{
        list: (p) => api.examBatches.list(p),
        create: (d) => api.examBatches.create(d),
        update: (id, d) => api.examBatches.update(id, d),
        archive: (id) => api.examBatches.archive(id),
      }}
    />
  );
}
