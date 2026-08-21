import fs from 'fs';
const ENV = {};
for (const line of fs.readFileSync('/opt/acms/.env', 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const APP_ID = ENV.FEISHU_APP_ID, APP_SECRET = ENV.FEISHU_APP_SECRET, BASE_TOKEN = ENV.FEISHU_BASE_TOKEN;
const API = 'https://open.feishu.cn';
const TABLE = 'tblDEuaTDoiXkjZu';
let TOKEN = '';
async function getToken() {
  if (TOKEN) return TOKEN;
  const r = await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }) });
  const d = await r.json();
  if (d.code !== 0 || !d.tenant_access_token) throw new Error('token error ' + JSON.stringify(d));
  TOKEN = d.tenant_access_token; return TOKEN;
}
async function api(method, path, body) {
  const token = await getToken();
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`${method} ${path} -> ${d.code}: ${d.msg}`);
  return d.data;
}
(async () => {
  const d = await api('GET', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE}/fields?page_size=100`);
  const items = d.items ?? [];
  console.log('TOTAL_FIELDS', items.length);
  for (const f of items) {
    const fmt = f.property?.date_formatter || '';
    console.log(`${f.field_id}\t${f.field_name}\ttype=${f.type}\t${fmt ? 'fmt=' + fmt : ''}`);
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
