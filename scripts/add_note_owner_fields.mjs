#!/usr/bin/env node
/**
 * 给「知识库配置」与「笔记配置映射」两张表加归属人字段。
 *
 * Usage (on server):
 *   node scripts/add_note_owner_fields.mjs [/path/to/.env]
 *
 * Idempotent: 先列出目标表现有字段，已存在的跳过，只补缺失的。
 *
 * 为什么要加：
 *   「知识库配置」表原本没有归属概念 —— GETNOTE_SOURCE_META 无 ownerField，
 *   通用 CRUD 的 list 只校验 getnote:read 权限点、不做行级过滤，
 *   于是**任何有权限的人都能看到所有人的配置行**（凭证字段虽置空，配置名却全裸）。
 *   2026-09-07 加「配置名称」列后这个问题变得可见：筛选下拉会把别人的配置名也列出来。
 *
 *   同理，「笔记配置映射」表也是全局的（listConfigMap 里原本 void user）。
 *
 * 字段设计：为什么是两个而不是一个
 *   归属人    姓名 —— 列表要给人看
 *   归属人ID  openId —— 精确过滤用；姓名会重名，拿姓名做权限判定必出事
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

/** 待加字段：type=1 文本 */
const OWNER_FIELDS = [
  { field_name: '归属人', type: 1 },
  { field_name: '归属人ID', type: 1 },
];

const TARGETS = [
  { key: '知识库配置', tableId: 'tblmKQtZ5IOgyhv6' },
  { key: '笔记配置映射', tableId: 'tbleFsIxXwZckVB8' },
];

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
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields?page_size=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`listFields(${tableId}) failed:`, JSON.stringify(data));
    process.exit(1);
  }
  return (data.data?.items ?? []).map((f) => f.field_name);
}

async function addField(token, tableId, field) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(field),
  });
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`  addField ${field.field_name} failed:`, JSON.stringify(data));
    return false;
  }
  console.log(`  + ${field.field_name} (field_id=${data.data?.field_id})`);
  return true;
}

async function main() {
  const token = await getToken();
  console.log('开始加归属人字段\n');

  let allOk = true;
  for (const t of TARGETS) {
    console.log(`[${t.key}] ${t.tableId}`);
    const existing = new Set(await listFields(token, t.tableId));
    console.log(`  现有字段(${existing.size}): ${[...existing].join(' / ')}`);
    for (const f of OWNER_FIELDS) {
      if (existing.has(f.field_name)) {
        console.log(`  = ${f.field_name} 已存在，跳过`);
        continue;
      }
      if (!(await addField(token, t.tableId, f))) allOk = false;
    }
    // 回读确认
    const after = new Set(await listFields(token, t.tableId));
    const missing = OWNER_FIELDS.filter((f) => !after.has(f.field_name)).map((f) => f.field_name);
    console.log(missing.length ? `  ✗ 仍缺失: ${missing.join(',')}` : '  ✓ 两个字段齐了');
    if (missing.length) allOk = false;
    console.log('');
  }

  console.log(allOk ? 'ALL_FIELDS_OK' : 'SOME_FIELDS_FAILED');
  if (!allOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
