'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

// 招生跟进的下拉选项统一从字典表读取（dictKey），不再在前端写死。
const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生', width: '110px' },
  { key: '活动类型', label: '活动类型', width: '100px', filter: true, form: true, type: 'select', dictKey: '活动类型' },
  { key: '跟进状态', label: '跟进状态', width: '100px', filter: true, form: true, type: 'select', dictKey: '跟进状态' },
  { key: '跟进负责人', label: '跟进负责人', width: '110px' },
  { key: '跟进日期', label: '跟进日期', width: '120px', form: true, type: 'date' },
  { key: '跟进内容', label: '跟进内容', form: true, type: 'textarea' },
  { key: '跟进方式', label: '跟进方式', width: '100px', filter: true, form: true, type: 'select', dictKey: '跟进方式' },
  { key: '意向等级', label: '意向等级', width: '100px', filter: true, form: true, type: 'select', dictKey: '意向等级' },
  { key: '下次跟进日期', label: '下次跟进', width: '120px', form: true, type: 'date' },
  { key: '下一步行动', label: '下一步', form: true, type: 'text' },
  { key: '闭环状态', label: '闭环', width: '100px', filter: true, form: true, type: 'select', dictKey: '闭环状态' },
  // ── 新增字段 ──────────────────────────────
  { key: '原学校', label: '原学校', width: '140px', form: true, type: 'text' },
  { key: '原学校类型', label: '原学校类型', width: '120px', filter: true, form: true, type: 'select', dictKey: '原学校类型' },
  { key: '合同状态', label: '合同状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '合同状态' },
  { key: '付款状态', label: '付款状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '付款状态' },
  { key: '奖学金金额', label: '奖学金金额', width: '120px', form: true, type: 'text' },
  { key: '家庭关键决策点', label: '家庭关键决策点', width: '140px', filter: true, form: true, type: 'select', dictKey: '家庭关键决策点' },
];

export default function SourceFollowupsPage() {
  return (
    <CrudPage
      title="生源跟进"
      subtitle="招生线索与跟进闭环（M1 学生域）"
      search={{ placeholder: '搜索学生姓名…' }}
      columns={COLUMNS}
      statusField="跟进状态"
      inlineEdit
      api={{
        list: (p) => api.listSourceFollowups(p),
        create: (d) => api.createSourceFollowup(d),
        update: (id, d) => api.updateSourceFollowup(id, d),
        archive: (id) => api.archiveSourceFollowup(id),
      }}
    />
  );
}
