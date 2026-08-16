'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 评价周期_OPTS = ['期中', '期末', '年度'];
const 评价等级_OPTS = ['优秀', '良好', '合格', '需改进'];
const 评价完整度_OPTS = ['待提交', '已提交'];
const 学期_OPTS = ['第一学期', '第二学期', '暑期'];
const 评价类型_OPTS = ['学业综合', '行为发展', '身心健康', '实践能力', '升学评价', '其他'];
const 家长确认状态_OPTS = ['待确认', '已确认', '有异议', '不适用'];

const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生编号', width: '120px', form: true, type: 'text' },
  { key: '评价周期', label: '评价周期', width: '100px', filter: true, filterOptions: 评价周期_OPTS, form: true, type: 'select', options: 评价周期_OPTS },
  { key: '评价等级', label: '评价等级', width: '100px', filter: true, filterOptions: 评价等级_OPTS, form: true, type: 'select', options: 评价等级_OPTS },
  { key: '评价内容', label: '评价内容', form: true, type: 'textarea' },
  { key: '评价完整度', label: '完整度', width: '100px', filter: true, filterOptions: 评价完整度_OPTS, form: true, type: 'select', options: 评价完整度_OPTS },
  { key: '班主任', label: '班主任', width: '100px', form: true, type: 'text' },
  { key: '学期', label: '学期', width: '100px', filter: true, filterOptions: 学期_OPTS, form: true, type: 'select', options: 学期_OPTS },
  { key: '学年', label: '学年', width: '100px', form: true, type: 'text' },
  { key: '评价类型', label: '评价类型', width: '120px', filter: true, filterOptions: 评价类型_OPTS, form: true, type: 'select', options: 评价类型_OPTS },
  { key: '评价日期', label: '评价日期', width: '120px', form: true, type: 'date' },
  { key: '评价人', label: '评价人', width: '100px', form: true, type: 'text' },
  { key: '优势表现', label: '优势表现', form: true, type: 'textarea' },
  { key: '待改进项', label: '待改进项', form: true, type: 'textarea' },
  { key: '改进计划', label: '改进计划', form: true, type: 'textarea' },
  { key: '复核日期', label: '复核日期', width: '120px', form: true, type: 'date' },
  { key: '家长确认状态', label: '家长确认', width: '110px', filter: true, filterOptions: 家长确认状态_OPTS, form: true, type: 'select', options: 家长确认状态_OPTS },
];

export default function StageEvaluationsPage() {
  return (
    <CrudPage
      title="阶段评价"
      subtitle="学生阶段综合评价与发展记录（M1 学生域）"
      columns={COLUMNS}
      statusField="评价完整度"
      api={{
        list: (p) => api.listStageEvaluations(p),
        create: (d) => api.createStageEvaluation(d),
        update: (id, d) => api.updateStageEvaluation(id, d),
        archive: (id) => api.archiveStageEvaluation(id),
      }}
    />
  );
}
