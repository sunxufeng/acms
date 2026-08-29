#!/usr/bin/env node
/**
 * 把归档表里「邮件UID」的历史值从 IMAP 序号改写为真实 UID。
 *
 * 背景：旧代码 client.search({}) 未传 { uid: true }，返回的是 1..N 的序号而非 UID。
 * 序号会随邮件删除整体前移，不能作为去重键。修复代码后若不做迁移，
 * 下次同步会因为 (账户, 文件夹, 邮件UID) 三条键全部对不上，把已有邮件整批重复归档一遍。
 *
 * 迁移方式：连上邮箱取真实 UID 列表（升序），序号 N 对应 uidList[N-1]，
 * 就地更新「邮件UID」字段 —— 不删记录、不重新下载附件。
 *
 * 安全：默认 dry-run；显式 --confirm 才写入；序号越界的记录会跳过并告警。
 *
 * Usage: node scripts/migrate_mail_uid.cjs [/path/to/.env] [--confirm]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const envPath = args.find((a) => !a.startsWith('--')) || '/opt/acms/.env';

function loadEnv(p) {
  if (!p || !fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(envPath);

const ACMS_DIR = process.env.ACMS_DIR || '/opt/acms';
const APP_DIR = path.join(ACMS_DIR, 'repo/apps/api');
const crypto = require(path.join(APP_DIR, 'dist/mail-archive/crypto.js'));
const { ImapFlow } = require(path.join(APP_DIR, 'node_modules/imapflow'));

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;
if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}
const map = process.env.TABLE_ID_MAP ? JSON.parse(process.env.TABLE_ID_MAP) : {};
const ACC_T = map['tbl1hfl00NnE53aq'] || 'tbl1hfl00NnE53aq';
const ARC_T = map['tblp0P9XVJZSfi3f'] || 'tblp0P9XVJZSfi3f';
const API = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`;

async function token() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('token failed: ' + JSON.stringify(j));
  return j.tenant_access_token;
}

async function api(t, method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function listAll(t, table) {
  const out = [];
  let pageToken;
  do {
    const rec = await api(t, 'GET', `${API}/${table}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`);
    if (rec.code !== 0) throw new Error('LIST_FAILED: ' + JSON.stringify(rec));
    out.push(...(rec.data?.items ?? []));
    pageToken = rec.data?.page_token;
  } while (pageToken);
  return out;
}

async function main() {
  const t = await token();
  const accounts = await listAll(t, ACC_T);
  const archives = await listAll(t, ARC_T);
  console.log(`账户 ${accounts.length} 个，归档记录 ${archives.length} 条`);

  let totalUpdate = 0;
  const updates = []; // {record_id, uid}

  for (const acc of accounts) {
    const f = acc.fields;
    const accName = String(f['账户名称'] ?? '');
    const mine = archives.filter((r) => String(r.fields['归属账户'] ?? '') === accName);
    if (mine.length === 0) continue;

    const pass = crypto.decryptCredential(String(f['密码'] ?? ''));
    if (!pass) {
      console.log(`\n账户 ${accName}：密码解密失败，跳过`);
      continue;
    }

    const folders = [...new Set(mine.map((r) => String(r.fields['邮箱文件夹'] ?? '')))].filter(Boolean);
    console.log(`\n账户 ${accName}（${f['邮箱地址']}）待处理 ${mine.length} 条，涉及文件夹：${folders.join(', ')}`);

    const client = new ImapFlow({
      host: String(f['IMAP服务器']),
      port: Number(f['IMAP端口']) || 993,
      secure: String(f['使用SSL'] ?? '是') !== '否',
      auth: { user: String(f['用户名'] || f['邮箱地址']), pass },
      logger: false,
    });
    await client.connect();

    try {
      for (const folder of folders) {
        let lock;
        try {
          lock = await client.getMailboxLock(folder);
        } catch (e) {
          console.log(`  [${folder}] 打不开：${e.message}`);
          continue;
        }
        try {
          const uidList = (await client.search({}, { uid: true })) || [];
          const rows = mine.filter((r) => String(r.fields['邮箱文件夹'] ?? '') === folder);
          console.log(`  [${folder}] 邮箱 ${uidList.length} 封，归档 ${rows.length} 条，uidValidity=${client.mailbox.uidValidity}`);

          let changed = 0;
          let skipped = 0;
          for (const r of rows) {
            const raw = String(r.fields['邮件UID'] ?? '').trim();
            const seq = Number(raw);
            if (!Number.isInteger(seq) || seq < 1 || seq > uidList.length) {
              console.log(`    ! 跳过（序号越界或非数字）: 记录 ${r.record_id} 邮件UID=${raw}`);
              skipped++;
              continue;
            }
            const newUid = String(uidList[seq - 1]);
            if (newUid === raw) continue; // 已是 UID
            updates.push({ record_id: r.record_id, uid: newUid });
            changed++;
          }
          console.log(`    待改写 ${changed} 条，跳过 ${skipped} 条`);
          totalUpdate += changed;
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout();
    }
  }

  console.log(`\n合计待改写 ${totalUpdate} 条`);
  if (!CONFIRM) {
    console.log('(dry-run) 未写入。确认后加 --confirm 执行。');
    return;
  }
  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50);
    const r = await api(t, 'POST', `${API}/${ARC_T}/records/batch_update`, {
      records: chunk.map((u) => ({ record_id: u.record_id, fields: { 邮件UID: u.uid } })),
    });
    if (r.code !== 0) {
      console.error('UPDATE_FAILED:', JSON.stringify(r));
      process.exit(3);
    }
    console.log(`  已更新 ${Math.min(i + 50, updates.length)}/${updates.length}`);
  }
  console.log('迁移完成。');
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
