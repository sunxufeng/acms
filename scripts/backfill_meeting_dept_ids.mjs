#!/usr/bin/env node
/**
 * 会议纪要「部门」字段：部门名（旧）→ open_department_id 数组（新），并按需派生「可见部门」。
 *
 * 背景（2026-09-19 会议纪要表单改版）：
 *   峰哥要求「部门」可多选（部门树 + 复选框级联）。改多选后值形态从**字符串**变成**数组**，
 *   而可见性判据原来拿「部门」做**等值匹配**——
 *   SQL 侧是 `data->>'部门' = '学术轨'`，字段变成数组后该表达式返回 `["od-…"]` 这段 JSON 文本，
 *   **永远不命中** ⇒ 记录对同事全部隐身（创建者自己靠「创建人ID」那条独立分支还能看到），
 *   而且不报任何错。所以判据已一并改成「可见部门 contains 我的部门 id」（见 meeting-visibility.ts），
 *   本脚本负责把**存量数据**搬到新口径上。
 *
 * 用法：
 *   node scripts/backfill_meeting_dept_ids.mjs            # dry-run（只打印将要改什么）
 *   node scripts/backfill_meeting_dept_ids.mjs --apply    # 实际写入
 *
 * ⚠️ 幂等：① 只处理「部门」还是**字符串**的记录（数组形态直接跳过）；
 *          ② 「可见部门」只在为空时派生。重复执行结果一致。
 * ⚠️ 带备份：首次执行建 `bak_mtg_dept_20260919`（整表快照），可回滚。
 */
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const PG_ARGS = ['-h', '127.0.0.1', '-U', 'acms', '-d', 'acms-prd'];
const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'season69130' };

const MEETING = 't_tblmtg0000000001'; // 会议纪要表
const DEPT = 't_tbldept0000001'; // 部门表（记录 id 就是 open_department_id）
const BACKUP = 'bak_mtg_dept_20260919';

function psql(sql) {
  const out = execFileSync('psql', [...PG_ARGS, '-t', '-A', '-F', '\t', '-c', sql], {
    env: PSQL_ENV,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

function psqlFile(sql) {
  // 多语句 / 需要事务的走 stdin（psql -c 不做变量展开，也难表达 DO 块）
  const out = execFileSync('psql', [...PG_ARGS, '-t', '-A', '-f', '-'], {
    env: PSQL_ENV,
    input: sql,
    encoding: 'utf8',
  });
  return out;
}

console.log(`会议纪要「部门」字段回填${APPLY ? '（APPLY）' : '（dry-run）'}\n`);

// ── ① 备份 ─────────────────────────────────────────────
if (APPLY) {
  psqlFile(`
    create table if not exists ${BACKUP} as
      select id, data, now() as backed_at from ${MEETING};
  `);
  const [b] = psql(`select count(*) from ${BACKUP};`);
  console.log(`① 备份表 ${BACKUP}：${b?.[0]} 行`);
} else {
  console.log(`① 备份：dry-run 不建表（apply 时会建 ${BACKUP}）`);
}

// ── ② 现状 ─────────────────────────────────────────────
console.log('\n② 现状');
const rows = psql(
  `select left(id,22) || ' | 部门=' || coalesce((data->'部门')::text,'(无)')
          || ' | 类型=' || coalesce(jsonb_typeof(data->'部门'),'null')
          || ' | 范围=' || coalesce(data->>'可见范围','(空)')
          || ' | 可见部门=' || coalesce((data->'可见部门')::text,'(无)')
     from ${MEETING} order by updated_at;`,
);
for (const r of rows) console.log('   ' + r[0]);

// ── ③ 部门名 → id 数组 ─────────────────────────────────
const pending = psql(
  `select r.id || ' | ' || (r.data->>'部门') || ' → ' || coalesce(d.data->>'open_department_id','(查不到)')
     from ${MEETING} r
     left join ${DEPT} d
       on d.data->>'name' = r.data->>'部门' and d.data->>'open_department_id' like 'od-%'
    where jsonb_typeof(r.data->'部门') = 'string'
      and coalesce(r.data->>'部门','') <> ''
    order by r.updated_at;`,
);
console.log(`\n③ 待转换「部门」为 id 数组：${pending.length} 条`);
for (const p of pending) console.log('   ' + p[0]);

if (pending.length) {
  if (APPLY) {
    const res = psql(
      `update ${MEETING} r
          set data = r.data || jsonb_build_object('部门', to_jsonb(array[sub.od_id])),
              updated_at = now()
         from (
           select r2.id as rid,
                  (select d.data->>'open_department_id'
                     from ${DEPT} d
                    where d.data->>'name' = r2.data->>'部门'
                      and d.data->>'open_department_id' like 'od-%'
                    limit 1) as od_id
             from ${MEETING} r2
            where jsonb_typeof(r2.data->'部门') = 'string'
              and coalesce(r2.data->>'部门','') <> ''
         ) sub
        where r.id = sub.rid and sub.od_id is not null;`,
    );
    console.log('   已执行 update（UPDATE 1 表示一条）');
  } else {
    console.log('   （dry-run，未写入）');
  }
}

// ── ④ 「部门内可见」且可见部门为空 ⇒ 由「部门」派生 ──────
const needVisible = psql(
  `select id || ' | 部门=' || coalesce((data->'部门')::text,'(无)')
     from ${MEETING}
    where data->>'可见范围' = '部门内可见'
      and jsonb_typeof(data->'部门') = 'array'
      and coalesce(jsonb_array_length(data->'可见部门'), 0) = 0
    order by updated_at;`,
);
console.log(`\n④ 需派生「可见部门」（部门内可见 + 可见部门为空）：${needVisible.length} 条`);
for (const p of needVisible) console.log('   ' + p[0]);
if (needVisible.length) {
  if (APPLY) {
    psql(
      `update ${MEETING}
          set data = data || jsonb_build_object('可见部门', data->'部门'),
              updated_at = now()
        where data->>'可见范围' = '部门内可见'
          and jsonb_typeof(data->'部门') = 'array'
          and coalesce(jsonb_array_length(data->'可见部门'), 0) = 0;`,
    );
    console.log('   已执行 update');
  } else {
    console.log('   （dry-run，未写入）');
  }
}

// ── ⑤ 复核 ─────────────────────────────────────────────
console.log('\n⑤ 复核（回读）');
const after = psql(
  `select left(id,22) || ' | 部门=' || coalesce((data->'部门')::text,'(无)')
          || ' | 类型=' || coalesce(jsonb_typeof(data->'部门'),'null')
          || ' | 范围=' || coalesce(data->>'可见范围','(空)')
          || ' | 可见部门=' || coalesce((data->'可见部门')::text,'(无)')
     from ${MEETING} order by updated_at;`,
);
for (const r of after) console.log('   ' + r[0]);

const [bad] = psql(
  `select count(*) from ${MEETING}
    where jsonb_typeof(data->'部门') <> 'array' or jsonb_typeof(data->'部门') is null;`,
);
console.log(`\n仍不是数组形态的「部门」：${bad?.[0]} 条（应为 0）`);
const [unknown] = psql(
  `select count(*) from ${MEETING}
    where data->>'可见范围' in ('部门内可见','指定部门可见')
      and coalesce(jsonb_array_length(data->'可见部门'), 0) = 0;`,
);
console.log(`部门类可见范围但「可见部门」为空：${unknown?.[0]} 条（应为 0）`);
