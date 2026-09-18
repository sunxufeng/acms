import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/', import.meta.url));
const { Client } = require('pg');
const fsp = fs.promises;

const ENV = '/opt/acms/.env';
const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  const i = s.indexOf('=');
  if (i > 0) env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
}
const dir = '/opt/acms/data/attachments';
const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
const tally = {};
const mp3now = [];
for (const j of files) {
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(`${dir}/${j}`, 'utf8'));
  } catch {
    continue;
  }
  const fn = String(meta.filename ?? '');
  if (!/\.(ogg|mp3|m4a|mp4|weba|wav|flac|amr)$/i.test(fn)) continue;
  const key = `${meta.mime} | ${fn.split('.').pop()}`;
  tally[key] = (tally[key] ?? 0) + 1;
  if (/\.mp3$/i.test(fn)) mp3now.push({ id: j.slice(0, -5), fn, mime: meta.mime });
}
console.log('附件元数据现状（mime | 扩展名 → 数量）:');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k} → ${v}`);

const client = new Client({ connectionString: env.DATABASE_URL });
await client.connect();
const t = (await client.query("select sql_table from acms_tables where table_id='tblnotebody000001'")).rows[0].sql_table;
const rows = await client.query(`select id, data->'音频附件' as att from ${t}`);
const byToken = new Map();
for (const r of rows.rows) for (const a of Array.isArray(r.att) ? r.att : []) if (a?.file_token) byToken.set(String(a.file_token), { rowId: r.id, a });
console.log(`\n正文表含音频的行: ${byToken.size}`);
let okName = 0, badName = 0;
const samples = [];
for (const m of mp3now) {
  const hit = byToken.get(m.id);
  if (!hit) continue;
  const name = String(hit.a.name ?? '');
  const type = String(hit.a.type ?? '');
  if (/\.mp3$/i.test(name) && type === 'audio/mpeg') okName++;
  else { badName++; samples.push({ token: m.id.slice(0, 20), name, type }); }
}
console.log(`其中已改为 .mp3/audio/mpeg: ${okName}，仍不对: ${badName}`);
if (samples.length) console.log('样例:', JSON.stringify(samples.slice(0, 5)));
// 反向核对：正文表里 type=audio/ogg 但文件实为 mp3 的残留
let leftover = 0;
for (const [token, v] of byToken) {
  if (String(v.a.type ?? '') === 'audio/ogg' && /\.ogg$/i.test(String(v.a.name ?? ''))) {
    const metaPath = `${dir}/${token}.json`;
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    if (String(meta.mime) !== 'audio/ogg') leftover++;
  }
}
console.log(`正文表仍写 audio/ogg 但文件已非 ogg 的: ${leftover}`);
await client.end();
