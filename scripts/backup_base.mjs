#!/usr/bin/env node
/**
 * backup_base.mjs — M7「备份恢复演练」之 Base 全量导出
 *
 * 将代码已注册的所有飞书表记录导出为带时间戳的 .json.gz，
 * 写入 /opt/acms/backup/（保留最近 14 份，自动轮转）。
 * 用于异地备份与 RTO≤30min 恢复演练的数据源。
 *
 * 用法：node scripts/backup_base.mjs
 * 依赖：/opt/acms/.env（FEISHU_APP_ID/SECRET、FEISHU_BASE_TOKEN）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const ENV_PATHS = ['/opt/acms/.env', new URL('../.env', import.meta.url).pathname];
function loadEnv() {
  const env = {};
  for (const p of ENV_PATHS) {
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      break;
    } catch { /* next */ }
  }
  return env;
}
const env = loadEnv();
const APP_ID = env.FEISHU_APP_ID, APP_SECRET = env.FEISHU_APP_SECRET, BASE = env.FEISHU_BASE_TOKEN;
if (!APP_ID || !APP_SECRET || !BASE) { console.error('缺少飞书凭证(env)'); process.exit(2); }

let token;
async function ttoken() {
  if (token) return token;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('token: ' + JSON.stringify(j));
  token = j.tenant_access_token;
  return token;
}
async function api(path, opts = {}) {
  const t = await ttoken();
  const r = await fetch('https://open.feishu.cn' + path, { ...opts, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json();
  if (j.code !== 0) throw new Error(path + ' -> ' + JSON.stringify(j));
  return j;
}
async function allRecords(tableId) {
  const out = [];
  let tok;
  let guard = 0;
  do {
    const j = await api(`/open-apis/bitable/v1/apps/${BASE}/tables/${tableId}/records/search?page_size=100${tok ? `&page_token=${tok}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({ field_names: [], automatic_fields: false }),
    });
    out.push(...(j.data.items || []).map((r) => ({ record_id: r.record_id, fields: r.fields })));
    tok = j.data.has_more ? j.data.page_token : undefined;
  } while (tok && guard++ < 500);
  return out;
}

const require = createRequire(import.meta.url);
let TABLES;
for (const p of [
  '/opt/acms/repo/packages/contracts/dist/tables.js',
  new URL('../packages/contracts/dist/tables.js', import.meta.url).pathname,
]) {
  try { TABLES = require(p).TABLES; break; } catch { /* next */ }
}
if (!TABLES) { console.error('无法加载 TABLES（请先构建 contracts）'); process.exit(2); }

const BACKUP_DIR = '/opt/acms/backup';
mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const payload = { exported_at: new Date().toISOString(), app_token: BASE, tables: {} };
let total = 0;
for (const [name, meta] of Object.entries(TABLES)) {
  try {
    const recs = await allRecords(meta.tableId);
    payload.tables[name] = { table_id: meta.tableId, count: recs.length, records: recs };
    total += recs.length;
    console.log(`✓ ${name} (${meta.tableId}): ${recs.length} 条`);
  } catch (e) {
    console.log(`✗ ${name} (${meta.tableId}) 失败: ${e.message}`);
    payload.tables[name] = { table_id: meta.tableId, error: e.message };
  }
}
const file = `${BACKUP_DIR}/base_${stamp}.json.gz`;
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(payload, null, 2))));
console.log(`已写出 ${file}（共 ${total} 条记录）`);

// 轮转：保留最近 14 份
const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('base_') && f.endsWith('.json.gz')).sort();
while (files.length > 14) { const old = files.shift(); unlinkSync(`${BACKUP_DIR}/${old}`); console.log(`轮转删除旧备份 ${old}`); }
console.log('备份完成。');
