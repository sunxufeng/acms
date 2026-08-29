#!/usr/bin/env node
/**
 * 补录「附件上传失败」的归档邮件。
 *
 * 背景：DI 注入 bug 曾导致所有附件上传失败（this.fileUpload.uploadFile is not a function）。
 * bug 修复后，那些记录因去重（账户+文件夹+UID）不会再被处理，附件仍然缺失。
 *
 * 处理方式：删除这些记录 → 触发同步 → 从邮箱重新拉取并上传附件。
 * 邮箱是数据源，记录可完整重建，故删除无数据丢失风险。
 *
 * 安全：默认 dry-run（只列出不删）；显式传 --confirm 才真正删除。
 *
 * Usage: node scripts/repair_mail_attachments.mjs [/path/to/.env] [--confirm]
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
const CONFIRM = args.includes('--confirm');
const envPath = args.find((a) => !a.startsWith('--')) || '/opt/acms/.env';
loadEnv(envPath);

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;
const ALIAS = 'tblp0P9XVJZSfi3f';

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

const map = process.env.TABLE_ID_MAP ? JSON.parse(process.env.TABLE_ID_MAP) : {};
const TABLE = map[ALIAS] || ALIAS;
const BASE = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}`;

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await res.json();
  if (d.code !== 0) {
    console.error('token failed:', JSON.stringify(d));
    process.exit(1);
  }
  return d.tenant_access_token;
}

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function listAll(token) {
  const out = [];
  let pageToken;
  do {
    const url = `${BASE}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
    const rec = await api(token, 'GET', url);
    if (rec.code !== 0) {
      console.error('LIST_FAILED:', JSON.stringify(rec));
      process.exit(2);
    }
    out.push(...(rec.data?.items ?? []));
    pageToken = rec.data?.page_token;
  } while (pageToken);
  return out;
}

async function main() {
  const token = await getToken();
  const all = await listAll(token);
  const broken = all.filter((it) => String(it.fields['附件失败原因'] ?? '').trim());
  console.log(`归档总记录 ${all.length}，附件失败的 ${broken.length}`);

  if (broken.length === 0) {
    console.log('无需处理。');
    return;
  }

  for (const it of broken) {
    const f = it.fields;
    console.log(`  - [${f['邮件方向'] ?? '?'}] ${String(f['主题'] ?? '').slice(0, 44)} | ${String(f['附件失败原因']).slice(0, 60)}`);
  }

  if (!CONFIRM) {
    console.log('\n(dry-run) 未删除。确认后加 --confirm 执行。');
    return;
  }

  const ids = broken.map((it) => it.record_id);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await api(token, 'POST', `${BASE}/records/batch_delete`, { records: chunk });
    if (r.code !== 0) {
      console.error('DELETE_FAILED:', JSON.stringify(r));
      process.exit(3);
    }
    deleted += chunk.length;
    console.log(`  已删除 ${deleted}/${ids.length}`);
  }
  console.log(`\n删除完成（${deleted} 条）。请触发同步以重新拉取并上传附件。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
