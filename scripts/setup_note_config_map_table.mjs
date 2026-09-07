#!/usr/bin/env node
/**
 * One-time setup: create the 笔记配置映射 (note_config_map) Feishu Base table.
 *
 * Usage (on server):
 *   node scripts/setup_note_config_map_table.mjs [/path/to/.env]
 *
 * Idempotent: if a table named 笔记配置映射 already exists, prints its table_id
 * and exits 0 without creating a duplicate.
 *
 * 为什么需要这张表：
 *   Get笔记 的 note 对象里**没有任何字段**能标识它属于 ACMS 的哪个「知识库配置」——
 *   实测 14 条笔记的 source 字段全是 "app"（Get笔记 平台自己的来源标识，指手机 App 录音），
 *   note_type 全是 recorder_audio，tags 里也没有配置名。
 *   所以「笔记 ↔ 配置」的归属只能由 ACMS 侧建立：自动同步时（processNote）写入，
 *   历史笔记用 backfill_note_config_map.mjs 补。
 *
 * Fields:
 *   笔记ID           text    主字段；int64，务必当字符串处理（转 Number 会丢精度）
 *   笔记标题         text    冗余，排查时人眼可辨
 *   配置ID           text    知识库配置表的 recordId
 *   配置名称         text    快照；显示时优先用配置表当前名称，改名能自动生效
 *   笔记类型         text    冗余（如「得到大脑」）
 *   首次同步时间     datetime
 *   更新时间         datetime  重复同步时刷新
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

const TABLE_NAME = '笔记配置映射';

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
  { field_name: '笔记ID', type: 1 },
  { field_name: '笔记标题', type: 1 },
  { field_name: '配置ID', type: 1 },
  { field_name: '配置名称', type: 1 },
  { field_name: '笔记类型', type: 1 },
  {
    field_name: '首次同步时间',
    type: 5,
    property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false },
  },
  {
    field_name: '更新时间',
    type: 5,
    property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false },
  },
];

async function main() {
  const token = await getToken();

  const existing = await findExisting(token);
  if (existing) {
    console.log(`NOTE_CONFIG_MAP_TABLE_ID=${existing}`);
    console.log(`Table "${TABLE_NAME}" already exists (${existing}), skipping creation.`);
    console.log('Register it in packages/contracts/src/tables.ts as:');
    console.log(`  noteConfigMap: { tableId: '${existing}', name: '笔记配置映射' },`);
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
  console.log(`NOTE_CONFIG_MAP_TABLE_ID=${tableId}`);
  console.log(`Created table "${TABLE_NAME}" (${tableId}) with ${FIELDS.length} fields.`);
  console.log('Register it in packages/contracts/src/tables.ts as:');
  console.log(`  noteConfigMap: { tableId: '${tableId}', name: '笔记配置映射' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
