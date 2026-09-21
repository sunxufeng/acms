import type { CrudColumn } from '../../components/CrudPage';
import { enrichFromNotes, type NoteAutoFillSpec } from '../../lib/noteAutoFill';
import { defaultFollowupOwner } from '@acms/contracts';

const 跟进方式_OPTS = ['电话', '微信', '邮件', '活动', '问卷', '其他'];
const 校友阶段_OPTS = ['毕业当年', '升学阶段', '就业阶段', '长期校友'];
const 当前去向类型_OPTS = ['升学', '就业', '创业', '间隔年', '其他'];
const 跟进状态_OPTS = ['待跟进', '保持联系', '暂时失联', '停止跟进'];

export const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生', width: '170px', form: true, type: 'studentLink', required: true, listOrder: 1 },
  { key: '跟进事项', label: '跟进事项', form: true, type: 'textarea', listOrder: 3 },
  { key: '跟进时间', label: '跟进日期', width: '120px', form: true, type: 'date', listOrder: 2 },
  { key: '跟进备注', label: '跟进备注', form: true, type: 'textarea', list: false },
  { key: '跟进方式', label: '跟进方式', width: '100px', filter: true, filterOptions: 跟进方式_OPTS, form: true, type: 'select', options: 跟进方式_OPTS, listOrder: 5 },
  { key: '校友阶段', label: '校友阶段', width: '110px', filter: true, filterOptions: 校友阶段_OPTS, form: true, type: 'select', options: 校友阶段_OPTS, list: false },
  // 2026-09-21：加进表单 + 开 person 下拉（原先只在列表里显示，且 meta.readonly 会吞掉写入
  // ⇒ 笔记转换预填「跟进人」等于没写进去）。默认值口径见文件末尾的 parseAlumniFromSummary。
  { key: '跟进负责人', label: '跟进人', width: '110px', form: true, type: 'person', listOrder: 4 },
  { key: '当前去向类型', label: '当前去向', width: '100px', filter: true, filterOptions: 当前去向类型_OPTS, form: true, type: 'select', options: 当前去向类型_OPTS, list: false },
  { key: '当前学校或单位', label: '学校/单位', width: '130px', form: true, type: 'text', list: false },
  { key: '专业或岗位', label: '专业/岗位', width: '120px', form: true, type: 'text', list: false },
  { key: '联系方式变更', label: '联系方式变更', form: true, type: 'textarea', list: false },
  { key: '校友参与意愿', label: '参与意愿', width: '120px', list: false },
  { key: '下次跟进日期', label: '下次跟进', width: '120px', form: true, type: 'date', list: false },
  { key: '跟进状态', label: '跟进状态', width: '100px', filter: true, filterOptions: 跟进状态_OPTS, form: true, type: 'select', options: 跟进状态_OPTS, listOrder: 6 },
];

/**
 * 笔记转换预填：从「跟进事项/跟进备注」里解析出时间与负责人。
 *
 * 解析实现统一在 `lib/noteAutoFill.ts`（全站共用一套），这里只声明本模块的字段规则。
 * ⚠️ 只填当前为空的字段，笔记映射已写入或用户已改的值不覆盖。
 */
const SPEC: NoteAutoFillSpec = {
  sourceKeys: ['跟进事项', '跟进备注'],
  dateKeys: [{ key: '跟进时间', keywords: ['跟进时间', '跟进日期', '时间', '日期'] }],
};

export function parseAlumniFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string; noteOwner?: string },
): Record<string, unknown> {
  // 「跟进负责人」口径（2026-09-21 峰哥确认）：**代转别人的笔记 ⇒ 记笔记归属人；
  // 其余（自己录的笔记 / 归属人取不到）⇒ 记当前登录用户**。
  // 判据收敛在 `@acms/contracts` 的 `defaultFollowupOwner()`（招生跟进/实践活动共用同一份）。
  return enrichFromNotes(values, SPEC, { 跟进负责人: defaultFollowupOwner(ctx ?? {}) });
}
