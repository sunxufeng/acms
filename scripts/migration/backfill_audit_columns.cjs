#!/usr/bin/env node
/**
 * 审计四件套「创建人 / 创建时间 / 更新人 / 更新时间」迁移与回填。
 *
 * 背景（2026-09-10）：
 *  - PG 每张业务表都有 created_at / updated_at 物理列，但**没有** created_by / updated_by；
 *  - 部分表 data 里存着飞书自动字段（t1001 创建时间 / t1002 更新时间 / t1003 创建人 /
 *    t1004 修改人）的历史快照，2026-09-07 切 PG 后这些键**再无人写入**，新建记录全为空；
 *  - 更糟的是「创建人」是飞书人员对象数组 [{id,name,...}]，直接取值会得到 [object Object]。
 *
 * 本脚本做三件事（均幂等）：
 *  1. 给所有业务表补 created_by / updated_by 列；
 *  2. 把 data 里的历史审计值搬到物理列（时间按毫秒/秒时间戳转 timestamptz，
 *     人员取对象数组里的 id 作为稳定 key），然后**从 data 删除这四个键**，
 *     保证唯一真源是物理列，不再出现新旧两份值打架；
 *  3. 对仍无创建人的记录做兜底：先按审计日志（记录标识 → 操作人）精确回填，
 *     再按表归属标 system:<来源>，实在识别不了保留 system:unknown。
 *
 * 使用（在服务器 /opt/acms/repo 下）：
 *   DRY=1 sudo DATABASE_URL="..." node scripts/migration/backfill_audit_columns.cjs   # 演练
 *   sudo DATABASE_URL="..." node scripts/migration/backfill_audit_columns.cjs         # 执行
 *
 * 执行前自动备份「将被改写的历史值」到 /opt/acms/data/backup/。
 */
const fs = require('fs');
let Client;
try {
  ({ Client } = require('pg'));
} catch {
  // pnpm 严格结构下 require('pg') 解析不到，回落到 .pnpm 实际路径（生产实测有效）
  try {
    ({ Client } = require('/opt/acms/repo/node_modules/.pnpm/pg@8.23.0/node_modules/pg'));
  } catch {
    console.error('需要 pg 模块：请在服务器 /opt/acms/repo 下运行');
    process.exit(1);
  }
}

const DRY = process.env.DRY === '1';
const BACKUP_DIR = '/opt/acms/data/backup';
const AUDIT_KEYS = ['创建人', '创建时间', '更新人', '更新时间'];
const SAFE_TABLE = /^t_[a-z0-9]+$/;

/** 无历史值可依时，按表归属推断的后台来源（比笼统 system:migration 更可排查） */
const TABLE_SOURCE = [
  { match: '邮件归档', source: 'system:mail-archive' },
  { match: '邮件账户', source: 'system:mail-archive' },
  { match: '笔记配置映射', source: 'system:getnote-sync' },
  { match: '笔记转换记录', source: 'system:getnote-convert' },
  { match: '笔记关联', source: 'system:getnote-convert' },
  { match: 'AI-', source: 'system:ai-automation' },
];

/**
 * 以数据库真实状态复查「已识别创建人」的记录数。
 * 为什么需要：循环内的计数变量在 DRY / 异常分支下可能与实际写入不一致，
 * 汇报数字必须以复查结果为准，否则会误判迁移失败。
 */
async function reportMigrated(c, tables, label) {
  let rows = 0;
  let tbls = 0;
  for (const t of tables) {
    if (!SAFE_TABLE.test(t.sql_table)) continue;
    const r = await c.query(
      `SELECT count(*) FILTER (WHERE created_by <> 'system:unknown')::int AS n
         FROM public.${t.sql_table}`,
    );
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) {
      rows += n;
      tbls++;
    }
  }
  console.log(`${label}：${tbls} 张表 / ${rows} 条已有明确创建人`);
}

/** 从飞书人员字段（对象数组 / 对象 / 字符串）里取稳定 id */
const PERSON_ID_SQL = (key) => `
  CASE
    WHEN jsonb_typeof(data->'${key}') = 'array'
      THEN COALESCE(data->'${key}'->0->>'id', data->'${key}'->0->>'name')
    WHEN jsonb_typeof(data->'${key}') = 'object'
      THEN COALESCE(data->'${key}'->>'id', data->'${key}'->>'name')
    WHEN jsonb_typeof(data->'${key}') = 'string' AND data->>'${key}' <> ''
      THEN data->>'${key}'
    ELSE NULL
  END`;

/** 时间戳字段（毫秒 / 秒 / ISO 字符串）转 timestamptz */
const TS_SQL = (key) => `
  CASE
    WHEN jsonb_typeof(data->'${key}') = 'number'
      THEN to_timestamp((data->>'${key}')::bigint / CASE WHEN length(data->>'${key}') > 12 THEN 1000.0 ELSE 1.0 END)
    WHEN data->>'${key}' ~ '^[0-9]+$'
      THEN to_timestamp((data->>'${key}')::bigint / CASE WHEN length(data->>'${key}') > 12 THEN 1000.0 ELSE 1.0 END)
    ELSE NULLIF(data->>'${key}', '')::timestamptz
  END`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const tables = (await c.query(`SELECT table_id, name, sql_table FROM acms_tables ORDER BY name`)).rows;
  console.log(`共 ${tables.length} 张表，DRY=${DRY ? '1（演练）' : '0（执行）'}`);

  // ---------- 步骤 1：补列 ----------
  let added = 0;
  for (const t of tables) {
    if (!SAFE_TABLE.test(t.sql_table)) continue;
    try {
      await c.query(
        `ALTER TABLE public.${t.sql_table}
           ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'system:unknown',
           ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT 'system:unknown'`,
      );
      added++;
    } catch (e) {
      console.warn(`  补列失败 ${t.name}: ${e.message}`);
    }
  }
  console.log(`步骤1 补列完成：${added} 张表`);

  // ---------- 步骤 2：历史值搬到物理列 ----------
  const backup = [];
  let movedRows = 0;
  let movedTables = 0;
  for (const t of tables) {
    if (!SAFE_TABLE.test(t.sql_table)) continue;
    const has = await c.query(
      `SELECT count(*)::int AS n FROM public.${t.sql_table} WHERE data ?| $1::text[]`,
      [AUDIT_KEYS],
    );
    const n = has.rows[0]?.n ?? 0;
    if (n === 0) continue;
    movedTables++;

    if (DRY) {
      console.log(`  [演练] ${t.name}: ${n} 条含历史审计键`);
      continue;
    }
    // 备份将被删除的历史值
    const before = await c.query(
      `SELECT id, data->'创建人' AS 创建人, data->'创建时间' AS 创建时间,
              data->'更新人' AS 更新人, data->'更新时间' AS 更新时间
         FROM public.${t.sql_table} WHERE data ?| $1::text[]`,
      [AUDIT_KEYS],
    );
    for (const r of before.rows) backup.push({ table: t.name, ...r });

    await c.query(
      `UPDATE public.${t.sql_table} SET
         created_at = COALESCE(${TS_SQL('创建时间')}, created_at),
         updated_at = COALESCE(${TS_SQL('更新时间')}, updated_at),
         created_by = COALESCE(${PERSON_ID_SQL('创建人')}, created_by),
         updated_by = COALESCE(${PERSON_ID_SQL('更新人')}, updated_by),
         data = data - '创建人'::text - '创建时间'::text - '更新人'::text - '更新时间'::text
       WHERE data ?| $1::text[]`,
      [AUDIT_KEYS],
    );
    movedRows += n;
    console.log(`  ${t.name}: ${n} 条历史审计值已搬到物理列`);
  }
  console.log(`步骤2 迁移完成：${movedTables} 张表 / ${movedRows} 条`);
  await reportMigrated(c, tables, '步骤2 复查');

  if (backup.length) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const p = `${BACKUP_DIR}/audit_fields_before_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(p, JSON.stringify(backup, null, 2));
    console.log(`  历史值已备份：${p}（${backup.length} 条）`);
  }

  if (DRY) {
    await c.end();
    console.log('演练结束，未做任何写入。');
    return;
  }

  // ---------- 步骤 3：兜底识别创建人 ----------
  // 3a. 姓名 → openId（审计日志里的「操作人」存的是姓名字符串）
  const userT = (
    await c.query(`SELECT sql_table FROM acms_tables WHERE name LIKE '系统用户%' LIMIT 1`)
  ).rows[0]?.sql_table;
  const nameToId = new Map();
  if (userT) {
    const r = await c.query(
      `SELECT data->>'姓名' AS nm, data->>'飞书 Open ID' AS oid FROM public.${userT}`,
    );
    for (const x of r.rows) if (x.nm && x.oid) nameToId.set(x.nm, x.oid);
  }

  // 3b. 审计日志匹配：记录标识 → 最早一次「创建」的操作人
  const auditTables = (await c.query(`SELECT sql_table, name FROM acms_tables WHERE name LIKE '%审计%'`)).rows;
  const ridToActor = new Map();
  for (const a of auditTables) {
    const r = await c.query(
      `SELECT DISTINCT ON (data->>'记录标识')
              data->>'记录标识' AS rid,
              COALESCE(data->'操作人'->0->>'id', data->'操作人'->>'name', data->>'操作人') AS actor
         FROM public.${a.sql_table}
        WHERE (data->>'记录标识') IS NOT NULL AND (data->>'操作人') IS NOT NULL
          AND (data->>'操作类型') IN ('创建','新增')
        ORDER BY data->>'记录标识', created_at ASC`,
    );
    for (const x of r.rows) {
      if (!x.rid || !x.actor || ridToActor.has(x.rid)) continue;
      ridToActor.set(x.rid, nameToId.get(x.actor) ?? x.actor);
    }
  }
  console.log(`步骤3 审计日志可匹配记录：${ridToActor.size} 条`);

  let byAudit = 0;
  let byTable = 0;
  for (const t of tables) {
    if (!SAFE_TABLE.test(t.sql_table)) continue;
    const pending = await c.query(
      `SELECT id FROM public.${t.sql_table} WHERE created_by = 'system:unknown'`,
    );
    if (!pending.rows.length) continue;
    let hit = 0;
    for (const row of pending.rows) {
      const actor = ridToActor.get(row.id);
      if (actor) {
        await c.query(`UPDATE public.${t.sql_table} SET created_by = $1 WHERE id = $2`, [actor, row.id]);
        hit++;
      }
    }
    byAudit += hit;

    // 仍未识别的，按表归属标后台来源
    const src = TABLE_SOURCE.find((s) => t.name.includes(s.match))?.source;
    if (src) {
      const r = await c.query(
        `UPDATE public.${t.sql_table} SET created_by = $1, updated_by = COALESCE(NULLIF(updated_by,'system:unknown'), $1)
          WHERE created_by = 'system:unknown'`,
        [src],
      );
      byTable += r.rowCount ?? 0;
    }
    if (hit) console.log(`  ${t.name}: 审计日志回填 ${hit} 条`);
  }
  console.log(`步骤3 兜底完成：审计匹配 ${byAudit} 条，按表来源标记 ${byTable} 条`);

  // ---------- 汇总 ----------
  let total = 0;
  let unknown = 0;
  for (const t of tables) {
    if (!SAFE_TABLE.test(t.sql_table)) continue;
    const r = await c.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE created_by = 'system:unknown')::int AS u
         FROM public.${t.sql_table}`,
    );
    total += r.rows[0].n;
    unknown += r.rows[0].u;
  }
  console.log(`\n完成。全库 ${total} 条记录，其中创建人未识别 ${unknown} 条（${((unknown / Math.max(total, 1)) * 100).toFixed(1)}%）`);
  await c.end();
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
