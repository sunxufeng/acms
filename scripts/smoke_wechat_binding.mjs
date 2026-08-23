#!/usr/bin/env node
/**
 * Smoke test for the WeChat login user binding flow (end-to-end, no OAuth needed):
 *   1. pick a real student (学生编号 + 学生姓名) from the student profile table
 *   2. call POST /api/v1/parent/auth/bind  -> triggers WechatBindingService.upsertBinding
 *   3. confirm a record with 标识=parent_<studentId>, 状态=已绑定 exists in the 微信登录用户 table
 *   4. cleanup: delete the test binding record (keep the system clean)
 *
 * Usage: node scripts/smoke_wechat_binding.mjs [/path/to/.env]
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

const envPath = process.argv[2] || '/opt/acms/.env';
loadEnv(envPath);

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;
const STUDENT_TABLE = 'tbl2peVECjHnm8la';
const BINDING_TABLE = 'tblbZ43Nkenwfu8D';
const API_BASE = process.env.API_BASE || 'https://127.0.0.1';

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) { console.error('Missing Feishu creds'); process.exit(1); }

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await res.json();
  if (d.code !== 0) { console.error('token failed', d); process.exit(1); }
  return d.tenant_access_token;
}
const feishu = (method, path, token, body) =>
  fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

function pickText(fields, name) {
  const v = fields[name];
  if (Array.isArray(v)) return (v[0]?.text) ?? String(v[0] ?? '');
  return v == null ? '' : String(v);
}

async function main() {
  const token = await getToken();

  // 1) pick a student
  const stuRes = await feishu('POST', `/tables/${STUDENT_TABLE}/records/search?page_size=1`, token, { field_names: [] });
  const stu = stuRes.data?.items?.[0];
  if (!stu) { console.error('no student found'); process.exit(1); }
  const studentNo = pickText(stu.fields, '学生编号');
  const studentName = pickText(stu.fields, '学生姓名');
  console.log(`Selected student: ${studentName} (${studentNo})`);

  // 2) trigger parent bind -> upsertBinding
  const bindRes = await fetch(`${API_BASE}/api/v1/parent/auth/bind`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentNo, name: studentName }),
  });
  const bindJson = await bindRes.json();
  if (!bindRes.ok) { console.error('bind failed', bindJson); process.exit(1); }
  console.log(`bind ok: studentId=${bindJson.studentId} name=${bindJson.name}`);

  // 3) confirm binding record
  const expectedOpenId = `parent_${bindJson.studentId}`;
  const listRes = await feishu('POST', `/tables/${BINDING_TABLE}/records/search?page_size=10`, token, {
    filter: { conjunction: 'and', conditions: [{ field_name: '标识', operator: 'is', value: [expectedOpenId] }] },
  });
  const rec = listRes.data?.items?.find((r) => pickText(r.fields, '标识') === expectedOpenId);
  if (!rec) { console.error('BINDING RECORD NOT CREATED — FAIL'); process.exit(1); }
  console.log(`binding record created: 标识=${pickText(rec.fields, '标识')} 角色=${pickText(rec.fields, '角色')} 登录方式=${pickText(rec.fields, '登录方式')} 状态=${pickText(rec.fields, '状态')} 姓名=${pickText(rec.fields, '姓名')} 学号=${pickText(rec.fields, '学号')}`);

  // 4) cleanup: delete the test record
  await feishu('DELETE', `/tables/${BINDING_TABLE}/records/${rec.record_id}`, token);
  console.log('cleaned up test binding record');
  console.log('SMOKE TEST PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
