#!/usr/bin/env node
/**
 * One-time setup: add sign-related fields to the existing 考勤记录表 (student attendance table).
 *
 * The 考勤记录表 already has 考勤状态(正常/异常) / 考勤日期 / 到校时间 / 离校时间 /
 * 关联学生编号(link). This script adds the fields required by the mobile clock-in
 * (sign) flow, per docs/student-portal-plan.md §9:
 *
 *   方向             single-select   到达 / 离开
 *   签到方式         single-select   gps / wifi
 *   签到WiFi_SSID    text            本次打卡连入的 WiFi SSID
 *   签到GPS          text            本次打卡 GPS（纬度,经度，gcj02）
 *   签到距离(米)     number           GPS 距最近围栏中心的距离（米）
 *   校区             text             打卡时所在/归属校区（自由文本，与档案一致）
 *
 * Usage:
 *   node scripts/setup_attendance_sign_fields.mjs [/path/to/.env]
 *
 * Idempotent: lists existing fields first and skips any that already exist.
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
const TABLE_ID = process.env.ATTENDANCE_TABLE_ID || 'tblUkd1JKi4T7XQb'; // 考勤记录表

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

async function listFields(token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error('listFields failed:', JSON.stringify(data));
    process.exit(1);
  }
  return (data.data?.items ?? []).map((f) => f.field_name);
}

async function createField(token, field) {
  // number/text fields must NOT carry `property` (Feishu rejects with 1254001)
  const payload = { ...field };
  if (payload.type === 1 || payload.type === 2) delete payload.property;
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`createField "${field.field_name}" failed:`, JSON.stringify(data));
    process.exit(1);
  }
  console.log(`  + added field "${field.field_name}" (type=${field.type})`);
}

const FIELDS = [
  { field_name: '方向', type: 3, property: { options: [{ name: '到达' }, { name: '离开' }] } },
  { field_name: '签到方式', type: 3, property: { options: [{ name: 'gps' }, { name: 'wifi' }] } },
  { field_name: '签到WiFi_SSID', type: 1 },
  { field_name: '签到GPS', type: 1 },
  { field_name: '签到距离(米)', type: 2 },
  { field_name: '校区', type: 1 },
];

async function main() {
  const token = await getToken();
  const existing = await listFields(token);
  console.log(`Table ${TABLE_ID} currently has ${existing.length} fields: ${existing.join(', ')}`);

  let added = 0;
  for (const f of FIELDS) {
    if (existing.includes(f.field_name)) {
      console.log(`  = skip existing field "${f.field_name}"`);
      continue;
    }
    await createField(token, f);
    added++;
  }
  console.log(`Done. Added ${added} new field(s) to 考勤记录表 (${TABLE_ID}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
