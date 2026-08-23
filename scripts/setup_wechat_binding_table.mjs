#!/usr/bin/env node
/**
 * One-time setup: create the 微信登录用户 (WeChat login user) Feishu Base table.
 *
 * Usage (on server where /opt/acms/.env holds Feishu creds):
 *   node scripts/setup_wechat_binding_table.mjs [/path/to/.env]
 *
 * Reads FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN, obtains a
 * tenant_access_token, then creates the table. Prints the resulting tableId
 * so it can be registered in packages/contracts/src/tables.ts.
 *
 * Idempotent-ish: if the table already exists the API errors out; re-run after
 * adjusting the name if needed. Existing fields are detected via listFields so
 * a partial run can be resumed.
 *
 * Fields:
 *   标识         text            微信 openid（小程序）或 parent_<studentId>（家长 H5），唯一键
 *   关联学生      text            绑定的学生姓名（展示用）
 *   学号         text            学生编号 / 学籍号
 *   姓名         text            登录者姓名
 *   角色         single-select   学生 / 家长
 *   登录方式      single-select   微信小程序 / 家长H5
 *   状态         single-select   已绑定 / 已解绑
 *   绑定时间      datetime        首次绑定时间
 *   最近登录      datetime        最近一次登录时间
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

const TABLE_NAME = '微信登录用户';

async function listTables(token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error('listTables failed:', JSON.stringify(data));
    process.exit(1);
  }
  return data.data.items ?? [];
}

async function listFields(token, tableId) {
  let pageToken;
  const out = [];
  do {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) {
      console.error('listFields failed:', JSON.stringify(data));
      process.exit(1);
    }
    for (const f of data.data.items ?? []) out.push(f.field_name);
    pageToken = data.data.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  return out;
}

async function createTable(token) {
  const FIELDS = [
    { field_name: '标识', type: 1 },
    { field_name: '关联学生', type: 1 },
    { field_name: '学号', type: 1 },
    { field_name: '姓名', type: 1 },
    { field_name: '角色', type: 3, property: { options: [{ name: '学生' }, { name: '家长' }] } },
    { field_name: '登录方式', type: 3, property: { options: [{ name: '微信小程序' }, { name: '家长H5' }] } },
    { field_name: '状态', type: 3, property: { options: [{ name: '已绑定' }, { name: '已解绑' }] } },
  ];
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ table: { name: TABLE_NAME, fields: FIELDS } }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error('createTable failed:', JSON.stringify(data));
    process.exit(1);
  }
  return data.data.table_id;
}

async function createField(token, tableId, field_name, type, property) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ field_name, type, property }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`createField ${field_name} failed:`, JSON.stringify(data));
    process.exit(1);
  }
  return data.data.field_id;
}

async function main() {
  const token = await getToken();

  // 1) 已存在则复用
  const tables = await listTables(token);
  const existing = tables.find((t) => t.name === TABLE_NAME);
  let tableId = existing?.table_id;
  if (tableId) {
    console.log(`Reusing existing table "${TABLE_NAME}" (${tableId})`);
  } else {
    tableId = await createTable(token);
    console.log(`Created table "${TABLE_NAME}" (${tableId})`);
  }

  // 2) 补齐可能缺失的字段（幂等）
  const have = new Set(await listFields(token, tableId));
  const want = [
    { field_name: '绑定时间', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: '最近登录', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ];
  for (const f of want) {
    if (have.has(f.field_name)) {
      console.log(`字段已存在，跳过: ${f.field_name}`);
      continue;
    }
    await createField(token, tableId, f.field_name, f.type, f.property);
    console.log(`字段已创建: ${f.field_name}`);
  }

  console.log('── 注册到 packages/contracts/src/tables.ts ──');
  console.log(`  wechatBinding: { tableId: '${tableId}', name: '微信登录用户表' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
