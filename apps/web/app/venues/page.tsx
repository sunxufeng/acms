'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const TYPE_OPTS = ['普通教室', '实验室', '多媒体教室', '体育馆', '音乐教室', '美术教室', '计算机房', '会议室', '操场', '其他'];
const STATUS_OPTS = ['可用', '维护中', '停用', '预留'];
const CAMPUS_OPTS = ['主校区', '东校区', '西校区', '南校区', '北校区', '国际部校区'];

const COLUMNS: CrudColumn[] = [
  { key: '场地名称', label: '场地名称', width: '160px', form: true, required: true, type: 'text' },
  { key: '校区', label: '校区', width: '110px', filter: true, filterOptions: CAMPUS_OPTS, form: true, type: 'select', options: CAMPUS_OPTS },
  { key: '场地类型', label: '类型', width: '120px', filter: true, filterOptions: TYPE_OPTS, form: true, type: 'select', options: TYPE_OPTS },
  { key: '容纳人数', label: '容纳', width: '80px', form: true, type: 'number' },
  { key: '可用状态', label: '状态', width: '100px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
  { key: '设备与资源', label: '设备与资源', form: true, type: 'textarea' },
  { key: '可用时段说明', label: '可用时段', form: true, type: 'text' },
  { key: '备注', label: '备注', form: true, type: 'textarea' },
  { key: '更新时间', label: '更新', width: '90px', render: (v) => <span className="muted">{String(v ?? '').slice(0, 10)}</span> },
];

function statusClass(s: string): string {
  if (s === '可用') return 'status-active';
  if (s === '停用') return 'status-left';
  if (s === '维护中') return 'status-warn';
  return '';
}

export default function VenuesPage() {
  return (
    <CrudPage
      title="场地资源"
      subtitle="教学场地与资源预约状态管理（M2 排课域）"
      columns={COLUMNS}
      statusField="可用状态"
      statusClass={statusClass}
      api={{
        list: (p) => api.listVenues(p),
        create: (d) => api.createVenue(d),
        update: (id, d) => api.updateVenue(id, d),
        archive: (id) => api.archiveVenue(id),
      }}
    />
  );
}
