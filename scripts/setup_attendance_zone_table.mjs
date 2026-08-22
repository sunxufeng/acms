#!/usr/bin/env node
/**
 * One-time setup: create the 考勤围栏 (attendance geofence zone) Feishu Base table.
 *
 * Usage (locally or on server):
 *   node scripts/setup_attendance_zone_table.mjs [/path/to/.env]
 *
 * Reads FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN, obtains a
 * tenant_access_token, then creates the table. Prints the resulting tableId
 * so it can be registered in packages/contracts/src/tables.ts.
 *
 * Idempotent-ish: if the table already exists the API returns an error and we
 * surface it; just re-run after adjusting the name if needed.
 *
 * Fields (see docs/student-portal-plan.md §7 区域配置模型):
 *   校区            text            校区/教学点名称（自由文本，便于快速录入）
 *   围栏中心(纬度)  number (gcj02)  围栏中心点纬度，gcj02 坐标系
 *   围栏中心(经度)  number (gcj02)  围栏中心点经度，gcj02 坐标系
 *   围栏半径(米)    number          允许打卡半径，默认 200
 *   WiFi_SSID列表   text            允许连入的 WiFi SSID（每行/逗号分隔一条）
 *   WiFi_BSSID列表  text            允许连入的 WiFi BSSID（每行/逗号分隔一条）
 *   适用学生范围     text            适用学生范围说明（如「全部」/班级名/年级）
 *   状态            single-select   启用 / 停用
 */
import fs from 'node:fs';

function loadEnv(path) {
  if (!path || !fs.existsSync(path)) return;
  const txt = fs.readFileSync(path, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const envPath = process.argv[2] || '/opt/acms/.env';
loadEnv(envPath);

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    console.error('tenant_access_token failed:', JSON.stringify(data));
    process.exit(1);
  }
  return data.tenant_access_token;
}

const FIELDS = [
  { field_name: '校区', type: 1 },
  { field_name: '围栏中心(纬度)', type: 2 },
  { field_name: '围栏中心(经度)', type: 2 },
  { field_name: '围栏半径(米)', type: 2 },
  { field_name: 'WiFi_SSID列表', type: 1 },
  { field_name: 'WiFi_BSSID列表', type: 1 },
  { field_name: '适用学生范围', type: 1 },
  { field_name: '状态', type: 3, property: { options: [{ name: '启用' }, { name: '停用' }] } },
];

async function main() {
  const token = await getToken();
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ table: { name: '考勤围栏', fields: FIELDS } }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error('createTable failed:', JSON.stringify(data));
    process.exit(1);
  }
  const tableId = data.data.table_id;
  const name = data.data.name ?? '考勤围栏';
  console.log(`ATTENDANCE_ZONE_TABLE_ID=${tableId}`);
  console.log(`Created table "${name}" (${tableId})`);
  console.log('Register it in packages/contracts/src/tables.ts as:');
  console.log(`  attendanceZone: { tableId: '${tableId}', name: '考勤围栏表' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
