// 一次性迁移脚本：招生跟进（sourceFollowup / tblDEuaTDoiXkjZu）字段调整（幂等）。
//  - 跟进日期 → 跟进时间（重命名并启用「显示时间」HH:mm）
//  - 新建文本字段：关联学生 / 家长 / 沟通主题 / 沟通明细 / 沟通总结 / 沟通附件清单
//  - 新建单选字段：家长反馈态度（字典选项）
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
const TABLE = 'tblDEuaTDoiXkjZu';

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

async function listFields() {
  const out = [];
  let pageToken;
  do {
    const d = await api('GET', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`);
    for (const f of d.items ?? []) out.push({ id: f.field_id, name: f.field_name, type: f.type, property: f.property ?? {} });
    pageToken = d.has_more ? d.page_token : undefined;
  } while (pageToken);
  return out;
}

(async () => {
  const fields = await listFields();
  const byName = new Map(fields.map((f) => [f.name, f]));
  const log = [];

  // 1) 跟进日期 → 跟进时间（启用时分）
  const oldDate = byName.get('跟进日期');
  const newTime = byName.get('跟进时间');
  if (newTime && newTime.type === 5) {
    const fmt = (newTime.property && newTime.property.date_formatter) || '';
    if (!/H{1,2}/.test(fmt)) {
      await api('PUT', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields/${newTime.id}`, {
        field_name: '跟进时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' },
      });
      log.push('跟进时间 已启用时分 (HH:mm)');
    } else log.push('跟进时间 已带时分，跳过');
  } else if (oldDate && oldDate.type === 5) {
    await api('PUT', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields/${oldDate.id}`, {
      field_name: '跟进时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' },
    });
    log.push('跟进日期 → 跟进时间（已重命名并启用时分）');
  } else if (!newTime) {
    await api('POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields`, {
      field_name: '跟进时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' },
    });
    log.push('跟进时间（已新建日期时间字段）');
  }

  // 2) 文本字段
  for (const name of ['关联学生', '家长', '沟通主题', '沟通明细', '沟通总结', '沟通附件清单']) {
    if (!byName.has(name)) {
      await api('POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields`, { field_name: name, type: 1 });
      log.push(`已新建文本字段 ${name}`);
    } else log.push(`${name} 已存在，跳过`);
  }

  // 3) 家长反馈态度（单选）
  if (!byName.has('家长反馈态度')) {
    const options = ['认可', '基本认可', '有异议', '待回复'].map((name) => ({ name }));
    await api('POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields`, {
      field_name: '家长反馈态度', type: 3, property: { options },
    });
    log.push('已新建单选字段 家长反馈态度');
  } else log.push('家长反馈态度 已存在，跳过');

  console.log('SOURCE_FOLLOWUP_MIGRATION', JSON.stringify(log, null, 2));
  console.log('MIGRATION DONE');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
