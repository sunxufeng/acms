import fs from 'node:fs';

const envPath = process.argv[2] || '/opt/acms/.env';
const env = fs.readFileSync(envPath, 'utf8');
for (const line of env.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) {
    let v = m[2].trim();
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

const TABLE_ID = 'tblqeuKQlsuOIeUy';
const labels = {
  wechat_mini_appid: '微信小程序 AppID；登录微信公众平台 → 开发 → 开发管理 → 开发设置 获取',
  wechat_mini_secret: '微信小程序 AppSecret；与 AppID 同页获取，注意保密',
};

async function getTenantToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`token err: ${JSON.stringify(data)}`);
  return data.tenant_access_token;
}

async function main() {
  const token = await getTenantToken();
  const res = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.FEISHU_BASE_TOKEN}/tables/${TABLE_ID}/records/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_size: 100 }),
  });
  const data = await res.json();
  const items = (data.data && data.data.items) || [];

  for (const item of items) {
    const keyField = item.fields['配置键'];
    const keyText = Array.isArray(keyField) && keyField[0] && keyField[0].text;
    if (!keyText || !labels[keyText]) continue;

    const updateRes = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.FEISHU_BASE_TOKEN}/tables/${TABLE_ID}/records/${item.record_id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { 说明: labels[keyText] } }),
    });
    const updateData = await updateRes.json();
    if (updateData.code !== 0) {
      console.error(`更新 ${keyText} 失败:`, JSON.stringify(updateData));
    } else {
      console.log(`已更新说明: ${keyText}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
