#!/usr/bin/env node
/**
 * 幂等地把微信小程序凭证的两条配置键种入「系统配置表」，方便管理员在
 * 「后台管理 → 系统设置」里直接填入 AppID / Secret（值留空，由管理员填写）。
 * 用法：node scripts/seed_wechat_config.mjs [/path/to/.env]
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
const TABLE_ID = process.env.SYSCONFIG_TABLE_ID || 'tblqeuKQlsuOIeUy';

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

async function listKeys(token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error('LIST_RECORDS_FAILED:', JSON.stringify(data));
    process.exit(2);
  }
  const items = Array.isArray(data.data) ? data.data : data.data?.items ?? [];
  return items.map((r) => toText(r.fields?.['配置键']));
}

function toText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x?.text ?? x)).join(',');
  if (typeof v === 'object') return v.text ?? '';
  return String(v);
}

async function addKey(token, key) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        fields: {
          配置键: key,
          配置值: '',
          分组: '微信小程序',
          状态: '启用',
        },
      }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) {
    console.error(`ADD_KEY_FAILED (${key}):`, JSON.stringify(data));
    process.exit(1);
  }
  console.log(`Seeded key: ${key}`);
}

async function main() {
  const token = await getToken();
  const existing = await listKeys(token);
  console.log('Existing config keys:', JSON.stringify(existing));
  for (const key of ['wechat_mini_appid', 'wechat_mini_secret']) {
    if (existing.includes(key)) {
      console.log(`Skip (exists): ${key}`);
    } else {
      await addKey(token, key);
    }
  }
  console.log('DONE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
