#!/usr/bin/env node
/**
 * 回填归属人：给「知识库配置」与「笔记配置映射」两张表的存量记录补上归属。
 *
 * Usage (on server):
 *   node scripts/backfill_note_owner.mjs /opt/acms/.env                 # dry-run（默认，不写库）
 *   node scripts/backfill_note_owner.mjs /opt/acms/.env --apply         # 真写
 *   node scripts/backfill_note_owner.mjs /opt/acms/.env --apply --fallback=ou_xxx
 *
 * 归属怎么定（不用猜）：
 *   「知识库配置」解出它存的凭证 apiKey，去凭证库 credentials.json 里比对 ——
 *   谁的 apiKey 一致，这条配置就是谁的。**不用按人数/顺序推断**（这是老坑）。
 *   匹配不上就跳过并告警（可用 --fallback 指定一个兜底 openId）。
 *
 *   「笔记配置映射」的归属跟随它引用的那条配置（按 配置ID 查到配置行的归属）。
 *
 * 安全设计：
 *   - 默认 dry-run，必须显式 --apply 才写
 *   - 幂等：归属人ID 已有值的跳过
 *   - 写完自带 verify：重新读表回读比对
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const envPath = args.find((a) => a.startsWith('--env='))?.split('=')[1] || '/opt/acms/.env';
const fallbackArg = args.find((a) => a.startsWith('--fallback='))?.split('=')[1] || '';

const SOURCE_TABLE = 'tblmKQtZ5IOgyhv6'; // 知识库配置
const MAP_TABLE = 'tbleFsIxXwZckVB8'; // 笔记配置映射

function loadEnv(path) {
  if (!fs.existsSync(path)) {
    console.error(`env 文件不存在: ${path}`);
    process.exit(1);
  }
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

loadEnv(envPath);

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;
const CRED_STORE = process.env.GETNOTE_CRED_STORE || '/opt/acms/data/getnote/credentials.json';

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

/** KMS 解密：复用 API 编译产物，不重复实现 */
function loadDecrypt() {
  const p = '/opt/acms/repo/apps/api/dist/ai/lib/crypto/kms.js';
  if (!fs.existsSync(p)) return null;
  try {
    return require(p).decryptSecret;
  } catch {
    return null;
  }
}
const decryptSecret = loadDecrypt();
if (!decryptSecret) {
  console.error('无法加载 KMS decryptSecret（/opt/acms/repo/apps/api/dist/ai/lib/crypto/kms.js 不存在）');
  process.exit(1);
}

/** 飞书文本字段可能返回 string 或 [{text}]，统一取纯文本 */
function plainText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
  return String(v);
}

/** KMS 解信封 → 明文 */
function readEnc(enc) {
  if (!enc) return '';
  try {
    return String(decryptSecret(enc) ?? '');
  } catch {
    return '';
  }
}

/** 解出配置行的凭证对象（同 sources.service.decodeCred） */
function decodeCred(enc) {
  if (!enc) return {};
  try {
    const env = typeof enc === 'string' ? JSON.parse(enc) : enc;
    const plain = readEnc(env);
    if (!plain) return {};
    const obj = JSON.parse(plain);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

async function getToken() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('token failed: ' + JSON.stringify(j));
  return j.tenant_access_token;
}

async function readAll(token, tableId, pageSize = 200, maxPages = 20) {
  const out = [];
  let pageToken;
  for (let i = 0; i < maxPages; i++) {
    const url =
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records?page_size=${pageSize}` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`read ${tableId} failed: ${JSON.stringify(j)}`);
    out.push(...(j.data?.items ?? []));
    if (!j.data?.has_more) break;
    pageToken = j.data.page_token;
  }
  return out;
}

async function updateRecord(token, tableId, recordId, fields) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records/${recordId}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`update ${recordId} failed: ${JSON.stringify(j)}`);
  return true;
}

/** apiKey → { openId, displayName }：从个人凭证库反查 */
function loadOwnersByKey() {
  const map = new Map();
  if (!fs.existsSync(CRED_STORE)) {
    console.error(`凭证库不存在: ${CRED_STORE}`);
    return map;
  }
  let db;
  try {
    db = JSON.parse(fs.readFileSync(CRED_STORE, 'utf8'));
  } catch (e) {
    console.error('凭证库解析失败:', e.message);
    return map;
  }
  const users = db?.users ?? {};
  for (const [openId, v] of Object.entries(users)) {
    const key = readEnc(v.apiKeyEnc);
    if (!key) continue;
    if (map.has(key)) {
      console.warn(`  ⚠ apiKey 重复注册：${openId} 与 ${map.get(key).openId} 用同一个 Key（映射可能串）`);
      continue;
    }
    map.set(key, { openId, displayName: v.displayName || openId });
  }
  return map;
}

async function main() {
  console.log(`模式: ${APPLY ? 'APPLY（真写）' : 'DRY-RUN（只读，不写库）'}\n`);

  const ownersByKey = loadOwnersByKey();
  console.log(`凭证库 ${CRED_STORE}`);
  console.log(`  可用凭证 ${ownersByKey.size} 份：`);
  for (const [, v] of ownersByKey) console.log(`    - ${v.displayName} (${v.openId})`);
  console.log('');

  const token = await getToken();

  // ── 1. 知识库配置：按凭证指纹定归属 ─────────────────────────────
  console.log('=== 知识库配置 ===');
  const sources = await readAll(token, SOURCE_TABLE);
  const ownerOfConfig = {}; // recordId → { openId, displayName }
  const srcPlans = [];
  let srcSkip = 0;
  let srcMatchFail = 0;

  for (const row of sources) {
    const f = row.fields ?? {};
    const rid = row.record_id;
    const name = plainText(f['配置名称']) || rid;
    const haveId = plainText(f['归属人ID']);
    if (haveId) {
      srcSkip++;
      ownerOfConfig[rid] = { openId: haveId, displayName: plainText(f['归属人']) };
      continue;
    }
    const cred = decodeCred(f['凭证']);
    const apiKey = String(cred.apiKey ?? cred.api_key ?? '').trim();
    const hit = apiKey ? ownersByKey.get(apiKey) : null;
    if (hit) {
      ownerOfConfig[rid] = hit;
      srcPlans.push({ rid, name, ...hit });
      console.log(`  [待回填] ${name} → ${hit.displayName} (${hit.openId})`);
    } else if (fallbackArg) {
      const fb = ownersByKey.get(fallbackArg);
      if (fb) {
        ownerOfConfig[rid] = fb;
        srcPlans.push({ rid, name, ...fb });
        console.log(`  [待回填] ${name} → ${fb.displayName}（fallback 指定）`);
      } else {
        srcMatchFail++;
        console.warn(`  [跳过] ${name}：凭证未能匹配任何用户，且 fallback ${fallbackArg} 不在凭证库里`);
      }
    } else {
      srcMatchFail++;
      console.warn(`  [跳过] ${name}：凭证未能匹配任何用户（解出 apiKey=${apiKey ? '有' : '无'}）`);
    }
  }
  console.log(`  合计 ${sources.length} 条：待回填 ${srcPlans.length}，已有归属 ${srcSkip}，无法判定 ${srcMatchFail}\n`);

  // ── 2. 笔记配置映射：跟随其引用的配置 ───────────────────────────
  console.log('=== 笔记配置映射 ===');
  const maps = await readAll(token, MAP_TABLE);
  const mapPlans = [];
  let mapSkip = 0;
  let mapOrphan = 0;

  for (const row of maps) {
    const f = row.fields ?? {};
    const rid = row.record_id;
    const noteId = plainText(f['笔记ID']);
    if (plainText(f['归属人ID'])) {
      mapSkip++;
      continue;
    }
    const owner = ownerOfConfig[plainText(f['配置ID'])];
    if (!owner) {
      mapOrphan++;
      continue;
    }
    mapPlans.push({ rid, noteId, ...owner });
  }
  console.log(`  合计 ${maps.length} 条：待回填 ${mapPlans.length}，已有归属 ${mapSkip}，无归属配置可跟随 ${mapOrphan}`);
  if (mapPlans.length) {
    console.log(`  归属分布：`);
    const dist = {};
    for (const p of mapPlans) dist[p.displayName] = (dist[p.displayName] ?? 0) + 1;
    for (const [k, v] of Object.entries(dist)) console.log(`    - ${k}: ${v} 条`);
  }
  console.log('');

  if (!APPLY) {
    console.log('DRY-RUN 结束，未写任何数据。加 --apply 才会真写。');
    return;
  }

  // ── 3. 写入 ────────────────────────────────────────────────────
  let okA = 0;
  let failA = 0;
  for (const p of srcPlans) {
    try {
      await updateRecord(token, SOURCE_TABLE, p.rid, { 归属人: p.displayName, 归属人ID: p.openId });
      okA++;
    } catch (e) {
      failA++;
      console.error(`  写失败 ${p.name}: ${e.message}`);
    }
  }
  console.log(`知识库配置写入：成功 ${okA}，失败 ${failA}`);

  let okB = 0;
  let failB = 0;
  for (const p of mapPlans) {
    try {
      await updateRecord(token, MAP_TABLE, p.rid, { 归属人: p.displayName, 归属人ID: p.openId });
      okB++;
    } catch (e) {
      failB++;
      console.error(`  写失败 ${p.noteId}: ${e.message}`);
    }
  }
  console.log(`笔记配置映射写入：成功 ${okB}，失败 ${failB}\n`);

  // ── 4. verify 独立回读 ─────────────────────────────────────────
  const srcAfter = await readAll(token, SOURCE_TABLE);
  const srcNoOwner = srcAfter.filter((r) => !plainText(r.fields?.['归属人ID']));
  const mapAfter = await readAll(token, MAP_TABLE);
  const mapNoOwner = mapAfter.filter((r) => !plainText(r.fields?.['归属人ID']));

  console.log('[verify] 知识库配置：', srcAfter.length, '条，缺归属', srcNoOwner.length, '条');
  for (const r of srcNoOwner) console.log('    缺:', r.record_id, plainText(r.fields?.['配置名称']));
  console.log('[verify] 笔记配置映射：', mapAfter.length, '条，缺归属', mapNoOwner.length, '条');

  // 本次应写的是否都命中
  const srcIds = new Set(srcAfter.map((r) => r.record_id));
  const hitA = srcPlans.filter((p) => srcIds.has(p.rid) && plainText(srcAfter.find((r) => r.record_id === p.rid)?.fields?.['归属人ID']) === p.openId).length;
  const hitB = mapPlans.filter((p) => plainText(mapAfter.find((r) => r.record_id === p.rid)?.fields?.['归属人ID']) === p.openId).length;
  console.log(`[verify] 本次计划写入：配置 ${srcPlans.length} 条 → 回读命中 ${hitA}；映射 ${mapPlans.length} 条 → 回读命中 ${hitB}`);

  const allOk = failA === 0 && failB === 0 && hitA === srcPlans.length && hitB === mapPlans.length && srcNoOwner.length === 0 && mapNoOwner.length === 0;
  console.log(allOk ? '\nBACKFILL_OK' : '\nBACKFILL_INCOMPLETE');
  if (!allOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
