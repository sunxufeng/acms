#!/usr/bin/env node
/**
 * 把「邮件账户」表的「最后收取时间」字段从纯日期（yyyy/MM/dd）改为带时间（yyyy/MM/dd HH:mm）。
 *
 * 为什么必须改：该字段只有日期精度时，写入的毫秒时间戳会被截断到当天 00:00，
 * 于是 syncAll 的节流判断 `Date.now() - last < intervalMs` 对任何短于一天的频率都恒为 true
 * —— 「每小时」「每15分钟」等配置**依然会失效**，等于上一个 bug 只修了一半。
 * 当前 3 个账户都配的「每天」所以看不出来，但一改频率就会复发。
 *
 * 变更性质：**无损**。只改展示/存储精度，不动任何已有数据（时间戳本身不变）。
 *
 * Usage:
 *   node scripts/fix_last_sync_time_field.mjs                  # dry-run（默认）
 *   node scripts/fix_last_sync_time_field.mjs --apply          # 真改
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const envPath = args.find((a) => a.startsWith('--env='))?.split('=')[1] || '/opt/acms/.env';

for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;
if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

let MAP = {};
try { MAP = JSON.parse(process.env.TABLE_ID_MAP || '{}'); } catch {}
// contracts 里的 dev ID → 生产 ID（直接用 dev ID 查生产会报 1254041）
const DEV_ACC = 'tbl1hfl00NnE53aq';
const TABLE = MAP[DEV_ACC] || DEV_ACC;
const FIELD = '最后收取时间';
const WANT = 'yyyy/MM/dd HH:mm';

const tokR = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
});
const tokJ = await tokR.json();
if (tokJ.code !== 0) { console.error('TOKEN_FAILED', tokJ); process.exit(1); }
const token = tokJ.tenant_access_token;

const fr = await fetch(
  `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields?page_size=100`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const fj = await fr.json();
if (fj.code !== 0) { console.error('READ_FIELDS_FAILED', fj.code, fj.msg); process.exit(1); }

const target = fj.data.items.find((f) => f.field_name === FIELD);
if (!target) { console.error(`未找到字段「${FIELD}」`); process.exit(1); }

const cur = target.property?.date_formatter;
console.log(`字段「${FIELD}」 field_id=${target.field_id} 当前格式=${cur} 目标=${WANT}`);

if (cur === WANT) {
  console.log('已经是带时间格式，无需修改（幂等退出）。');
  process.exit(0);
}

if (!APPLY) {
  console.log('[dry-run] 未修改。确认后加 --apply 执行。');
  process.exit(0);
}

const ur = await fetch(
  `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields/${target.field_id}`,
  {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // ⚠️ type=5 的 property 只有 date_formatter 与 auto_fill，这里两个都显式带上，
    // 避免漏传导致属性被重置。
    body: JSON.stringify({
      field_name: FIELD,
      type: 5,
      property: { date_formatter: WANT, auto_fill: target.property?.auto_fill ?? false },
    }),
  },
);
const uj = await ur.json();
if (uj.code !== 0) { console.error('UPDATE_FAILED', uj.code, uj.msg); process.exit(1); }
console.log(`修改成功：${cur} → ${uj.data?.property?.date_formatter}`);

// 回读校验：⚠️ 飞书**没有**「按 field_id 查单个字段」的接口，GET /fields/:field_id
// 会返回 `404 page not found`（还不是 JSON，JSON.parse 会直接抛）。只能用列表接口回读。
const vr = await fetch(
  `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields?page_size=100`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const vj = await vr.json();
const after = (vj.data?.items ?? []).find((f) => f.field_name === FIELD);
console.log(`[verify] 回读格式 = ${after?.property?.date_formatter}`);
console.log(after?.property?.date_formatter === WANT ? '✅ verify 通过' : '⚠️ verify 未通过');
