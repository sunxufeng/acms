#!/usr/bin/env node
/**
 * 幂等补齐「家校沟通表」必填字段（家长反馈写入所需）。
 * 当前缺：沟通内容（text）。
 * 用法：node scripts/setup_home_school_comm_fields.mjs [/path/to/.env]
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
const TABLE_ID = process.env.HOMESCHOOL_TABLE_ID || 'tbl8Isr46G3BRQ52';

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

const NEEDED = [
  { field_name: '沟通内容', type: 1 }, // text
];

async function listFields(token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error('LIST_FIELDS_FAILED:', JSON.stringify(data));
    process.exit(2);
  }
  const arr = Array.isArray(data.data) ? data.data : data.data?.items ?? [];
  return arr.map((f) => f.field_name);
}

async function addField(token, field) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ field_name: field.field_name, type: field.type }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`ADD_FIELD_FAILED (${field.field_name}):`, JSON.stringify(data));
    process.exit(1);
  }
  console.log(`Added field: ${field.field_name}`);
}

async function main() {
  const token = await getToken();
  const existing = await listFields(token);
  console.log('Existing fields:', existing.length);
  for (const f of NEEDED) {
    if (existing.includes(f.field_name)) {
      console.log(`Skip (exists): ${f.field_name}`);
    } else {
      await addField(token, f);
    }
  }
  console.log('DONE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
