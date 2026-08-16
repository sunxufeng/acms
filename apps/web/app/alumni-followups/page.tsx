'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 跟进方式_OPTS = ['电话', '微信', '邮件', '活动', '问卷', '其他'];
const 校友阶段_OPTS = ['毕业当年', '升学阶段', '就业阶段', '长期校友'];
const 当前去向类型_OPTS = ['升学', '就业', '创业', '间隔年', '其他'];
const 校友参与意愿_OPTS = ['返校分享', '导师支持', '实习机会', '捐赠支持', '活动参与', '暂无'];
const 跟进状态_OPTS = ['待跟进', '保持联系', '暂时失联', '停止跟进'];

const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生编号', width: '120px', form: true, type: 'text' },
  { key: '跟进事项', label: '跟进事项', width: '140px', form: true, type: 'text' },
  { key: '跟进时间', label: '跟进时间', width: '120px', form: true, type: 'date' },
  { key: '跟进备注', label: '跟进备注', form: true, type: 'textarea' },
  { key: '跟进方式', label: '跟进方式', width: '100px', filter: true, filterOptions: 跟进方式_OPTS, form: true, type: 'select', options: 跟进方式_OPTS },
  { key: '校友阶段', label: '校友阶段', width: '110px', filter: true, filterOptions: 校友阶段_OPTS, form: true, type: 'select', options: 校友阶段_OPTS },
  { key: '跟进负责人', label: '负责人', width: '100px', form: true, type: 'text' },
  { key: '当前去向类型', label: '去向类型', width: '110px', filter: true, filterOptions: 当前去向类型_OPTS, form: true, type: 'select', options: 当前去向类型_OPTS },
  { key: '当前学校或单位', label: '学校/单位', width: '140px', form: true, type: 'text' },
  { key: '专业或岗位', label: '专业/岗位', width: '120px', form: true, type: 'text' },
  { key: '联系方式变更', label: '联系方式变更', width: '130px', form: true, type: 'text' },
  { key: '校友参与意愿', label: '参与意愿', width: '160px', form: true, type: 'multiselect', options: 校友参与意愿_OPTS },
  { key: '下次跟进日期', label: '下次跟进', width: '120px', form: true, type: 'date' },
  { key: '跟进状态', label: '状态', width: '110px', filter: true, filterOptions: 跟进状态_OPTS, form: true, type: 'select', options: 跟进状态_OPTS },
];

export default function AlumniFollowupsPage() {
  return (
    <CrudPage
      title="校友跟进"
      subtitle="校友长期跟进与参与意愿（M1 学生域）"
      columns={COLUMNS}
      statusField="跟进状态"
      api={{
        list: (p) => api.listAlumniFollowups(p),
        create: (d) => api.createAlumniFollowup(d),
        update: (id, d) => api.updateAlumniFollowup(id, d),
        archive: (id) => api.archiveAlumniFollowup(id),
      }}
    />
  );
}
