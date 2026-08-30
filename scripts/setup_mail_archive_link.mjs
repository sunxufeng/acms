#!/usr/bin/env node
/**
 * 幂等补齐「邮件归档」表的「关联学生」字段（单向关联 → 学生档案表，可多选）。
 *
 * 关联字段 type = 18（飞书单向关联），property = { multiple: true, table_id: <学生档案表ID> }。
 * 读写均按 [{ record_id }] 格式；读取时飞书会额外返回 text（被关联记录标题 = 学生姓名），UI 可直接显示。
 *
 * 用法（在服务器上执行，读 /opt/acms/.env）：
 *   node scripts/setup_mail_archive_link.mjs [/path/to/.env]
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
function resolveTableId(alias) {
  const raw = process.env.TABLE_ID_MAP;
  if (!raw) return alias;
  try {
    const map = JSON.parse(raw);
    const real = map[alias];
    if (real) {
      console.log(`  (TABLE_ID_MAP) ${alias} -> ${real}`);
      return real;
    }
  } catch {
    /* 映射解析失败则按原样使用 */
  }
  return alias;
}

const ARCHIVE_TABLE = resolveTableId(process.env.MAIL_ARCHIVE_TABLE_ID || 'tblp0P9XVJZSfi3f');
const STUDENT_TABLE = resolveTableId('tblyFIfe58IjxT4K'); // 学生档案表（contracts 别名）

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

async function listFields(token, tableId) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields?page_size=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`LIST_FIELDS_FAILED(${tableId}):`, JSON.stringify(data));
    process.exit(2);
  }
  const arr = Array.isArray(data.data) ? data.data : data.data?.items ?? [];
  return arr.map((f) => ({ name: f.field_name, type: f.type, id: f.field_id }));
}

async function addField(token, tableId, field) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(field),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`ADD_FIELD_FAILED (${field.field_name}):`, JSON.stringify(data));
    process.exit(1);
  }
  console.log(`  + Added: ${field.field_name} (type=${data.data?.type ?? '?'}, field_id=${data.data?.field_id ?? '?'})`);
}

async function deleteField(token, tableId, fieldId) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields/${fieldId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`DELETE_FIELD_FAILED (${fieldId}):`, JSON.stringify(data));
    process.exit(1);
  }
  console.log(`  - Deleted old field: ${fieldId}`);
}

async function main() {
  const token = await getToken();
  console.log(`\n=== 邮件归档表 ${ARCHIVE_TABLE} ===`);
  const existing = await listFields(token, ARCHIVE_TABLE);
  const byName = new Map(existing.map((f) => [f.name, f]));
  const fieldName = '关联学生';
  const cur = byName.get(fieldName);
  if (cur !== undefined && cur.type === 18) {
    console.log(`  = Skip (exists, type=18 关联): ${fieldName}`);
  } else {
    if (cur !== undefined) {
      console.log(`  ! 已存在但类型=${cur.type}(非关联)，先删除再重建为关联字段（字段为空，无数据丢失）`);
      await deleteField(token, ARCHIVE_TABLE, cur.id);
    }
    console.log(`  关联目标学生档案表: ${STUDENT_TABLE}`);
    await addField(token, ARCHIVE_TABLE, {
      field_name: fieldName,
      type: 18, // 18 = 单向关联
      property: { multiple: true, table_id: STUDENT_TABLE },
    });
  }
  const after = await listFields(token, ARCHIVE_TABLE);
  console.log(`  Fields(${after.length}):`, after.map((f) => `${f.name}:${f.type}`).join(', '));
  console.log('\nDONE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
