import type { CrudColumn } from '../../components/CrudPage';

const 学科_OPTS = ['语文', '数学', '英语', '科学', '历史'];
const 课堂表现_OPTS = ['优秀', '良好', '合格', '需改进'];
const 学期_OPTS = ['第一学期', '第二学期', '暑期'];
const 考核类型_OPTS = ['平时作业', '测验', '期中', '期末', '项目', '综合评价'];
const 成绩等级_OPTS = ['A', 'B', 'C', 'D', '不合格'];
const 成绩状态_OPTS = ['草稿', '已发布', '已更正', '已归档'];

export function buildGradeColumns(t: (key: string) => string): CrudColumn[] {
  return [
    { key: '关联学生编号', label: t('colStudent'), width: '110px', form: true, type: 'studentLink', required: true, listOrder: 1 },
    { key: '学科', label: t('colSubject'), width: '90px', filter: true, filterOptions: 学科_OPTS, form: true, type: 'select', options: 学科_OPTS, listOrder: 3 },
    { key: '成绩', label: t('colScore'), width: '90px', form: true, type: 'number', list: false },
    { key: '课堂表现', label: t('colPerformance'), width: '100px', filter: true, filterOptions: 课堂表现_OPTS, form: true, type: 'select', options: 课堂表现_OPTS, list: false },
    { key: '学期', label: t('colTerm'), width: '100px', filter: true, filterOptions: 学期_OPTS, form: true, type: 'select', options: 学期_OPTS, listOrder: 4 },
    { key: '学年', label: t('colYear'), width: '80px', list: false },
    { key: '课程', label: t('colCourse'), width: '120px', list: false },
    { key: '考核类型', label: t('colAssessmentType'), width: '110px', filter: true, filterOptions: 考核类型_OPTS, form: true, type: 'select', options: 考核类型_OPTS, list: false },
    { key: '考核名称', label: t('colAssessmentName'), form: true, type: 'text', list: false },
    { key: '考核日期', label: t('colAssessmentDate'), width: '120px', form: true, type: 'date', listOrder: 2 },
    { key: '满分', label: t('colFullScore'), width: '90px', form: true, type: 'number', list: false },
    { key: '成绩等级', label: t('colGradeLevel'), width: '100px', filter: true, filterOptions: 成绩等级_OPTS, form: true, type: 'select', options: 成绩等级_OPTS, list: false },
    { key: '教师评语', label: t('colTeacherComment'), form: true, type: 'textarea', list: false },
    { key: '任课教师', label: t('colCourseTeacher'), width: '100px', listOrder: 5 },
    { key: '成绩状态', label: t('colGradeStatus'), width: '100px', filter: true, filterOptions: 成绩状态_OPTS, form: true, type: 'select', options: 成绩状态_OPTS, listOrder: 6 },
  ];
}
