'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 闭环状态_OPTS = ['待处理', '跟进中', '已闭环', '已终止'];
const 活动类型_OPTS = ['开放日', '体验课', '咨询会', '其他'];
const 跟进状态_OPTS = ['未跟进', '已跟进', '已录取'];
const 跟进方式_OPTS = ['电话', '微信', '邮件', '面谈', '活动', '其他'];
const 意向等级_OPTS = ['高', '中', '低', '待判断'];

const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生编号', width: '120px', form: true, type: 'text' },
  { key: '活动类型', label: '活动类型', width: '100px', filter: true, filterOptions: 活动类型_OPTS, form: true, type: 'select', options: 活动类型_OPTS },
  { key: '跟进状态', label: '跟进状态', width: '100px', filter: true, filterOptions: 跟进状态_OPTS, form: true, type: 'select', options: 跟进状态_OPTS },
  { key: '跟进负责人', label: '跟进负责人', width: '110px', form: true, type: 'text' },
  { key: '跟进日期', label: '跟进日期', width: '120px', form: true, type: 'date' },
  { key: '跟进内容', label: '跟进内容', form: true, type: 'textarea' },
  { key: '跟进方式', label: '跟进方式', width: '100px', filter: true, filterOptions: 跟进方式_OPTS, form: true, type: 'select', options: 跟进方式_OPTS },
  { key: '意向等级', label: '意向等级', width: '100px', filter: true, filterOptions: 意向等级_OPTS, form: true, type: 'select', options: 意向等级_OPTS },
  { key: '下次跟进日期', label: '下次跟进', width: '120px', form: true, type: 'date' },
  { key: '下一步行动', label: '下一步', form: true, type: 'text' },
  { key: '闭环状态', label: '闭环', width: '100px', filter: true, filterOptions: 闭环状态_OPTS, form: true, type: 'select', options: 闭环状态_OPTS },
];

export default function SourceFollowupsPage() {
  return (
    <CrudPage
      title="生源跟进"
      subtitle="招生线索与跟进闭环（M1 学生域）"
      columns={COLUMNS}
      statusField="闭环状态"
      api={{
        list: (p) => api.listSourceFollowups(p),
        create: (d) => api.createSourceFollowup(d),
        update: (id, d) => api.updateSourceFollowup(id, d),
        archive: (id) => api.archiveSourceFollowup(id),
      }}
    />
  );
}
