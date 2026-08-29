#!/usr/bin/env node
/**
 * 重建「邮件归档表」。
 *
 * 原因：现存归档表有 6 个字段类型建错（发件人=数字、收件人=单选、发送时间=单选、
 * 收取时间=文本、附件数=单选、附件信息=日期），导致往里写邮件时 base.create 直接失败，
 * 一封都归档不进去 —— 这是「没有附件 / 没有发件箱 / 分不清收发」的共同根因。
 *
 * 本脚本：校验旧表为空 → 删除 → 按精确字段重建（17 个字段，含本次新增的 4 个）
 * → 打印新 tableId 与更新后的 TABLE_ID_MAP，供写回 /opt/acms/.env。
 *
 * Usage: node scripts/recreate_mail_archive_table.mjs [/path/to/.env] [--force]
 *        --force 表示即使旧表非空也重建（当前表为空，正常情况下不需要）。
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

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const envPath = args.find((a) => !a.startsWith('--')) || '/opt/acms/.env';
loadEnv(envPath);

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;
const ALIAS = 'tblp0P9XVJZSfi3f'; // contracts 里登记的代码表 ID

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

const map = process.env.TABLE_ID_MAP ? JSON.parse(process.env.TABLE_ID_MAP) : {};
const OLD_TABLE = map[ALIAS] || ALIAS;

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

const FIELDS = [
  { field_name: '邮件UID', type: 1 },
  { field_name: '归属账户', type: 1 },
  { field_name: '邮箱文件夹', type: 1 },
  { field_name: '邮件方向', type: 3, property: { options: [{ name: '收件' }, { name: '发件' }] } },
  { field_name: '发件人', type: 1 },
  { field_name: '收件人', type: 1 },
  { field_name: '抄送', type: 1 },
  { field_name: '主题', type: 1 },
  { field_name: '正文', type: 1 },
  { field_name: '发送时间', type: 5 },
  { field_name: '收取时间', type: 5 },
  { field_name: '附件数', type: 2 },
  { field_name: '附件信息', type: 1 },
  { field_name: '文件附件', type: 17 },
  { field_name: '附件失败原因', type: 1 },
  { field_name: '关联学生', type: 1 },
  { field_name: '是否已读', type: 3, property: { options: [{ name: '是' }, { name: '否' }] } },
];

async function main() {
  const token = await getToken();
  const rec = await api(
    token,
    'GET',
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${OLD_TABLE}/records?page_size=1`,
  );
  if (rec.code !== 0) {
    console.error(`读取旧表失败 (${OLD_TABLE}):`, JSON.stringify(rec));
    process.exit(1);
  }
  const total = rec.data?.total ?? 0;
  console.log(`旧表 ${OLD_TABLE} 记录数 = ${total}`);
  if (total > 0 && !FORCE) {
    console.error('旧表非空，拒绝重建。确认要丢弃数据请加 --force。');
    process.exit(1);
  }

  const del = await api(
    token,
    'DELETE',
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${OLD_TABLE}`,
  );
  if (del.code !== 0) {
    console.error('deleteTable failed:', JSON.stringify(del));
    process.exit(1);
  }
  console.log(`已删除旧表 ${OLD_TABLE}`);

  const crt = await api(
    token,
    'POST',
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`,
    { table: { name: '邮件归档表', fields: FIELDS } },
  );
  if (crt.code !== 0) {
    console.error('createTable failed:', JSON.stringify(crt));
    process.exit(1);
  }
  const newId = crt.data.table_id;

  const updated = { ...map, [ALIAS]: newId };
  console.log('---');
  console.log('NEW_MAIL_ARCHIVE_TABLE_ID=' + newId);
  console.log('--- 更新后的 TABLE_ID_MAP（写回 .env）---');
  console.log('TABLE_ID_MAP=' + JSON.stringify(updated));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
