import type { CrudColumn } from '../../components/CrudPage';

const 评价周期_OPTS = ['期中', '期末', '年度'];
const 评价等级_OPTS = ['优秀', '良好', '合格', '需改进'];
const 评价完整度_OPTS = ['待提交', '已提交'];
const 学期_OPTS = ['第一学期', '第二学期', '暑期'];
const 评价类型_OPTS = ['学业综合', '行为发展', '身心健康', '实践能力', '升学评价', '其他'];
const 家长确认状态_OPTS = ['待确认', '已确认', '有异议', '不适用'];

export function buildStageColumns(t: (key: string) => string): CrudColumn[] {
  return [
    { key: '关联学生编号', label: t('colStudent'), width: '110px', form: true, type: 'studentLink', required: true, listOrder: 1 },
    { key: '评价周期', label: t('colEvalPeriod'), width: '100px', filter: true, filterOptions: 评价周期_OPTS, form: true, type: 'select', options: 评价周期_OPTS, listOrder: 3 },
    { key: '评价等级', label: t('colEvalLevel'), width: '100px', filter: true, filterOptions: 评价等级_OPTS, form: true, type: 'select', options: 评价等级_OPTS, listOrder: 4 },
    { key: '评价内容', label: t('colEvalContent'), form: true, type: 'textarea', list: false },
    { key: '评价完整度', label: t('colEvalCompleteness'), width: '110px', filter: true, filterOptions: 评价完整度_OPTS, form: true, type: 'select', options: 评价完整度_OPTS, listOrder: 6 },
    { key: '班主任', label: t('colHomeroomTeacher'), width: '100px', list: false },
    { key: '学期', label: t('colTerm'), width: '100px', filter: true, filterOptions: 学期_OPTS, form: true, type: 'select', options: 学期_OPTS, list: false },
    { key: '学年', label: t('colYear'), width: '80px', list: false },
    { key: '评价类型', label: t('colEvalType'), width: '120px', filter: true, filterOptions: 评价类型_OPTS, form: true, type: 'select', options: 评价类型_OPTS, list: false },
    { key: '评价日期', label: t('colEvalDate'), width: '120px', form: true, type: 'date', listOrder: 2 },
    { key: '评价人', label: t('colEvaluator'), width: '100px', listOrder: 5 },
    { key: '优势表现', label: t('colStrengths'), form: true, type: 'textarea', list: false },
    { key: '待改进项', label: t('colImprovements'), form: true, type: 'textarea', list: false },
    { key: '改进计划', label: t('colImprovementPlan'), form: true, type: 'textarea', list: false },
    { key: '复核日期', label: t('colReviewDate'), width: '120px', form: true, type: 'date', list: false },
    { key: '家长确认状态', label: t('colParentConfirm'), width: '110px', filter: true, filterOptions: 家长确认状态_OPTS, form: true, type: 'select', options: 家长确认状态_OPTS, list: false },
  ];
}
