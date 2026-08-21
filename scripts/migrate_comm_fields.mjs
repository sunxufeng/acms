// 一次性迁移脚本：家校沟通 / 日常跟进 字段调整（幂等）。
//  - 沟通内容 → 沟通人备注（重命名，数据保留）
//  - 沟通时间 启用「显示时间」(HH:mm)
//  - 新建 沟通时长(分钟)（type=2 数值）
// 直接调用飞书 OpenAPI（不依赖 base-adapter 模块格式）。
import fs from 'fs';

const ENV = {};
for (const line of fs.readFileSync('/opt/acms/.env', 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const APP_ID = ENV.FEISHU_APP_ID;
const APP_SECRET = ENV.FEISHU_APP_SECRET;
const BASE_TOKEN = ENV.FEISHU_BASE_TOKEN;
const API = 'https://open.feishu.cn';

const TABLES = {
  'home-school-comms': 'tbl8Isr46G3BRQ52',
  'daily-followups': 'tbljjbChYx9uhbbb',
};

let TOKEN = '';
async function getToken() {
  if (TOKEN) return TOKEN;
  const r = await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await r.json();
  if (d.code !== 0 || !d.tenant_access_token) throw new Error('token error ' + JSON.stringify(d));
  TOKEN = d.tenant_access_token;
  return TOKEN;
}

async function api(method, path, body) {
  const token = await getToken();
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`${method} ${path} -> ${d.code}: ${d.msg}`);
  return d.data;
}

async function listFields(tableId) {
  const out = [];
  let pageToken;
  do {
    const p = `${API}/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
    const d = await api('GET', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`);
    for (const f of d.items ?? []) out.push({ id: f.field_id, name: f.field_name, type: f.type, property: f.property ?? {} });
    pageToken = d.has_more ? d.page_token : undefined;
  } while (pageToken);
  return out;
}

async function migrate(label, tableId) {
  const fields = await listFields(tableId);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const log = [];

  // 1) 沟通内容 → 沟通人备注
  const old = byName.get('沟通内容');
  if (old && !byName.has('沟通人备注')) {
    await api('PUT', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields/${old.id}`, {
      field_name: '沟通人备注', type: 1, property: old.property || {},
    });
    log.push('renamed 沟通内容 → 沟通人备注');
  } else if (byName.has('沟通人备注')) {
    log.push('沟通人备注 已存在，跳过');
  } else if (!old) {
    await api('POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`, {
      field_name: '沟通人备注', type: 1,
    });
    log.push('未找到 沟通内容，已新建 沟通人备注');
  }

  // 2) 沟通时间 启用时分
  const t = byName.get('沟通时间');
  if (t && t.type === 5) {
    const fmt = (t.property && t.property.date_formatter) || '';
    if (!/H{1,2}/.test(fmt)) {
      await api('PUT', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields/${t.id}`, {
        field_name: '沟通时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' },
      });
      log.push('沟通时间 已启用时分 (HH:mm)');
    } else {
      log.push('沟通时间 已带时分，跳过');
    }
  }

  // 3) 沟通时长(分钟) 数值字段
  if (!byName.has('沟通时长(分钟)')) {
    await api('POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`, {
      field_name: '沟通时长(分钟)', type: 2,
    });
    log.push('已新建 沟通时长(分钟)');
  } else {
    log.push('沟通时长(分钟) 已存在，跳过');
  }

  console.log(`[${label}]`, JSON.stringify(log, null, 2));
}

(async () => {
  for (const [label, tableId] of Object.entries(TABLES)) {
    await migrate(label, tableId);
  }
  console.log('MIGRATION DONE');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
