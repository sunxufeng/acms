import type { CrudColumn } from '../../components/CrudPage';

const 参与情况_OPTS = ['已参与', '未参与'];
const 活动表现_OPTS = ['优秀', '良好', '合格', '需改进'];
const 活动类型_OPTS = ['校内活动', '社会实践', '志愿服务', '研学', '竞赛', '社团', '其他'];
const 安全确认状态_OPTS = ['待确认', '已确认', '不适用'];

export function buildPracticeColumns(t: (key: string) => string): CrudColumn[] {
  return [
    { key: '关联学生编号', label: t('colStudent'), width: '110px', form: true, type: 'studentLink', required: true, listOrder: 1 },
    { key: '活动名称', label: t('colActivityName'), width: '140px', form: true, type: 'text', listOrder: 3 },
    { key: '活动内容', label: t('colActivityContent'), form: true, type: 'textarea', list: false },
    { key: '参与情况', label: t('colParticipation'), width: '100px', filter: true, filterOptions: 参与情况_OPTS, form: true, type: 'select', options: 参与情况_OPTS, listOrder: 4 },
    { key: '活动表现', label: t('colActivityPerformance'), width: '100px', filter: true, filterOptions: 活动表现_OPTS, form: true, type: 'select', options: 活动表现_OPTS, listOrder: 5 },
    { key: '活动开始日期', label: t('colActivityStartDate'), width: '120px', form: true, type: 'date', listOrder: 6 },
    { key: '活动类型', label: t('colActivityType'), width: '110px', filter: true, filterOptions: 活动类型_OPTS, form: true, type: 'select', options: 活动类型_OPTS, listOrder: 2 },
    { key: '活动结束日期', label: t('colActivityEndDate'), width: '120px', form: true, type: 'date', list: false },
    { key: '活动地点', label: t('colActivityLocation'), width: '120px', form: true, type: 'text', list: false },
    { key: '活动负责人', label: t('colActivityOwner'), width: '110px', list: false },
    { key: '学生角色', label: t('colStudentRole'), width: '100px', form: true, type: 'text', list: false },
    { key: '服务或参与时长', label: t('colDuration'), width: '110px', form: true, type: 'number', listOrder: 7 },
    { key: '安全确认状态', label: t('colSafetyConfirm'), width: '110px', filter: true, filterOptions: 安全确认状态_OPTS, form: true, type: 'select', options: 安全确认状态_OPTS, list: false },
    { key: '关联授权', label: t('colRelatedAuth'), width: '110px', list: false },
    { key: '成果与反思', label: t('colOutcome'), form: true, type: 'textarea', list: false },
  ];
}
