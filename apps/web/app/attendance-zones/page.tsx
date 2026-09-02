'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 状态_OPTS = ['启用', '停用'];

const COLUMNS: CrudColumn[] = [
  { key: '校区', label: '校区', width: '160px', filter: true, filterType: 'select', dictKey: '校区', form: true, type: 'select', required: true },
  {
    key: 'map_geo',
    label: '围栏中心(经纬度)',
    form: true,
    type: 'map',
    latKey: '围栏中心(纬度)',
    lngKey: '围栏中心(经度)',
    required: true,
    list: false,
    hint: '点击地图或拖动标记选取打卡中心点；坐标采用 WGS-84（与设备 GPS 一致）',
  },
  { key: '围栏中心(纬度)', label: '纬度(°)', width: '120px', listOrder: 2 },
  { key: '围栏中心(经度)', label: '经度(°)', width: '120px', listOrder: 3 },
  { key: '围栏半径(米)', label: '半径(米)', width: '100px', form: true, type: 'number', listOrder: 4 },
  {
    key: 'WiFi_SSID列表',
    label: 'WiFi SSID',
    form: true,
    type: 'tags',
    listOrder: 5,
    quickFill: 'wifi',
    hint: '可添加多个。点「一键填入本机 WiFi」自动读取（需先运行 node scripts/wifi-helper.mjs 并用本地 dev http://localhost:3000 打开本页）；或手动填入本机当前连接的 WiFi 名称（SSID）。',
  },
  {
    key: 'WiFi_BSSID列表',
    label: 'WiFi BSSID',
    form: true,
    type: 'tags',
    listOrder: 6,
    hint: '可添加多个（选填，用于更严格的 WiFi 校验）',
  },
  { key: '适用学生范围', label: '适用学生范围', form: true, type: 'text', listOrder: 7 },
  { key: '状态', label: '状态', width: '90px', filter: true, filterOptions: 状态_OPTS, form: true, type: 'select', options: 状态_OPTS, listOrder: 8 },
];

export default function AttendanceZonesPage() {
  return (
    <CrudPage
      title="考勤围栏"
      subtitle="配置各校区 GPS 打卡中心点（WGS-84 经纬度）与允许 WiFi（SSID / BSSID）；移动端打卡时按就近围栏 + WiFi 校验（见 docs/student-portal-plan §6）"
      columns={COLUMNS}
      statusField="状态"
      inlineEdit
      standaloneForm
      search={{ placeholder: '校区' }}
      api={{
        list: (p) => api.listAttendanceZones(p),
        create: (d) => api.createAttendanceZone(d),
        update: (id, d) => api.updateAttendanceZone(id, d),
        archive: (id) => api.archiveAttendanceZone(id),
      }}
    />
  );
}
