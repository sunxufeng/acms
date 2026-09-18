#!/usr/bin/env node
/**
 * 只读巡检：把「能播的」和「播不了的」笔记分出来。
 *
 * 判「播不了」的四类原因（按用户实际感知排序）：
 *   A. 笔记没进正文表 ⇒ 列表里没有 _audio ⇒ 按钮是灰的 / 压根没有按钮
 *      （快照表有、正文表无 = 从未抓过正文，也就永远进不了音频抓取候选集）
 *   B. 进了正文表但音频状态为空 / 上游无音频 ⇒ 无音频可播
 *   C. 有音频 token 但**文件实体缺失**（.bin 不存在）⇒ 点了报错
 *   D. 文件在但**内容不完整 / 容器无法识别**（0 字节、截断、magic 不认识）⇒ 播到一半停 / 不出声
 *
 * ⚠️ 本脚本**只读**：不写库、不改文件。
 * Usage: node scripts/audit_note_audio.mjs /opt/acms/.env
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/', import.meta.url));
const { Client } = require('pg');

const T_NOTE_BODY = 'tblnotebody000001';
const T_NOTE_SNAP = 'tblnotesnap000001';
const AUDIO_STATE_SAVED = '已保存';
const ENV_PATH = process.argv.find((a) => a.startsWith('--env='))?.split('=')[1] || process.argv[2] || '/opt/acms/.env';

function loadEnv(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const a = buf.subarray(0, 4).toString('latin1');
  const b4 = buf.subarray(4, 8).toString('latin1');
  const b8 = buf.subarray(8, 12).toString('latin1');
  if (a === 'OggS') return 'ogg';
  if (a === 'RIFF' && b8 === 'WAVE') return 'wav';
  if (b4 === 'ftyp') return 'mp4';
  if (a === 'fLaC') return 'flac';
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
  if (buf.subarray(0, 5).toString('latin1') === '#!AMR') return 'amr';
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] ?? 0) >= 0xe0) return 'mp3';
  return null;
}

const env = loadEnv(ENV_PATH);
const dir = process.env.ACMS_ATTACHMENT_DIR?.trim() || '/opt/acms/data/attachments';
const client = new Client({ connectionString: env.DATABASE_URL });
await client.connect();
const tbl = async (id) => (await client.query('select sql_table from acms_tables where table_id=$1', [id])).rows[0]?.sql_table;
const bodyTbl = await tbl(T_NOTE_BODY);
const snapTbl = await tbl(T_NOTE_SNAP);

const body = await client.query(
  `select id, data->>'标题' as title, data->>'归属人' as owner, data->>'笔记类型' as ntype,
          data->>'音频状态' as st, data->>'音频时长' as dur,
          data->'音频附件'->0->>'file_token' as token,
          data->'音频附件'->0->>'name' as fname,
          data->'音频附件'->0->>'size' as fsize
     from ${bodyTbl}`,
);
const snapOnly = await client.query(
  `select s.id, s.data->>'标题' as title, s.data->>'归属人' as owner, s.data->>'笔记类型' as ntype,
          s.data->>'笔记创建时间' as created
     from ${snapTbl} s
    where not exists (select 1 from ${bodyTbl} b where b.id = s.id)`,
);
await client.end();

const RECORDING_TYPES = new Set(['recorder_audio', 'audio', 'meeting', 'class_audio', 'recorder_flash_audio']);
const out = { A_noBody: [], B_noAudio: [], C_fileMissing: [], D_fileBad: [], ok: 0, stats: {} };
const tally = (k) => ((out.stats[k] = (out.stats[k] ?? 0) + 1));

for (const r of snapOnly.rows) {
  if (RECORDING_TYPES.has(String(r.ntype ?? ''))) out.A_noBody.push(r);
}

for (const r of body.rows) {
  const st = String(r.st ?? '').trim();
  const token = String(r.token ?? '').trim();
  if (st !== AUDIO_STATE_SAVED || !token) {
    if (String(r.ntype ?? '') !== 'plain_text') {
      out.B_noAudio.push({ id: r.id, title: r.title, owner: r.owner, ntype: r.ntype, st: st || '(空)' });
    }
    continue;
  }
  const bin = path.join(dir, `${token}.bin`);
  if (!fs.existsSync(bin)) {
    out.C_fileMissing.push({ id: r.id, title: r.title, owner: r.owner, token });
    continue;
  }
  const size = fs.statSync(bin).size;
  const fh = await fs.promises.open(bin, 'r');
  const head = Buffer.alloc(64);
  const { bytesRead } = await fh.read(head, 0, 64, 0);
  await fh.close();
  const kind = sniff(head.subarray(0, bytesRead));
  const recSize = Number(r.fsize ?? 0) || 0;
  const durMs = Number(r.dur ?? 0) || 0;
  const problems = [];
  if (size === 0) problems.push('0 字节');
  if (!kind) problems.push('容器无法识别');
  if (recSize && Math.abs(size - recSize) > 1024) problems.push(`大小与记录不符(记录${recSize}/实际${size})`);
  if (size > 0 && size < 2000) problems.push(`极小(${size}B)`);
  if (problems.length) {
    out.D_fileBad.push({ id: r.id, title: r.title, owner: r.owner, token, size, kind, durMs, problems });
  } else {
    out.ok++;
    tally(kind ?? 'unknown');
  }
}

console.log('================ 笔记音频可播性巡检（只读） ================');
console.log(`正文表行数: ${body.rows.length}｜快照有正文无: ${snapOnly.rows.length}`);
console.log(`\n✅ A 类 · 能播: ${out.ok}`);
console.log('\n🔴 A 类 · 从未抓过正文（列表里没有播放按钮）: ' + out.A_noBody.length);
for (const r of out.A_noBody) console.log(`   ${r.id}  ${String(r.owner ?? '').padEnd(14)} ${String(r.title ?? '').slice(0, 40)}`);
console.log('\n🟡 B 类 · 有记录但无音频（非纯文本）: ' + out.B_noAudio.length);
for (const r of out.B_noAudio) console.log(`   ${r.id}  ${String(r.owner ?? '').padEnd(14)} [${r.st}] ${String(r.title ?? '').slice(0, 40)}`);
console.log('\n🔴 C 类 · 文件缺失: ' + out.C_fileMissing.length);
for (const r of out.C_fileMissing) console.log(`   ${r.id}  ${r.token}  ${String(r.title ?? '').slice(0, 36)}`);
console.log('\n🔴 D 类 · 文件异常: ' + out.D_fileBad.length);
for (const r of out.D_fileBad) console.log(`   ${r.id}  ${r.problems.join('/')}  ${String(r.title ?? '').slice(0, 36)}`);
console.log('\n容器分布（能播的）:', JSON.stringify(out.stats));
await fs.promises.writeFile('/tmp/audio_audit.json', JSON.stringify(out, null, 1));
console.log('\n明细已写 /tmp/audio_audit.json');
