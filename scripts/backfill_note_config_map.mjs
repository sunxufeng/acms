#!/usr/bin/env node
/**
 * 回填「笔记配置映射」：用知识库配置里那套凭证拉全量笔记，补上「笔记 → 配置」归属。
 *
 * Usage (on server):
 *   node scripts/backfill_note_config_map.mjs /opt/acms/.env              # dry-run（默认，不写库）
 *   node scripts/backfill_note_config_map.mjs /opt/acms/.env --apply      # 真写
 *   node scripts/backfill_note_config_map.mjs /opt/acms/.env --apply --configId=recxxx
 *
 * 为什么需要：
 *   Get笔记 的 note 对象里没有任何字段能标识它属于哪个配置（source 恒为 "app"，
 *   note_type 是录音类型），归属只能由 ACMS 侧记录。自动同步会写（processNote），
 *   但**历史笔记从没同步过**，所以列表的「配置名称」列会全空 —— 这个脚本就是补这段。
 *
 * 安全设计：
 *   - 默认 dry-run，必须显式 --apply 才写
 *   - 幂等：已存在的 笔记ID 跳过，重复执行不产生脏数据
 *   - 单批上限 200（同 sources.service 的 CONFIG_MAP_MAX_CREATE），防飞书写入限流
 *   - 写完自带 verify：重新读表回读比对
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const envPath = args.find((a) => a.startsWith('--env='))?.split('=')[1] || '/opt/acms/.env';
const configIdArg = args.find((a) => a.startsWith('--configId='))?.split('=')[1] || '';

/** 知识库配置表（与 packages/contracts/src/tables.ts 的 getnoteSource 一致） */
const SOURCE_TABLE = 'tblmKQtZ5IOgyhv6';
/** 笔记配置映射表（与 tables.ts 的 noteConfigMap 一致） */
const MAP_TABLE = 'tbleFsIxXwZckVB8';
/** 单批最多新增多少条映射（与 sources.service 的 CONFIG_MAP_MAX_CREATE 对齐） */
const MAX_CREATE = 200;

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

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

/** KMS 解密：直接复用 API 编译产物，不重复实现（避免密钥算法漂移） */
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

/** 飞书文本字段可能返回 string 或 [{text}]，统一取纯文本 */
function plainText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
  return String(v);
}

/** 解出凭证对象（同 sources.service.decodeCred） */
function decodeCred(enc) {
  if (!enc || !decryptSecret) return {};
  try {
    const env = typeof enc === 'string' ? JSON.parse(enc) : enc;
    const plain = String(decryptSecret(env) ?? '');
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

/** 分页读全表 */
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
    out.push(...((j.data?.items ?? [])));
    if (!j.data?.has_more) break;
    pageToken = j.data.page_token;
  }
  return out;
}

/** 用一对凭证拉全量笔记（Get笔记 列表接口，cursor 翻页） */
async function fetchAllNotes(cred, maxPages = 100) {
  const notes = [];
  let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    const url = new URL('https://openapi.biji.com/open/api/v1/resource/note/list');
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('page_size', '50');
    const r = await fetch(url, {
      headers: { Authorization: cred.key, 'X-Client-ID': cred.clientId, 'Content-Type': 'application/json' },
    });
    const j = await r.json();
    if (!j.success) throw new Error(`Get笔记 拉取失败: ${JSON.stringify(j.error ?? {})}`);
    const data = j.data ?? {};
    notes.push(...(data.notes ?? []));
    if (!data.has_more || !data.cursor) break;
    cursor = String(data.cursor);
  }
  return notes;
}

async function main() {
  const token = await getToken();

  // ── 1. 找到要回填的那条配置 ────────────────────────────────────────
  const sources = await readAll(token, SOURCE_TABLE);
  let target = null;
  if (configIdArg) {
    target = sources.find((s) => s.record_id === configIdArg || s.recordId === configIdArg);
    if (!target) {
      console.error(`未找到配置记录 ${configIdArg}`);
      process.exit(1);
    }
  } else {
    const enabled = sources.filter((s) => plainText(s.fields['启用状态']) !== '停用');
    if (sources.length > 1 && enabled.length !== 1) {
      console.error(
        `配置表有 ${sources.length} 条（启用 ${enabled.length} 条），无法自动选择 —— 请用 --configId= 指定。\n` +
          sources.map((s) => `  ${s.record_id}  ${plainText(s.fields['配置名称'])}`).join('\n'),
      );
      process.exit(1);
    }
    target = enabled[0] ?? sources[0];
    if (!target) {
      console.error('配置表为空，先去「知识库配置」建一条');
      process.exit(1);
    }
  }

  const configId = target.record_id ?? target.recordId;
  const configName = plainText(target.fields['配置名称']);
  const noteType = plainText(target.fields['笔记类型']);
  console.log(`目标配置: ${configName}  (${configId})  笔记类型=${noteType}`);

  // ── 2. 解密该配置的凭证 ────────────────────────────────────────────
  const cred = decodeCred(target.fields['凭证']);
  if (!cred.apiKey || !cred.clientId) {
    console.error('凭证解不出来（KMS 不可用或该配置没填凭证），中止');
    process.exit(1);
  }

  // ── 3. 拉全量笔记 ──────────────────────────────────────────────────
  const notes = await fetchAllNotes({ key: cred.apiKey, clientId: cred.clientId });
  console.log(`该配置凭证拉到 ${notes.length} 条笔记`);

  // 顺带报一下「个人凭证视角」的条数，用来判断两套 Key 是否同源。
  // 不同源 = 列表里会有笔记查不到归属，显示「—」。失败只警告，不中断。
  try {
    const storePath = process.env.GETNOTE_CRED_STORE || '/opt/acms/data/getnote/credentials.json';
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const bag = raw?.users && typeof raw.users === 'object' ? raw.users : raw;
      const first = Object.values(bag)[0] ?? {};
      // 个人凭证是加密存的（字段带 Enc 后缀 = 信封 JSON 字符串），先解；
      // 解不开就当明文用（兼容历史格式）。
      const unwrap = (v) => {
        if (!v) return '';
        if (typeof v === 'string' && v.trim().startsWith('{')) {
          try {
            return String(decryptSecret(JSON.parse(v)) ?? '');
          } catch {
            /* 不是信封密文，按明文走 */
          }
        }
        return String(v);
      };
      const personal = {
        key: unwrap(first.apiKey ?? first.api_key ?? first.apiKeyEnc ?? first.api_key_enc ?? ''),
        clientId: unwrap(first.clientId ?? first.client_id ?? first.clientIdEnc ?? first.client_id_enc ?? ''),
      };
      if (personal.key && personal.clientId) {
        const mine = await fetchAllNotes(personal);
        console.log(`个人凭证拉到 ${mine.length} 条笔记  →  ${mine.length === notes.length ? '两套 Key 同源 ✅' : '⚠️ 不同源，列表会有空白行'}`);
      }
    }
  } catch (e) {
    console.log(`(个人凭证对比跳过: ${e.message})`);
  }

  // ── 4. 与映射表做差集 ──────────────────────────────────────────────
  const existing = await readAll(token, MAP_TABLE);
  const mapped = new Set(existing.map((r) => plainText(r.fields['笔记ID'])).filter(Boolean));
  console.log(`映射表现有 ${existing.length} 条（覆盖 ${mapped.size} 个笔记ID）`);

  const todo = [];
  for (const n of notes) {
    const id = String(n.note_id ?? n.id ?? '').trim();
    if (!id || mapped.has(id)) continue;
    if (todo.length >= MAX_CREATE) break;
    todo.push({ id, title: String(n.title ?? '') });
    mapped.add(id); // 批内去重
  }
  console.log(`待新增 ${todo.length} 条${todo.length >= MAX_CREATE ? `（已达单批上限 ${MAX_CREATE}，剩余下次再跑）` : ''}`);
  for (const t of todo.slice(0, 5)) console.log(`   + ${t.id}  ${t.title.slice(0, 30)}`);
  if (todo.length > 5) console.log(`   ... 其余 ${todo.length - 5} 条略`);

  if (!APPLY) {
    console.log('\n[dry-run] 未写入。确认无误后加 --apply 执行。');
    return;
  }
  if (!todo.length) {
    console.log('\n没有需要新增的，映射表已是最新。');
    return;
  }

  // ── 5. 串行写入（飞书无 batch，逐条 create）────────────────────────
  const now = Date.now();
  let ok = 0;
  let fail = 0;
  for (const t of todo) {
    try {
      const r = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${MAP_TABLE}/records`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            fields: {
              笔记ID: t.id,
              笔记标题: t.title.slice(0, 200),
              配置ID: configId,
              配置名称: configName,
              笔记类型: noteType,
              首次同步时间: now,
              更新时间: now,
            },
          }),
        },
      );
      const j = await r.json();
      if (j.code !== 0) {
        fail++;
        console.log(`   ✗ ${t.id}: ${j.code} ${j.msg ?? ''}`);
      } else {
        ok++;
      }
    } catch (e) {
      fail++;
      console.log(`   ✗ ${t.id}: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`\n写入完成: 成功 ${ok} / 失败 ${fail}`);

  // ── 6. verify：重新读表回读比对 ────────────────────────────────────
  const after = await readAll(token, MAP_TABLE);
  const byNote = new Map(after.map((r) => [plainText(r.fields['笔记ID']), r]));
  let verified = 0;
  for (const t of todo) {
    const rec = byNote.get(t.id);
    if (rec && plainText(rec.fields['配置ID']) === configId) verified++;
  }
  console.log(`[verify] 映射表现有 ${after.length} 条；本次新增的 ${todo.length} 条中回读命中 ${verified} 条`);
  const sample = todo.slice(0, 3).map((t) => {
    const rec = byNote.get(t.id);
    return rec ? `${plainText(rec.fields['笔记ID'])}→${plainText(rec.fields['配置名称'])}` : `${t.id}→缺失`;
  });
  console.log(`[verify] 抽样: ${sample.join(' | ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
