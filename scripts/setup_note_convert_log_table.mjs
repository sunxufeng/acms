#!/usr/bin/env node
/**
 * One-time setup: create the 笔记转换记录 (note_convert_log) Feishu Base table.
 *
 * Usage (on server):
 *   node scripts/setup_note_convert_log_table.mjs [/path/to/.env]
 *
 * Idempotent: if a table named 笔记转换记录 already exists, prints its table_id
 * and exits 0 without creating a duplicate.
 *
 * 为什么需要这张表：
 *   Get笔记 上游限制「单篇笔记最多 5 个标签」，而系统标签 + AI 标签往往已占掉 4 个，
 *   留痕标签只剩 1 个位 —— 导致一篇笔记只能成功留痕一个模块，之后转换全部静默失败。
 *   所以留痕改为落在 ACMS 自己这张表里，不再写 Get笔记 标签。
 *
 * Fields:
 *   笔记标题      text        主字段，人眼识别用
 *   笔记ID        text        Get笔记 的 19 位 id（int64，务必当字符串处理）
 *   目标模块      text        模块中文名，如「家校沟通」
 *   模块KEY       text        模块 key，如 homeSchoolComms
 *   转换次数      number      同一笔记 + 同一模块累加
 *   转换时间      datetime    毫秒时间戳，base-adapter 自动互转
 *   转换人        text        姓名
 *   目标记录ID    text        目标模块保存后回填的业务记录 id
 *   备注          text
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

const TABLE_NAME = '笔记转换记录';

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
  { field_name: '笔记标题', type: 1 },
  { field_name: '笔记ID', type: 1 },
  { field_name: '目标模块', type: 1 },
  { field_name: '模块KEY', type: 1 },
  { field_name: '转换次数', type: 2, property: { formatter: '0' } },
  {
    field_name: '转换时间',
    type: 5,
    property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false },
  },
  { field_name: '转换人', type: 1 },
  { field_name: '目标记录ID', type: 1 },
  { field_name: '备注', type: 1 },
];

async function main() {
  const token = await getToken();

  const existing = await findExisting(token);
  if (existing) {
    console.log(`NOTE_CONVERT_LOG_TABLE_ID=${existing}`);
    console.log(`Table "${TABLE_NAME}" already exists (${existing}), skipping creation.`);
    console.log('Register it in packages/contracts/src/tables.ts as:');
    console.log(`  noteConvertLog: { tableId: '${existing}', name: '笔记转换记录' },`);
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
  console.log(`NOTE_CONVERT_LOG_TABLE_ID=${tableId}`);
  console.log(`Created table "${TABLE_NAME}" (${tableId}) with ${FIELDS.length} fields.`);
  console.log('Register it in packages/contracts/src/tables.ts as:');
  console.log(`  noteConvertLog: { tableId: '${tableId}', name: '笔记转换记录' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
