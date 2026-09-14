import type { CrudColumn } from '../../components/CrudPage';
import { enrichFromNotes, type NoteAutoFillSpec } from '../../lib/noteAutoFill';
import { formatDateTime } from '../../lib/date';

const 考勤状态_OPTS = ['正常', '异常'];
const 时段_OPTS = ['上午', '下午', '晚间', '全天'];
const 学期_OPTS = ['第一学期', '第二学期', '暑期'];
const 考勤结果_OPTS = ['出勤', '迟到', '早退', '事假', '病假', '缺勤', '校内活动'];
const 通知状态_OPTS = ['无需通知', '待通知', '已通知', '已确认'];
/**
 * 终态审核状态。
 * ⚠️ 这几列**全部 readonly**（表单里只展示、不可改）：审核状态只能由「审核」动作写，
 * 服务端还会再拦一道（`attendance-review.service.ts`），避免列表侧绕过审核链路。
 * 新建时服务端默认写「待审核」；没有值的记录一律按待审核处理（不进 出勤率 分子分母）。
 */
const 审核状态_OPTS = ['待审核', '已通过', '已驳回'];

export const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生', width: '170px', form: true, type: 'studentLink', required: true, listOrder: 1 },
  { key: '考勤状态', label: '考勤状态', width: '100px', filter: true, filterOptions: 考勤状态_OPTS, form: true, type: 'select', options: 考勤状态_OPTS, list: false },
  { key: '异常描述', label: '异常描述', form: true, type: 'textarea', list: false },
  { key: '班主任', label: '班主任', width: '100px', list: false },
  { key: '时段', label: '时段', width: '90px', filter: true, filterOptions: 时段_OPTS, form: true, type: 'select', options: 时段_OPTS, listOrder: 6 },
  { key: '学年', label: '学年', width: '80px', list: false },
  { key: '考勤日期', label: '考勤日期', width: '120px', form: true, type: 'date', listOrder: 2 },
  { key: '学期', label: '学期', width: '100px', filter: true, filterOptions: 学期_OPTS, form: true, type: 'select', options: 学期_OPTS, listOrder: 5 },
  { key: '班级', label: '班级', width: '100px', listOrder: 4 },
  { key: '考勤结果', label: '考勤结果', width: '110px', filter: true, filterOptions: 考勤结果_OPTS, form: true, type: 'select', options: 考勤结果_OPTS, listOrder: 3 },
  { key: '到校时间', label: '到校时间', width: '120px', form: true, type: 'date', list: false },
  { key: '离校时间', label: '离校时间', width: '120px', form: true, type: 'date', list: false },
  { key: '记录人', label: '记录人', width: '100px', list: false },
  { key: '通知状态', label: '通知状态', width: '110px', filter: true, filterOptions: 通知状态_OPTS, form: true, type: 'select', options: 通知状态_OPTS, list: false },
  { key: '处理结果', label: '处理结果', form: true, type: 'textarea', list: false },
  // ── 终态审核（教务审核后才计入出勤率与结算基数）──────────────────────────
  { key: '审核状态', label: '审核状态', width: '100px', filter: true, filterOptions: 审核状态_OPTS, form: true, type: 'text', readonly: true, listOrder: 7 },
  { key: '审核人', label: '审核人', width: '100px', form: true, type: 'text', readonly: true, listOrder: 8 },
  {
    key: '审核时间',
    label: '审核时间',
    width: '150px',
    form: true,
    type: 'text',
    readonly: true,
    listOrder: 9,
    render: (v) => <span className="muted">{v ? formatDateTime(v) : '—'}</span>,
  },
  { key: '审核意见', label: '审核意见', form: true, type: 'textarea', readonly: true, list: false },
];

/**
 * 笔记转换预填：从「异常描述/处理结果」里解析出时间与负责人。
 *
 * 解析实现统一在 `lib/noteAutoFill.ts`（全站共用一套），这里只声明本模块的字段规则。
 * ⚠️ 只填当前为空的字段，笔记映射已写入或用户已改的值不覆盖。
 */
const SPEC: NoteAutoFillSpec = {
  sourceKeys: ['异常描述', '处理结果'],
  // 班主任是固定岗位、不一定是录入人，所以不默认成登录用户
  dateKeys: [{ key: '考勤日期', keywords: ['考勤日期', '日期', '时间'] }],
};

export function parseAttendanceFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string },
): Record<string, unknown> {
  return enrichFromNotes(values, SPEC, {});
}
