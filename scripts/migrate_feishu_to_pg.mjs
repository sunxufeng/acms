#!/usr/bin/env node
/**
 * 飞书 Base → PostgreSQL 全量迁移。
 *
 * 用法（在 114 生产服务器上执行，需要能连本地 PG）：
 *   node scripts/migrate_feishu_to_pg.mjs                 # dry-run：只导出并落盘，不写 PG
 *   node scripts/migrate_feishu_to_pg.mjs --apply         # 导出 + 建表 + 导入 + 校验
 *   node scripts/migrate_feishu_to_pg.mjs --verify        # 只校验（读上次的导出文件）
 *   node scripts/migrate_feishu_to_pg.mjs --only=tblA,tblB
 *   node scripts/migrate_feishu_to_pg.mjs --export=/path/to.json
 *
 * 安全约定：
 *   - 默认 dry-run，必须显式 --apply 才写库
 *   - 导出文件落盘到 /opt/acms/data/，导入幂等（ON CONFLICT (id) DO UPDATE）
 *   - 导入后自动做「行数比对 + 抽样逐字段比对」
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VERIFY_ONLY = argv.includes('--verify');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;
const exportArg = argv.find((a) => a.startsWith('--export='));

// ---------- 环境变量 ----------
const env = {};
for (const line of fs.readFileSync('/opt/acms/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}
const APP_ID = env.FEISHU_APP_ID, APP_SECRET = env.FEISHU_APP_SECRET, BASE = env.FEISHU_BASE_TOKEN;
const DATABASE_URL = env.DATABASE_URL;
if (!APP_ID || !APP_SECRET || !BASE) throw new Error('缺少 FEISHU_* 环境变量');

// ---------- 飞书客户端 ----------
let token = '';
async function getToken() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('token fail: ' + JSON.stringify(j));
  token = j.tenant_access_token;
}
async function req(method, path, body) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch('https://open.feishu.cn' + path, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await r.json();
      if (j.code === 0) return j.data ?? {};
      if (j.code === 99991400 || j.code === 1254290) { await new Promise((s) => setTimeout(s, 800 * 2 ** i)); continue; }
      throw new Error(`${method} ${path} -> ${j.code}: ${j.msg}`);
    } catch (e) { last = e; if (i < 4) await new Promise((s) => setTimeout(s, 500 * 2 ** i)); }
  }
  throw last;
}
async function listFields(tid) {
  const out = []; let pt;
  do {
    const d = await req('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=100${pt ? `&page_token=${pt}` : ''}`);
    for (const f of d.items ?? []) out.push({ name: f.field_name, type: f.type, property: f.property ?? {} });
    pt = d.has_more ? d.page_token : undefined;
  } while (pt);
  return out;
}
async function dumpRows(tid) {
  const out = []; let pt;
  do {
    const d = await req('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/search?page_size=500${pt ? `&page_token=${pt}` : ''}`, { automatic_fields: false });
    for (const r of d.items ?? []) out.push({ id: r.record_id, fields: r.fields ?? {}, createdAt: r.created_at ?? null });
    pt = d.has_more ? d.page_token : undefined;
  } while (pt);
  return out;
}

// ---------- 导出 ----------
async function doExport() {
  await getToken();
  const tables = await req('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`);
  const list = (tables.items ?? []).filter((t) => !ONLY || ONLY.includes(t.table_id));
  console.log(`[导出] ${list.length} 张表`);
  const dump = { fetched_at: new Date().toISOString(), app_token: BASE, tables: {} };
  for (const t of list) {
    const fields = await listFields(t.table_id);
    const rows = await dumpRows(t.table_id);
    dump.tables[t.table_id] = { name: t.name, fields, rows };
    console.log(`  ${String(rows.length).padStart(5)} 行 | ${String(fields.length).padStart(3)} 字段 | ${t.name}`);
  }
  const file = exportArg ? exportArg.slice('--export='.length) : `/opt/acms/data/pg_migrate_${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(dump));
  console.log(`[导出] 已落盘 ${file}`);
  return { dump, file };
}

// ---------- 导入 + 校验 ----------
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = sortKeys(x[k]);
    return out;
  }
  return x;
}
function stable(v) {
  return JSON.stringify(sortKeys(v));
}
/** 飞书文本字段返回富文本数组，比对前先归一化 */
function toTextLocal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    return v.map((o) => (o && typeof o === 'object' && 'text' in o ? String((o).text) : String(o))).join('');
  }
  if (typeof v === 'object') return JSON.stringify(sortKeys(v));
  return String(v);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
/** 日期字段：飞书给毫秒时间戳，PG 读出来是格式化字符串，比对前统一 */
function fmtDate(v, hasTime) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return v;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return v;
  const base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return hasTime ? `${base} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : base;
}
function normValue(k, v, meta) {
  const m = meta.get(k);
  if (!m) return v;
  if (m.type === 5) {
    return fmtDate(v, /H{1,2}/.test(String(((m.property ?? {})).date_formatter ?? '')));
  }
  if (m.type === 1) return toTextLocal(v);
  return v;
}
async function openStore() {
  if (!DATABASE_URL) throw new Error('缺少 DATABASE_URL');
  const { SqlStore } = await import(new URL('../apps/api/dist/sql-store/sql-store.js', import.meta.url).href);
  return new SqlStore(DATABASE_URL);
}

async function doImport(dump) {
  const store = await openStore();
  try {
    for (const [tid, t] of Object.entries(dump.tables)) {
      await store.ensureTable(tid, t.name, t.fields);
      const n = await store.bulkInsert(tid, t.rows);
      console.log(`  [导入] ${t.name}: ${n}/${t.rows.length}`);
    }
  } finally {
    await store.close();
  }
}

async function verifyAll(dump) {
  const store = await openStore();
  let bad = 0;
  try {
    console.log('\n===== 校验：行数 =====');
    for (const [tid, t] of Object.entries(dump.tables)) {
      const c = await store.count(tid);
      const ok = c === t.rows.length;
      if (!ok) bad++;
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} 飞书 ${t.rows.length} / PG ${c}  ${t.name}`);
    }

    console.log('\n===== 校验：抽样逐字段（每表 5 条）=====');
    for (const [tid, t] of Object.entries(dump.tables)) {
      if (!t.rows.length) continue;
      const sample = t.rows.slice(0, Math.min(5, t.rows.length));
      const meta = new Map((t.fields ?? []).map((f) => [f.name, f]));
      let diff = 0;
      for (const row of sample) {
        const got = await store.get(tid, row.id);
        if (!got) { diff++; console.log(`  FAIL ${t.name} ${row.id}: PG 查不到`); continue; }
        for (const [k, v] of Object.entries(row.fields)) {
          const a = stable(normValue(k, v, meta));
          const b = stable(normValue(k, got.fields[k], meta));
          if (a !== b) {
            diff++;
            console.log(`  DIFF ${t.name} ${row.id} :: ${k}\n       飞书=${a.slice(0, 120)}\n       PG  =${b.slice(0, 120)}`);
          }
        }
      }
      console.log(`  ${diff === 0 ? 'OK  ' : 'DIFF'} ${t.name}: 差异 ${diff} 处`);
      if (diff) bad++;
    }
    console.log(`\n===== 结果：${bad === 0 ? '全部通过' : bad + ' 项异常'} =====`);
    return bad;
  } finally {
    await store.close();
  }
}

const REUSE = (VERIFY_ONLY || argv.includes('--skip-export')) && exportArg;
const { dump, file } = REUSE
  ? { dump: JSON.parse(fs.readFileSync(exportArg.slice('--export='.length), 'utf8')), file: exportArg.slice('--export='.length) }
  : await doExport();

if (VERIFY_ONLY) {
  console.log('[校验模式] 使用导出文件 ' + file);
  process.exit((await verifyAll(dump)) === 0 ? 0 : 1);
}

if (!APPLY) {
  console.log('\n[dry-run] 未写库。加 --apply 执行导入。');
  process.exit(0);
}

await doImport(dump);
process.exit((await verifyAll(dump)) === 0 ? 0 : 1);
