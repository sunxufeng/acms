#!/usr/bin/env node
/**
 * 回填：把「笔记的原始录音」补进已转出的业务记录。
 *
 * 背景：「笔记 → 业务记录」的转换（转换配置页配的映射）2026-09-18 起会**一并带上
 * 笔记的原始录音**，写进目标模块的附件字段。但在那之前转出去的记录只有文字，
 * 录音没带过去 —— 本脚本把这段历史补齐。
 *
 * 数据链路（全部读本地 PG，不打上游、不消耗得到大脑额度）：
 *   笔记转换记录表（目标记录ID 非空）
 *     → 源笔记正文表 `音频附件[0]`（已落库的 loc_* token）
 *     → 目标模块表（按模块 key 查出真实表名）的附件字段
 *
 * 关键设计：
 *   - **不复制文件**：附件是内容寻址落盘的独立文件（`loc_sha1前缀...bin`），
 *     把同一个 token 写进第二条记录是安全的；删记录也不会删物理文件。
 *   - **合并而非覆盖**：目标记录里可能已经有人工上传的其它附件，只做「按 token 去重后追加」，
 *     且用 SQL `data || jsonb_build_object(...)` **只更新这一个字段**（其它字段原样不动）。
 *   - **默认 dry-run**，必须显式 `--apply` 才写库；幂等，可反复执行。
 *
 * Usage (on server):
 *   node scripts/backfill_convert_audio.mjs /opt/acms/.env             # dry-run，打印将要做的改动
 *   node scripts/backfill_convert_audio.mjs /opt/acms/.env --apply     # 真写
 *   node scripts/backfill_convert_audio.mjs /opt/acms/.env --apply --logId=rec_xxx
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

// `pg` 装在 apps/api（不是仓库根），所以按 apps/api 为基准解析依赖 ——
// 在仓库根跑 `node scripts/xxx.mjs` 时也能找到，不必额外配 NODE_PATH。
const require = createRequire(new URL('../apps/api/', import.meta.url));
const { Client } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ENV_PATH = args.find((a) => a.startsWith('--env='))?.split('=')[1] || args[0] || '/opt/acms/.env';
const ONLY_LOG_ID = args.find((a) => a.startsWith('--logId='))?.split('=')[1] || '';

/** 表 id（与 packages/contracts/src/tables.ts 一致；生产 PG 里按 table_id 查真实表名） */
const T_NOTE_BODY = 'tblnotebody000001'; // 笔记正文表
const T_CONVERT_LOG = 'tblMy5LrwR3YbLxf'; // 笔记转换记录
const T_SYSTEM_CONFIG = 'tblqeuKQlsuOIeUy'; // 系统配置表

/** 目标模块 key → 表**名**（按名字查，避免 DEV/生产 table id 两套的问题） */
const MODULE_TABLE_NAME = {
  homeSchoolComms: '家校沟通表',
  dailyFollowups: '日常跟进表',
  studentObservations: '学生观察表',
  sourceFollowups: '生源跟进记录表',
  meetingMinutes: '会议纪要表',
  alumniFollowups: '校友长期跟进表',
  practiceActivities: '实践活动表',
  stageEvaluations: '阶段评价表',
  grades: '学业成绩表',
  studentAttendances: '考勤记录表',
  idpPlans: 'IDP方案',
};

/** 与 contracts `DEFAULT_CONVERT_FIELDS` 的 audioField 保持一致（配置里没配时的兜底） */
const DEFAULT_AUDIO_FIELD = {
  homeSchoolComms: '沟通附件清单',
  dailyFollowups: '沟通附件清单',
  studentObservations: '沟通附件清单',
  sourceFollowups: '沟通附件清单',
  meetingMinutes: '会议附件',
  alumniFollowups: '跟进附件',
  practiceActivities: '活动证明',
  stageEvaluations: '评价附件',
  grades: '成绩附件',
  studentAttendances: '佐证附件',
  idpPlans: '原始文档',
};

function loadEnv(path) {
  if (!fs.existsSync(path)) {
    console.error(`env 文件不存在: ${path}`);
    process.exit(1);
  }
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

/** 附件字段值 → 数组（正文表里是 jsonb 数组，历史数据也可能是 JSON 字符串） */
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return [];
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const dsn = env.DATABASE_URL;
  if (!dsn) {
    console.error('env 里没有 DATABASE_URL');
    process.exit(1);
  }
  const client = new Client({ connectionString: dsn });
  await client.connect();

  /** table_id → 真实 sql 表名 */
  const tableName = async (tableId) => {
    const r = await client.query('select sql_table from acms_tables where table_id = $1', [tableId]);
    return r.rows[0]?.sql_table ?? null;
  };

  const noteBodyTbl = await tableName(T_NOTE_BODY);
  const convertLogTbl = await tableName(T_CONVERT_LOG);
  const sysCfgTbl = await tableName(T_SYSTEM_CONFIG);
  if (!noteBodyTbl || !convertLogTbl || !sysCfgTbl) {
    console.error('关键表未在 acms_tables 注册', { noteBodyTbl, convertLogTbl, sysCfgTbl });
    process.exit(1);
  }

  // ① 转换配置：moduleKey → audioField（以配置为准，配置没配再退回内置默认）
  const cfgRow = await client.query(
    `select data->>'配置值' as v from ${sysCfgTbl} where data->>'配置键' = 'note_convert_config'`,
  );
  const audioFieldByKey = { ...DEFAULT_AUDIO_FIELD };
  try {
    const parsed = JSON.parse(cfgRow.rows[0]?.v ?? '{}');
    for (const it of parsed.items ?? []) {
      if (it?.key && it.audioField) audioFieldByKey[it.key] = String(it.audioField);
    }
  } catch {
    console.warn('转换配置解析失败，使用内置默认字段名');
  }

  // ② 转换记录：目标记录ID 非空的（没回填到目标记录的转换，没有可补的对象）
  const logs = await client.query(
    `select id,
            data->>'笔记ID'      as note_id,
            data->>'笔记标题'    as note_title,
            data->>'模块KEY'     as module_key,
            data->>'目标模块'    as module_label,
            data->>'目标记录ID'  as target_id
       from ${convertLogTbl}
      where coalesce(data->>'目标记录ID','') <> ''
      order by created_at`,
  );

  console.log(`转换记录（有目标记录）: ${logs.rows.length} 条`);
  const stats = { done: 0, skippedNoAudio: 0, skippedNoField: 0, skippedNoTable: 0, skippedHasAudio: 0, failed: 0 };

  for (const row of logs.rows) {
    if (ONLY_LOG_ID && row.id !== ONLY_LOG_ID) continue;
    const tag = `${row.module_label || row.module_key} ← ${String(row.note_title ?? '').slice(0, 22)}`;
    if (!row.note_id || !row.target_id) continue;

    const field = audioFieldByKey[row.module_key];
    if (!field) {
      console.log(`⏭  ${tag}：模块 ${row.module_key} 没有录音附件字段映射，跳过`);
      stats.skippedNoField++;
      continue;
    }
    const tblName = MODULE_TABLE_NAME[row.module_key];
    if (!tblName) {
      console.log(`⏭  ${tag}：模块 ${row.module_key} 未登记目标表名，跳过`);
      stats.skippedNoTable++;
      continue;
    }
    // 按**表名**查真实 PG 表名：目标模块多是飞书老表，DEV 表 id 与生产表 id 不同
    // （要靠 TABLE_ID_MAP 转换），按名字查能绕开这两套 id。
    const targetTbl = (
      await client.query('select sql_table from acms_tables where name = $1', [tblName])
    ).rows[0]?.sql_table;
    if (!targetTbl) {
      console.log(`⏭  ${tag}：表「${tblName}」未注册，跳过`);
      stats.skippedNoTable++;
      continue;
    }

    // 源笔记的音频
    const src = await client.query(
      `select data->'音频附件' as att, data->>'音频状态' as st from ${noteBodyTbl} where id = $1`,
      [row.note_id],
    );
    const audio = toArray(src.rows[0]?.att);
    if (!audio.length || !audio[0]?.file_token) {
      console.log(`⏭  ${tag}：源笔记没有已落库的录音（音频状态=${src.rows[0]?.st ?? '—'}），跳过`);
      stats.skippedNoAudio++;
      continue;
    }

    // 目标记录现有附件
    const tgt = await client.query(`select data->$2 as cur from ${targetTbl} where id = $1`, [
      row.target_id,
      field,
    ]);
    if (!tgt.rows.length) {
      console.log(`⏭  ${tag}：目标记录 ${row.target_id} 不存在（可能已删），跳过`);
      stats.failed++;
      continue;
    }
    const cur = toArray(tgt.rows[0].cur);
    const have = new Set(cur.map((a) => String(a?.file_token ?? '')));
    const missing = audio.filter((a) => a?.file_token && !have.has(String(a.file_token)));
    if (!missing.length) {
      console.log(`✅ ${tag}：目标记录已有该录音，无需处理`);
      stats.skippedHasAudio++;
      continue;
    }

    const merged = [...cur, ...missing];
    console.log(
      `→ ${tag}：写入「${field}」 ${missing.map((a) => a.name ?? a.file_token.slice(0, 16)).join(', ')}` +
        `（原有 ${cur.length} 个附件）`,
    );
    if (APPLY) {
      // 只更新这一个字段：`data || jsonb_build_object(...)` 是合并语义，
      // 目标记录的其它字段（issue 里人工填的内容）原样不动。
      await client.query(
        `update ${targetTbl}
            set data = coalesce(data,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb),
                updated_at = now()
          where id = $1`,
        [row.target_id, field, JSON.stringify(merged)],
      );
    }
    stats.done++;
  }

  console.log('\n===== 汇总 =====');
  console.log(`${APPLY ? '已写入' : '待写入（dry-run）'}: ${stats.done}`);
  console.log(`跳过 · 目标已含录音: ${stats.skippedHasAudio}`);
  console.log(`跳过 · 源笔记无录音: ${stats.skippedNoAudio}`);
  console.log(`跳过 · 无字段映射 / 无目标表: ${stats.skippedNoField + stats.skippedNoTable}`);
  console.log(`异常 · 目标记录不存在: ${stats.failed}`);
  if (!APPLY) console.log('\n（dry-run，未写库。确认无误后加 --apply 执行）');
  await client.end();
}

main().catch((e) => {
  console.error('执行失败:', e);
  process.exit(1);
});
