#!/usr/bin/env node
/**
 * 创建「邮件账户表」与「邮件归档表」两张飞书 Base 表（邮件自动归档功能用）。
 * 幂等：若同名表已存在则跳过创建并复用已有 tableId。
 * Usage: node scripts/create_mail_tables.mjs [/path/to/.env]
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

const envPath = process.argv[2] || '.env';
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

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function listTables(token) {
  const data = await api(token, 'GET', `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables?page_size=100`);
  return data.data?.items ?? [];
}

async function findTable(token, name) {
  const tables = await listTables(token);
  return tables.find((t) => t.name === name);
}

async function createTable(token, name, fields) {
  const existing = await findTable(token, name);
  if (existing) {
    console.error(`表「${name}」已存在，复用 tableId=${existing.table_id}`);
    return { tableId: existing.table_id, name: existing.name, existed: true };
  }
  const data = await api(token, 'POST', `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`, { table: { name, fields } });
  if (data.code !== 0) {
    console.error(`createTable(${name}) failed:`, JSON.stringify(data));
    process.exit(1);
  }
  return { tableId: data.data.table_id, name: data.data.name ?? name, existed: false };
}

// 单选字段（type=3）
const single = (field_name, options) => ({ field_name, type: 3, property: { options: options.map((o) => ({ name: o })) } });

const MAIL_ACCOUNT_FIELDS = [
  { field_name: '账户名称', type: 1 },
  { field_name: '邮箱地址', type: 1 },
  { field_name: 'IMAP服务器', type: 1 },
  { field_name: 'IMAP端口', type: 2 },
  single('使用SSL', ['是', '否']),
  { field_name: '用户名', type: 1 },
  { field_name: '密码', type: 1 },
  { field_name: '归属人员', type: 1 },
  single('收取频率', ['每15分钟', '每30分钟', '每小时', '每天']),
  { field_name: '过滤规则', type: 1 },
  single('启用', ['启用', '停用']),
  { field_name: '最后收取时间', type: 5 },
  { field_name: '最后收取结果', type: 1 },
];

const MAIL_ARCHIVE_FIELDS = [
  { field_name: '邮件UID', type: 1 },
  { field_name: '归属账户', type: 1 },
  { field_name: '邮箱文件夹', type: 1 },
  { field_name: '发件人', type: 1 },
  { field_name: '收件人', type: 1 },
  { field_name: '抄送', type: 1 },
  { field_name: '主题', type: 1 },
  { field_name: '正文', type: 1 },
  { field_name: '发送时间', type: 5 },
  { field_name: '收取时间', type: 5 },
  { field_name: '附件数', type: 2 },
  { field_name: '附件信息', type: 1 },
  { field_name: '关联学生', type: 1 },
  single('是否已读', ['是', '否']),
];

async function main() {
  const token = await getToken();
  const account = await createTable(token, '邮件账户表', MAIL_ACCOUNT_FIELDS);
  const archive = await createTable(token, '邮件归档表', MAIL_ARCHIVE_FIELDS);
  console.log('MAIL_ACCOUNT_TABLE_ID=' + account.tableId);
  console.log('MAIL_ARCHIVE_TABLE_ID=' + archive.tableId);
  console.log('---');
  console.log(`  mailAccount: { tableId: '${account.tableId}', name: '邮件账户表' },`);
  console.log(`  mailArchive: { tableId: '${archive.tableId}', name: '邮件归档表' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
