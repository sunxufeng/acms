'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

// 招生跟进的下拉选项统一从字典表读取（dictKey），不再在前端写死。
// 列表只显示：学生 / 活动类型 / 跟进状态 / 负责人 / 付款状态，其余字段仅在新建/编辑表单中使用。
const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生', width: '120px' },
  { key: '活动类型', label: '活动类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '活动类型' },
  { key: '跟进状态', label: '跟进状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '跟进状态' },
  { key: '跟进负责人', label: '负责人', width: '110px' },
  { key: '付款状态', label: '付款状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '付款状态' },
  // 其余字段不在列表展示，但保留在表单中
  { key: '跟进日期', label: '跟进日期', list: false, form: true, type: 'date' },
  { key: '跟进内容', label: '跟进内容', list: false, form: true, type: 'textarea' },
  { key: '跟进方式', label: '跟进方式', list: false, form: true, type: 'select', dictKey: '跟进方式' },
  { key: '意向等级', label: '意向等级', list: false, form: true, type: 'select', dictKey: '意向等级' },
  { key: '下次跟进日期', label: '下次跟进', list: false, form: true, type: 'date' },
  { key: '下一步行动', label: '下一步', list: false, form: true, type: 'text' },
  { key: '闭环状态', label: '闭环', list: false, form: true, type: 'select', dictKey: '闭环状态' },
  { key: '原学校', label: '原学校', list: false, form: true, type: 'text' },
  { key: '原学校类型', label: '原学校类型', list: false, form: true, type: 'select', dictKey: '原学校类型' },
  { key: '合同状态', label: '合同状态', list: false, form: true, type: 'select', dictKey: '合同状态' },
  { key: '奖学金金额', label: '奖学金金额', list: false, form: true, type: 'text' },
  { key: '家庭关键决策点', label: '家庭关键决策点', list: false, form: true, type: 'select', dictKey: '家庭关键决策点' },
];

export default function SourceFollowupsPage() {
  return (
    <CrudPage
      title="招生跟进"
      subtitle="招生线索与跟进闭环（M1 学生域）"
      search={{ placeholder: '搜索学生姓名…' }}
      columns={COLUMNS}
      statusField="跟进状态"
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listSourceFollowups(p),
        create: (d) => api.createSourceFollowup(d),
        update: (id, d) => api.updateSourceFollowup(id, d),
        archive: (id) => api.archiveSourceFollowup(id),
      }}
    />
  );
}
