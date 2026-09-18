#!/usr/bin/env node
/**
 * 修正已落库录音的**容器信息**（MIME / 扩展名），以文件头实际内容为准。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────
 * 录音落库时代码把 MIME 与扩展名**写死**成 `audio/ogg`，但上游同一批录音里
 * 混杂着 Ogg/Opus 与 MP3（实测 554 个里 40 个是 MP3）。写死的后果是浏览器
 * 按 `audio/ogg` 去解 MP3 字节流，解码器起不来 —— **播放器直接报错、没有声音**。
 * 这就是 2026-09-18「部分音频文件没法播放」的根因。
 *
 * 接口侧（`/files/:token`、`/getnote/notes/:id/audio`）已改为按文件头嗅探并动态给
 * Content-Type，所以**不改本脚本文件也能播**；本脚本负责把存量元数据也修正过来，
 * 让界面里显示的文件名（`.mp3` 而不是 `.ogg`）与下载行为都和实际格式一致。
 *
 * 改两处：
 *   1. 附件目录里 `<token>.json` 的 `{ filename, mime }`
 *   2. 笔记正文表 `音频附件[]` 里对应条的 `{ name, type }`（界面展示用）
 *
 * Usage (on server):
 *   node scripts/fix_note_audio_media.mjs /opt/acms/.env            # dry-run
 *   node scripts/fix_note_audio_media.mjs /opt/acms/.env --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// `pg` 装在 apps/api（不是仓库根），所以按 apps/api 为基准解析依赖
const require = createRequire(new URL('../apps/api/', import.meta.url));
const { Client } = require('pg');

/** 异步版 fs（`fs.readdir` 等回调式 API 不能直接 await） */
const fsp = fs.promises;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ENV_PATH = args.find((a) => a.startsWith('--env='))?.split('=')[1] || args[0] || '/opt/acms/.env';

const T_NOTE_BODY = 'tblnotebody000001';
const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|m4a|mp4|aac|wav|flac|weba|webm|amr)$/i;

function loadEnv(p) {
  if (!fs.existsSync(p)) {
    console.error(`env 文件不存在: ${p}`);
    process.exit(1);
  }
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

/**
 * 按文件头判断音频容器 —— 与 `apps/api/src/file-storage/audio-format.ts` 同一套判据
 * （脚本不能用 TS import，所以这里内联一份；改一边必须改另一边）。
 */
function sniffAudioFormat(buf) {
  if (!buf || buf.length < 12) return null;
  const b0_4 = buf.subarray(0, 4).toString('latin1');
  const b4_8 = buf.subarray(4, 8).toString('latin1');
  const b8_12 = buf.subarray(8, 12).toString('latin1');
  if (b0_4 === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (b0_4 === 'RIFF' && b8_12 === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (b4_8 === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (b0_4 === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3') return { mime: 'audio/webm', ext: 'weba' };
  if (buf.subarray(0, 5).toString('latin1') === '#!AMR') return { mime: 'audio/amr', ext: 'amr' };
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };
  if (buf[0] === 0xff && (buf[1] ?? 0) >= 0xe0) return { mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

/** `1921409905412164160.ogg` + mp3 → `1921409905412164160.mp3` */
function withExt(filename, ext) {
  const name = String(filename ?? '').trim() || 'audio';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${ext}`;
}

async function main() {
  const env = loadEnv(ENV_PATH);
  if (!env.DATABASE_URL) {
    console.error('env 里没有 DATABASE_URL');
    process.exit(1);
  }
  const dir = process.env.ACMS_ATTACHMENT_DIR?.trim() || '/opt/acms/data/attachments';
  console.log(`附件目录: ${dir}`);
  console.log(`模式: ${APPLY ? 'APPLY（真写）' : 'dry-run'}\n`);

  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  const fixes = [];
  const tally = {};

  for (const j of files) {
    const id = j.slice(0, -5);
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, j), 'utf8'));
    } catch {
      continue;
    }
    const fn = String(meta.filename ?? '');
    if (!AUDIO_EXT_RE.test(fn)) continue;
    let buf;
    try {
      const fh = await fsp.open(path.join(dir, `${id}.bin`), 'r');
      buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, 4096, 0);
      await fh.close();
      buf = buf.subarray(0, bytesRead);
    } catch {
      tally['文件缺失'] = (tally['文件缺失'] ?? 0) + 1;
      continue;
    }
    const sniffed = sniffAudioFormat(buf);
    if (!sniffed) {
      tally['无法识别'] = (tally['无法识别'] ?? 0) + 1;
      continue;
    }
    tally[sniffed.ext] = (tally[sniffed.ext] ?? 0) + 1;

    /**
     * 只修「元数据写死 `audio/ogg` 但实际不是 Ogg」这一类 —— 那是导致**播放失败**的 bug：
     * 浏览器按 audio/ogg 去解 MP3 字节流，解码器直接起不来。
     *
     * 刻意**不动**其它不一致（如 `video/mp4` 装的其实是 m4a 音频）：
     *   1. `video/mp4` 对 mp4 容器是合法 MIME，浏览器照样能播，不属于故障；
     *   2. ftyp 盒子**区分不了音频轨与视频轨**，硬改成 audio/mp4 会让真视频丢掉画面。
     * 这类只报告不改，避免「为了整洁引入新故障」。
     */
    const isOggMismatch = meta.mime === 'audio/ogg' && sniffed.ext !== 'ogg';
    if (!isOggMismatch) {
      if (meta.mime !== sniffed.mime || !fn.toLowerCase().endsWith(`.${sniffed.ext}`)) {
        tally[`仅报告(${meta.mime}→${sniffed.mime})`] =
          (tally[`仅报告(${meta.mime}→${sniffed.mime})`] ?? 0) + 1;
      }
      continue;
    }

    const newName = withExt(fn, sniffed.ext);
    fixes.push({ id, oldName: fn, newName, oldMime: meta.mime, newMime: sniffed.mime, meta });
  }

  console.log('按文件头统计:', JSON.stringify(tally));
  console.log(`需要修正: ${fixes.length} 个\n`);
  for (const f of fixes.slice(0, 15)) {
    console.log(`  ${f.id.slice(0, 24)}… ${f.oldName} → ${f.newName}  [${f.oldMime} → ${f.newMime}]`);
  }
  if (fixes.length > 15) console.log(`  …其余 ${fixes.length - 15} 个同类`);

  if (!APPLY) {
    console.log('\n（dry-run，未改动任何文件。确认无误后加 --apply 执行）');
    return;
  }

  // ① 修附件元数据
  for (const f of fixes) {
    const next = { ...f.meta, filename: f.newName, mime: f.newMime };
    await fsp.writeFile(path.join(dir, `${f.id}.json`), JSON.stringify(next));
  }
  console.log(`\n✅ 已修正 ${fixes.length} 个附件元数据`);

  // ② 同步正文表里展示用的 name / type（token → 行 id 建索引）
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const t = (await client.query('select sql_table from acms_tables where table_id = $1', [T_NOTE_BODY]))
    .rows[0]?.sql_table;
  if (!t) {
    console.error('笔记正文表未注册，跳过第 ② 步');
    await client.end();
    return;
  }
  const rows = await client.query(`select id, data->'音频附件' as att from ${t}`);
  const byToken = new Map();
  for (const r of rows.rows) {
    for (const a of Array.isArray(r.att) ? r.att : []) {
      if (a?.file_token) byToken.set(String(a.file_token), r.id);
    }
  }
  let updated = 0;
  for (const f of fixes) {
    const recId = byToken.get(f.id);
    if (!recId) continue;
    const r = await client.query(`select data->'音频附件' as att from ${t} where id = $1`, [recId]);
    const arr = Array.isArray(r.rows[0]?.att) ? r.rows[0].att : [];
    const next = arr.map((a) =>
      String(a?.file_token) === f.id ? { ...a, name: f.newName, type: f.newMime } : a,
    );
    // 只改这一个字段（`data || jsonb_build_object` 是合并语义，不会动总结正文）
    await client.query(
      `update ${t} set data = coalesce(data,'{}'::jsonb) || jsonb_build_object('音频附件', $2::jsonb),
              updated_at = now() where id = $1`,
      [recId, JSON.stringify(next)],
    );
    updated++;
  }
  console.log(`✅ 已同步 ${updated} 条正文表的音频附件展示信息`);
  await client.end();
}

main().catch((e) => {
  console.error('执行失败:', e);
  process.exit(1);
});
