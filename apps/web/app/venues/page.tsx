'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTranslations } from 'next-intl';

const TYPE_OPTS = ['普通教室', '实验室', '多媒体教室', '体育馆', '音乐教室', '美术教室', '计算机房', '会议室', '操场', '其他'];
const STATUS_OPTS = ['可用', '维护中', '停用', '预留'];
const CAMPUS_OPTS = ['主校区', '东校区', '西校区', '南校区', '北校区', '国际部校区'];

export default function VenuesPage() {
  const t = useTranslations('teachers');

  const COLUMNS: CrudColumn[] = [
    { key: '场地名称', label: t('colVenueName'), width: '160px', form: true, required: true, type: 'text' },
    { key: '校区', label: t('colCampus'), width: '110px', filter: true, filterOptions: CAMPUS_OPTS, form: true, type: 'select', options: CAMPUS_OPTS },
    { key: '场地类型', label: t('colType'), width: '120px', filter: true, filterOptions: TYPE_OPTS, form: true, type: 'select', options: TYPE_OPTS },
    { key: '容纳人数', label: t('colCapacity'), width: '80px', form: true, type: 'number' },
    { key: '可用状态', label: t('colStatus'), width: '100px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
    { key: '设备与资源', label: t('colEquipmentResource'), form: true, type: 'textarea' },
    { key: '可用时段说明', label: t('colAvailablePeriod'), form: true, type: 'text' },
    { key: '备注', label: t('colRemark'), form: true, type: 'textarea' },
    { key: '更新时间', label: t('colUpdated'), width: '90px', render: (v) => <span className="muted">{String(v ?? '').slice(0, 10)}</span> },
  ];

  function statusClass(s: string): string {
    if (s === '可用') return 'status-active';
    if (s === '停用') return 'status-left';
    if (s === '维护中') return 'status-warn';
    return '';
  }

  return (
    <CrudPage
      title={t('titleVenues')}
      subtitle={t('subtitleVenues')}
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
