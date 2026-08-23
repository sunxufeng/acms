#!/usr/bin/env node
/**
 * 检查「家校沟通表」在飞书 Base 是否存在，并列出其字段。
 * 用法：node scripts/check_home_school_comm.mjs [/path/to/.env]
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

async function main() {
  const token = await getToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) {
    console.error('LIST_FIELDS_FAILED (table may not exist):', JSON.stringify(data));
    process.exit(2);
  }
  const arr = Array.isArray(data.data) ? data.data : data.data?.items ?? [];
  const fields = arr.map((f) => f.field_name);
  console.log('TABLE_EXISTS: true');
  console.log('FIELD_COUNT:', fields.length);
  console.log('FIELDS:', JSON.stringify(fields));
  const needed = ['关联学生编号', '沟通内容', '家长反馈', '沟通时间'];
  const missing = needed.filter((f) => !fields.includes(f));
  console.log('MISSING_REQUIRED:', JSON.stringify(missing));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
