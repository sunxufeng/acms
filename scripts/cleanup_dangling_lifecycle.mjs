// 清理指向已删除学生的存量生命周期记录。
// 用法: node cleanup_dangling_lifecycle.mjs            # 仅统计+列出(不改)
//       node cleanup_dangling_lifecycle.mjs --delete   # 实际删除
import fs from 'fs';

const ENV = process.env.ACMS_ENV || '/opt/acms/.env';
const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const APP_ID = env.FEISHU_APP_ID, APP_SECRET = env.FEISHU_APP_SECRET, BASE = env.FEISHU_BASE_TOKEN;
if (!APP_ID || !APP_SECRET || !BASE) { console.error('缺少 FEISHU 凭据', { APP_ID, BASE }); process.exit(1); }

const DO_DELETE = process.argv.includes('--delete');
const STUDENT_TBL = 'tbl2peVECjHnm8la';
const TABLES = {
  sourceFollowup: 'tblDEuaTDoiXkjZu',
  attendance: 'tblUkd1JKi4T7XQb',
  academicGrade: 'tblaYsfXSbqyZiZ5',
  practiceActivity: 'tblOitwcvOBSkeuu',
  homeSchoolComm: 'tbl8Isr46G3BRQ52',
  stageEvaluation: 'tblHk6r8USy6BXV4',
  alumniFollowup: 'tblK02GgjnaLp1Gp',
};
const LINK_FIELD = '关联学生编号';

let TOKEN;
async function getToken() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('token ' + j.code + ' ' + j.msg);
  TOKEN = j.tenant_access_token;
}
async function feishu(method, path, body) {
  const r = await fetch('https://open.feishu.cn' + path, {
    method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`feishu ${method} ${path} ${j.code} ${j.msg}`);
  return j.data;
}
async function listAll(tbl) {
  const out = []; let tok;
  do {
    const data = await feishu('POST',
      `/open-apis/bitable/v1/apps/${BASE}/tables/${tbl}/records/search?page_size=100${tok ? `&page_token=${tok}` : ''}`,
      { field_names: [], automatic_fields: false });
    out.push(...(data.items || []));
    tok = data.page_token;
    if (!data.has_more) break;
  } while (true);
  return out;
}
function linkIds(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object') return v.flatMap(o => o.record_ids || o.link_record_ids || []);
    return v;
  }
  if (typeof v === 'object') return v.link_record_ids || v.record_ids || [];
  return [];
}

await getToken();
const stud = await listAll(STUDENT_TBL);
const studIds = new Set(stud.map(r => r.record_id));
console.log('有效学生数:', studIds.size);

const toDelete = [];
for (const [name, tbl] of Object.entries(TABLES)) {
  const recs = await listAll(tbl);
  console.log(`表 ${name}: ${recs.length} 条`);
  for (const r of recs) {
    const ids = linkIds(r.fields[LINK_FIELD]);
    if (ids.length === 0) continue;
    const dangling = ids.some(id => !studIds.has(id));
    if (dangling) toDelete.push({ name, tbl, id: r.record_id, ids });
  }
}
console.log('待删除(指向已删学生)记录数:', toDelete.length);
console.log(JSON.stringify(toDelete.map(d => ({ name: d.name, id: d.id, ids: d.ids })), null, 2));

if (!DO_DELETE) { console.log('\n[DRY RUN] 加 --delete 才会真正删除。'); process.exit(0); }

let ok = 0;
for (const d of toDelete) {
  try {
    await feishu('DELETE', `/open-apis/bitable/v1/apps/${BASE}/tables/${d.tbl}/records/${d.id}`);
    ok++;
    console.log('deleted', d.name, d.id);
  } catch (e) {
    console.error('FAILED', d.name, d.id, e.message);
  }
}
console.log(`\nDONE: 删除 ${ok}/${toDelete.length}`);
