#!/usr/bin/env node
/**
 * 幂等补齐「邮件归档」改造所需字段。
 *
 * 邮件账户表 tbl1hfl00NnE53aq：
 *   - 发件箱文件夹（文本）：手工指定发件箱 IMAP 路径，留空则自动探测。
 *
 * 邮件归档表 tblp0P9XVJZSfi3f：
 *   - 邮件方向（单选 收件/发件）：用于页面上区分收件箱与发件箱。
 *   - 文件附件（附件）：把附件的 file_token 挂到原生附件字段，
 *     使其具备 bitablePerm 归属 —— 否则下载只能依赖上传后 20h 过期的 Redis 缓存。
 *   - 附件失败原因（文本）：上传失败的附件不再静默丢弃，页面上可见。
 *
 * 用法（在服务器上执行，读 /opt/acms/.env）：
 *   node scripts/setup_mail_archive_fields.mjs [/path/to/.env]
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
// 生产环境经 TABLE_ID_MAP 把代码里的别名重映射为真实表 ID（与运行时一致），
// 直接用 contracts 里的别名会报 TableIdNotFound，故这里也按同一映射解析。
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

const ACCOUNT_TABLE = resolveTableId(process.env.MAIL_ACCOUNT_TABLE_ID || 'tbl1hfl00NnE53aq');
const ARCHIVE_TABLE = resolveTableId(process.env.MAIL_ARCHIVE_TABLE_ID || 'tblp0P9XVJZSfi3f');

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
  return arr.map((f) => ({ name: f.field_name, type: f.type }));
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
  console.log(`  + Added: ${field.field_name} (type=${data.data?.type ?? '?'})`);
}

const PLANS = [
  {
    tableId: ACCOUNT_TABLE,
    label: '邮件账户表',
    fields: [{ field_name: '发件箱文件夹', type: 1 }],
  },
  {
    tableId: ARCHIVE_TABLE,
    label: '邮件归档表',
    fields: [
      {
        field_name: '邮件方向',
        type: 3,
        property: { options: [{ name: '收件' }, { name: '发件' }] },
      },
      { field_name: '文件附件', type: 17 }, // 17 = 附件
      { field_name: '附件失败原因', type: 1 },
    ],
  },
];

async function main() {
  const token = await getToken();
  for (const plan of PLANS) {
    console.log(`\n=== ${plan.label} ${plan.tableId} ===`);
    const existing = await listFields(token, plan.tableId);
    const byName = new Map(existing.map((f) => [f.name, f.type]));
    for (const f of plan.fields) {
      const cur = byName.get(f.field_name);
      if (cur !== undefined) {
        console.log(`  = Skip (exists, type=${cur}): ${f.field_name}`);
      } else {
        await addField(token, plan.tableId, f);
      }
    }
    const after = await listFields(token, plan.tableId);
    console.log(`  Fields(${after.length}):`, after.map((f) => `${f.name}:${f.type}`).join(', '));
  }
  console.log('\nDONE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
