#!/usr/bin/env node
/**
 * One-time setup: create the IDP方案 / IDP沟通记录 Feishu Base tables.
 * Usage: node scripts/setup_idp_tables.mjs [/path/to/.env]
 * Reads FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN.
 * Prints the resulting tableIds to register in packages/contracts/src/tables.ts.
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

const envPath = process.argv[2] || '.env';
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

const IDP_PLAN_FIELDS = [
  { field_name: '关联学生', type: 1 },
  { field_name: '学期', type: 1 },
  { field_name: '导师', type: 1 },
  { field_name: '状态', type: 3, property: { options: [{ name: '草稿' }, { name: '待确认' }, { name: '已确认' }, { name: '已关闭' }] } },
  { field_name: '人生平衡轮', type: 1 },
  { field_name: '提升领域', type: 1 },
  { field_name: '重视原因', type: 1 },
  { field_name: '提升计划', type: 1 },
  { field_name: '目标列表', type: 1 },
  { field_name: '阶段成果', type: 1 },
  { field_name: '展示方式', type: 1 },
  { field_name: '展示内容', type: 1 },
  { field_name: '展示亮点', type: 1 },
  { field_name: '邀请人员', type: 1 },
  { field_name: '学生确认时间', type: 5 },
  { field_name: '导师确认时间', type: 5 },
  { field_name: '原始文档', type: 1 },
  { field_name: '制定日期', type: 5 },
];

const IDP_COMM_FIELDS = [
  { field_name: '关联IDP方案', type: 1 },
  { field_name: '沟通日期', type: 5 },
  { field_name: '沟通人', type: 1 },
  { field_name: '沟通内容', type: 1 },
  { field_name: '需要的帮助/下一步计划', type: 1 },
  { field_name: '原始文档', type: 1 },
];

async function createTable(token, name, fields) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ table: { name, fields } }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`createTable(${name}) failed:`, JSON.stringify(data));
    process.exit(1);
  }
  return { tableId: data.data.table_id, name: data.data.name ?? name };
}

async function main() {
  const token = await getToken();
  const plan = await createTable(token, 'IDP方案', IDP_PLAN_FIELDS);
  const comm = await createTable(token, 'IDP沟通记录', IDP_COMM_FIELDS);
  console.log('IDP_PLAN_TABLE_ID=' + plan.tableId);
  console.log('IDP_COMM_TABLE_ID=' + comm.tableId);
  console.log('---');
  console.log(`  idpPlan: { tableId: '${plan.tableId}', name: 'IDP方案' },`);
  console.log(`  idpCommunication: { tableId: '${comm.tableId}', name: 'IDP沟通记录' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
