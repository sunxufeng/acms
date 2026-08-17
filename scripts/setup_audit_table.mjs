#!/usr/bin/env node
/**
 * One-time setup: create the 审计日志 (audit log) Feishu Base table.
 *
 * Usage (on server):
 *   node scripts/setup_audit_table.mjs [/path/to/.env]
 *
 * Reads FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN, obtains a
 * tenant_access_token, then creates the table. Prints the resulting tableId
 * so it can be registered in packages/contracts/src/tables.ts.
 *
 * Idempotent-ish: if the table already exists the API returns an error and we
 * surface it; just re-run after adjusting the name if needed.
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
  { field_name: '操作时间', type: 5 },
  { field_name: '操作人', type: 1 },
  { field_name: '操作类型', type: 3, property: { options: [{ name: '创建' }, { name: '更新' }, { name: '删除' }] } },
  { field_name: '业务模块', type: 1 },
  { field_name: '记录标识', type: 1 },
  { field_name: '摘要', type: 1 },
  { field_name: '详情', type: 1 },
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
      body: JSON.stringify({ table: { name: '审计日志', fields: FIELDS } }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error('createTable failed:', JSON.stringify(data));
    process.exit(1);
  }
  const tableId = data.data.table_id;
  const name = data.data.name ?? '审计日志';
  console.log(`AUDIT_TABLE_ID=${tableId}`);
  console.log(`Created table "${name}" (${tableId})`);
  console.log('Register it in packages/contracts/src/tables.ts as:');
  console.log(`  auditLog: { tableId: '${tableId}', name: '审计日志' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
