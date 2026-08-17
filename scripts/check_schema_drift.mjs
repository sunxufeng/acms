#!/usr/bin/env node
/**
 * check_schema_drift.mjs — M7「Base Schema Drift 检测」
 *
 * 比较「代码已注册飞书表(TABLES)」的线上真实字段结构，与基线快照
 * docs/base-schema-snapshot.json（2026-08-16 拉取）的差异，输出：
 *   - 基线内表的字段增/删（视为 schema 漂移，exit 1）
 *   - 已注册但未纳入基线的新表（warning）
 *
 * 用法：node scripts/check_schema_drift.mjs
 * 依赖：/opt/acms/.env（FEISHU_APP_ID/SECRET、FEISHU_BASE_TOKEN）
 */
import { readFileSync } from 'node:fs';
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
    } catch { /* try next */ }
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
  return j.data;
}
async function liveFields(tableId) {
  const d = await api(`/open-apis/bitable/v1/apps/${BASE}/tables/${tableId}/fields?page_size=200`);
  return (d.items || []).map((f) => ({ name: f.field_name, type: f.type, ui_type: f.ui_type }));
}

// 载入已注册表（优先仓库 dist，回退本地）
const require = createRequire(import.meta.url);
let TABLES;
for (const p of [
  '/opt/acms/repo/packages/contracts/dist/tables.js',
  new URL('../packages/contracts/dist/tables.js', import.meta.url).pathname,
]) {
  try { TABLES = require(p).TABLES; break; } catch { /* next */ }
}
if (!TABLES) { console.error('无法加载 TABLES（请先构建 contracts）'); process.exit(2); }

// 基线（按 table_id 建索引）
const SNAP_PATHS = [
  '/opt/acms/repo/docs/base-schema-snapshot.json',
  new URL('../docs/base-schema-snapshot.json', import.meta.url).pathname,
];
let baseline;
for (const p of SNAP_PATHS) {
  try { baseline = JSON.parse(readFileSync(p, 'utf8')); break; } catch { /* next */ }
}
if (!baseline) { console.error('缺少基线快照 docs/base-schema-snapshot.json'); process.exit(2); }
const baseByTid = {};
for (const [name, t] of Object.entries(baseline.tables)) baseByTid[t.table_id] = { name, fields: t.fields };

let drift = 0, warns = 0;
console.log('== Base Schema Drift 检测 ==');
for (const [regName, meta] of Object.entries(TABLES)) {
  const tableId = meta.tableId;
  let live;
  try { live = await liveFields(tableId); }
  catch (e) { console.log(`✗ ${regName} (${tableId}) 拉取失败: ${e.message}`); warns++; continue; }
  const base = baseByTid[tableId];
  if (!base) { console.log(`⚠ ${regName} (${tableId}) 已注册但未纳入基线快照（新增表）`); warns++; continue; }
  const baseNames = new Set(base.fields.map((f) => f.name));
  const liveNames = new Set(live.map((f) => f.name));
  const added = [...liveNames].filter((n) => !baseNames.has(n));
  const removed = [...baseNames].filter((n) => !liveNames.has(n));
  if (added.length || removed.length) {
    drift++;
    console.log(`✗ ${regName} (${tableId}) 漂移:`);
    if (added.length) console.log(`    新增字段: ${added.join(', ')}`);
    if (removed.length) console.log(`    删除字段: ${removed.join(', ')}`);
  } else {
    console.log(`✓ ${regName} (${tableId}) 字段结构一致 (${live.length} 字段)`);
  }
}
console.log('== 结束 ==');
console.log(`漂移表: ${drift}  警告: ${warns}`);
process.exit(drift > 0 ? 1 : 0);
