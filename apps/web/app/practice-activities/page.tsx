'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 参与情况_OPTS = ['已参与', '未参与'];
const 活动表现_OPTS = ['优秀', '良好', '合格', '需改进'];
const 活动类型_OPTS = ['校内活动', '社会实践', '志愿服务', '研学', '竞赛', '社团', '其他'];
const 安全确认状态_OPTS = ['待确认', '已确认', '不适用'];

const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生编号', width: '120px' },
  { key: '活动名称', label: '活动名称', width: '140px', form: true, type: 'text' },
  { key: '活动内容', label: '活动内容', form: true, type: 'textarea' },
  { key: '参与情况', label: '参与情况', width: '100px', filter: true, filterOptions: 参与情况_OPTS, form: true, type: 'select', options: 参与情况_OPTS },
  { key: '活动表现', label: '活动表现', width: '100px', filter: true, filterOptions: 活动表现_OPTS, form: true, type: 'select', options: 活动表现_OPTS },
  { key: '活动开始日期', label: '开始日期', width: '120px', form: true, type: 'date' },
  { key: '活动类型', label: '活动类型', width: '110px', filter: true, filterOptions: 活动类型_OPTS, form: true, type: 'select', options: 活动类型_OPTS },
  { key: '活动结束日期', label: '结束日期', width: '120px', form: true, type: 'date' },
  { key: '活动地点', label: '活动地点', width: '120px', form: true, type: 'text' },
  { key: '活动负责人', label: '活动负责人', width: '110px' },
  { key: '学生角色', label: '学生角色', width: '100px', form: true, type: 'text' },
  { key: '服务或参与时长', label: '时长(小时)', width: '110px', form: true, type: 'number' },
  { key: '安全确认状态', label: '安全确认', width: '110px', filter: true, filterOptions: 安全确认状态_OPTS, form: true, type: 'select', options: 安全确认状态_OPTS },
  { key: '关联授权', label: '关联授权', width: '110px' },
  { key: '成果与反思', label: '成果与反思', form: true, type: 'textarea' },
];

export default function PracticeActivitiesPage() {
  return (
    <CrudPage
      title="实践活动"
      subtitle="研学/志愿/竞赛等实践活动记录（M1 学生域）"
      columns={COLUMNS}
      statusField="安全确认状态"
      api={{
        list: (p) => api.listPracticeActivities(p),
        create: (d) => api.createPracticeActivity(d),
        update: (id, d) => api.updatePracticeActivity(id, d),
        archive: (id) => api.archivePracticeActivity(id),
      }}
    />
  );
}
