#!/usr/bin/env node
/**
 * 给「知识库配置」表加「关联用户」字段（多用户关联）。
 *
 * ⚠️ **只在飞书模式下需要这个脚本**。生产 `SQL_TABLES=*`，所有表都路由到
 *    PostgreSQL，字段元数据真源是 `acms_fields` ⇒ 生产应执行
 *    `scripts/sql/note-linked-users.sql`（含字段 + 存量回填）。
 *    对生产跑本脚本只会改到飞书镜像，接口读到的仍然是 PG（2026-09-17 实测）。
 *
 * Usage (on server):
 *   node scripts/add_note_linked_users_field.mjs [/path/to/.env]
 *
 * Idempotent: 先列出目标表现有字段，已存在则跳过。
 *
 * 为什么要加（2026-09-17 峰哥要求）：
 *   「知识库配置」原本是**单人归属**（2026-09-07 加的「归属人/归属人ID」），
 *   一条配置只能属于一个人。实际场景里需要「一个账号的配置被多人共同维护」，
 *   所以照**邮件账户设置**的范式改成多用户关联：
 *   一条配置可关联多个用户，被关联的人都能看到它、以及它对应的笔记；
 *   系统管理员看全部。
 *
 * 字段设计：
 *   关联用户  单向关联(type=18) → 系统用户表。存 **record id 数组**，
 *            不是姓名也不是 openId —— 姓名会重名，openId 跨应用不一致。
 *
 * ⚠️ 旧的「归属人/归属人ID」**不删不改**：可见性判据（source-cred.ts 的
 *    `sourceVisibleTo`）把它作为**存量兼容**分支保留，
 *    即「关联用户含我 **或** 归属人ID === 我」都可见。
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

/**
 * 🔴 表 ID 必须按 `TABLE_ID_MAP` 转换后再用。
 * 代码内登记的是 **DEV Base** 的 id，生产 Base 的表 id 不同
 * （2026-09-17 踩坑：不转换时用户表用代码 id 去加关联字段，
 *  飞书报 `1254089 LinkFieldPropertyError` —— 因为它报的是「属性不合法」，
 *  真实原因却是**目标表 id 在这个 Base 下不存在**，误导性极强）。
 */
const ID_MAP = (() => {
  try {
    return JSON.parse(process.env.TABLE_ID_MAP ?? '{}');
  } catch {
    return {};
  }
})();
const realId = (id) => ID_MAP[id] ?? id;

/** 知识库配置表（逻辑 id；生产未映射，即同一 id） */
const SOURCE_TABLE = realId('tblmKQtZ5IOgyhv6');
/** 系统用户表（关联目标）。逻辑 id tblnFCIRBOZr2oVF → 生产 tblTV6VAO5x2967y */
const USER_TABLE = realId('tblnFCIRBOZr2oVF');

/** 待加字段：type=18 单向关联，property.table_id 指向用户表 */
const FIELD = {
  field_name: '关联用户',
  type: 18,
  // ⚠️ `multiple: true` 不可省 —— 只写 table_id 会被飞书拒为
  // `1254089 LinkFieldPropertyError`（2026-09-17 实测）。
  // 照既有可用脚本 scripts/setup_mail_archive_link.mjs 的写法。
  property: { multiple: true, table_id: USER_TABLE },
};

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

async function main() {
  const token = await getToken();
  console.log('给「知识库配置」加「关联用户」字段\n');

  const before = new Set(await listFields(token, SOURCE_TABLE));
  console.log(`  现有字段(${before.size}): ${[...before].join(' / ')}`);

  if (before.has(FIELD.field_name)) {
    console.log(`  = ${FIELD.field_name} 已存在，跳过`);
  } else {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${SOURCE_TABLE}/fields`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(FIELD),
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.error(`  addField 失败:`, JSON.stringify(data));
      process.exit(1);
    }
    console.log(`  + ${FIELD.field_name} (field_id=${data.data?.field_id})`);
  }

  const after = new Set(await listFields(token, SOURCE_TABLE));
  console.log(after.has(FIELD.field_name) ? '  ✓ 字段已就位' : '  ✗ 仍缺失');
  console.log(after.has(FIELD.field_name) ? 'FIELD_OK' : 'FIELD_FAILED');
  if (!after.has(FIELD.field_name)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
