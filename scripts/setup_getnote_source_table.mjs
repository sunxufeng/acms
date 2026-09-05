#!/usr/bin/env node
/**
 * One-time setup: create the 知识库配置 (getnote_source) Feishu Base table.
 *
 * Usage (on server):
 *   node scripts/setup_getnote_source_table.mjs [/path/to/.env]
 *
 * Idempotent: if a table named 知识库配置 already exists, prints its table_id
 * and exits 0 without creating a duplicate.
 *
 * Fields:
 *   配置名称        text            配置显示名（主字段）
 *   笔记类型        single-select   得到大脑 / 飞书秒记 / 钉钉助记 / 元宝录音 / 腾讯会议
 *   收取频率        single-select   每15分钟 / 每30分钟 / 每小时 / 每天
 *   启用状态        single-select   启用 / 停用（停用的配置被 cron 跳过）
 *   凭证            text            KMS 信封加密后的 JSON（含 apiKey/clientId）
 *   上次同步时间    datetime        毫秒时间戳，base-adapter 自动互转
 *   上次同步结果    text            如「处理 12 条，本次共拉取 50 条」
 *   备注            text
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

const TABLE_NAME = '知识库配置';

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

async function findExisting(token) {
  let pageToken;
  for (let i = 0; i < 20; i++) {
    const url =
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables?page_size=100` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) {
      console.error('listTables failed:', JSON.stringify(data));
      process.exit(1);
    }
    const hit = (data.data?.items ?? []).find((t) => t.name === TABLE_NAME);
    if (hit) return hit.table_id;
    if (!data.data?.has_more) return null;
    pageToken = data.data.page_token;
  }
  return null;
}

const FIELDS = [
  { field_name: '配置名称', type: 1 },
  {
    field_name: '笔记类型',
    type: 3,
    property: {
      options: [
        { name: '得到大脑' },
        { name: '飞书秒记' },
        { name: '钉钉助记' },
        { name: '元宝录音' },
        { name: '腾讯会议' },
      ],
    },
  },
  {
    field_name: '收取频率',
    type: 3,
    property: {
      options: [
        { name: '每15分钟' },
        { name: '每30分钟' },
        { name: '每小时' },
        { name: '每天' },
      ],
    },
  },
  {
    field_name: '启用状态',
    type: 3,
    property: { options: [{ name: '启用' }, { name: '停用' }] },
  },
  { field_name: '凭证', type: 1 },
  {
    field_name: '上次同步时间',
    type: 5,
    property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false },
  },
  { field_name: '上次同步结果', type: 1 },
  { field_name: '备注', type: 1 },
];

async function main() {
  const token = await getToken();

  const existing = await findExisting(token);
  if (existing) {
    console.log(`GETNOTE_SOURCE_TABLE_ID=${existing}`);
    console.log(`Table "${TABLE_NAME}" already exists (${existing}), skipping creation.`);
    console.log('Register it in packages/contracts/src/tables.ts as:');
    console.log(`  getnoteSource: { tableId: '${existing}', name: '知识库配置' },`);
    return;
  }

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
  const tableId = data.data.table_id;
  console.log(`GETNOTE_SOURCE_TABLE_ID=${tableId}`);
  console.log(`Created table "${TABLE_NAME}" (${tableId}) with ${FIELDS.length} fields.`);
  console.log('Register it in packages/contracts/src/tables.ts as:');
  console.log(`  getnoteSource: { tableId: '${tableId}', name: '知识库配置' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
