#!/usr/bin/env node
/**
 * 用「笔记转换记录 → 源笔记归属人」回填业务记录的「记录人 / 负责人」。
 *
 * 背景（2026-09-19 峰哥要求）：从笔记转出记录时，「记录人 / 负责人」应当等于**笔记归属人**，
 * 而不是当时的登录用户；历史数据里这两个字段有的是空的（也有的是错误的登录用户），需要一并纠正。
 *
 * 溯源链：`笔记转换记录.目标记录ID` → 业务记录；
 *         `笔记转换记录.笔记ID`   → `笔记正文表.笔记ID` → `归属人`。
 *
 * 用法：
 *   node scripts/backfill_owner_from_notes.mjs            # dry-run（列出将改哪些行）
 *   node scripts/backfill_owner_from_notes.mjs --apply    # 实际写入
 *
 * ⚠️ 幂等：只填空字段（`coalesce(data->>字段,'') = ''`），重复执行结果一致。
 * ⚠️ 只动**为空**的字段，**不覆盖**已有值 —— 已有值可能是人工修正过的（比如手填的准确责任人），
 *    自动回填把它冲掉是不可逆的。需要强制覆盖时手工执行 SQL。
 */
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const PG_ARGS = ['-h', '127.0.0.1', '-U', 'acms', '-d', 'acms-prd'];
const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'season69130' };

const CONV = 't_tblmy5lrwr3yblxf'; // 笔记转换记录
const BODY = 't_tblnotebody000001'; // 笔记正文表（有「归属人」）
const STUDENT_RECORD = 't_tbljjbchyx9uhbbb'; // 日常跟进表 = 学生记录主表
const SOURCE_FOLLOWUP = 't_tbldeuatdoixkjzu'; // 生源跟进记录表 = 招生跟进
const PRACTICE = 't_tbloitwcvobskeuu'; // 实践活动表
const STAGE_EVAL = 't_tblhk6r8usy6bxv4'; // 阶段评价表
const ALUMNI = 't_tblk02ggjnalp1gp'; // 校友长期跟进表
const MEETING = 't_tblmtg0000000001'; // 会议纪要表

/**
 * 模块 KEY → 目标表 + 回填字段。
 * ⚠️ 合并后「学生记录」三种类型的记录都落在同一张表、同一个字段上（都是「沟通人」），
 *    但转换记录里的 模块KEY 仍是**旧 key**（合并前写下的留痕），所以三个都要列出。
 * ⚠️ 只收「这个人 = 这条记录的责任人」语义的字段 —— 会议纪要的「参会/缺席/列席」是多人名单，
 *    默认塞一个人是错的，不收。
 */
const TARGETS = [
  { module: 'dailyFollowups', table: STUDENT_RECORD, field: '沟通人', label: '学生记录 · 记录人' },
  { module: 'homeSchoolComms', table: STUDENT_RECORD, field: '沟通人', label: '学生记录 · 记录人' },
  { module: 'studentObservations', table: STUDENT_RECORD, field: '沟通人', label: '学生记录 · 记录人' },
  { module: 'studentRecords', table: STUDENT_RECORD, field: '沟通人', label: '学生记录 · 记录人' },
  { module: 'sourceFollowups', table: SOURCE_FOLLOWUP, field: '跟进负责人', label: '招生跟进 · 负责人' },
  { module: 'practiceActivities', table: PRACTICE, field: '活动负责人', label: '实践活动 · 负责人' },
  { module: 'stageEvaluations', table: STAGE_EVAL, field: '评价人', label: '阶段评价 · 评价人' },
  { module: 'alumniFollowups', table: ALUMNI, field: '跟进负责人', label: '校友跟进 · 负责人' },
  { module: 'meetingMinutes', table: MEETING, field: '主持人', label: '会议纪要 · 主持人' },
  { module: 'meetingMinutes', table: MEETING, field: '记录人', label: '会议纪要 · 记录人' },
];

function rows(sql) {
  const out = execFileSync('psql', [...PG_ARGS, '-t', '-A', '-F', '\u0001', '-c', sql], {
    env: PSQL_ENV,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('\u0001'));
}

function run(sql, label) {
  if (!APPLY) {
    console.log(`  [dry-run] ${label}`);
    return;
  }
  execFileSync('psql', [...PG_ARGS, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: PSQL_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`  [done]    ${label}`);
}

const bak = (t) => `bak_owner_${t.replace(/^t_/, '').slice(0, 12)}_20260919`;

console.log(`=== 回填「记录人 / 负责人」= 源笔记归属人 ${APPLY ? '（APPLY）' : '（dry-run）'} ===\n`);

// ① 备份（幂等：已存在则跳过，重复执行不会覆盖第一次的备份）
const DATA_TABLES = [...new Set(TARGETS.map((t) => t.table))];
console.log('① 备份');
const has = (t) => rows(`select to_regclass('public.${t}') is not null;`)[0]?.[0] === 't';
for (const t of DATA_TABLES) {
  const b = bak(t);
  if (has(b)) {
    console.log(`  ${b}：已存在，跳过`);
    continue;
  }
  run(`create table ${b} as select * from ${t};`, `备份 ${t} → ${b}`);
}

// ② 逐模块列出待回填项
console.log('\n② 待回填清单');
let total = 0;
for (const t of TARGETS) {
  // 只取「目标记录ID 非空 + 当前字段为空 + 笔记有归属人」的行
  const sql = `
    select c.data->>'目标记录ID' as rec_id,
           coalesce(b.data->>'归属人','') as owner,
           r.data->>'${t.field}' as cur
      from ${CONV} c
      join ${BODY} b on b.data->>'笔记ID' = c.data->>'笔记ID'
      join ${t.table} r on r.id = c.data->>'目标记录ID'
     where c.data->>'模块KEY' = '${t.module}'
       and coalesce(c.data->>'目标记录ID','') <> ''
       and coalesce(b.data->>'归属人','') <> ''
     order by rec_id;`;
  const list = rows(sql);
  const todo = list.filter((r) => !String(r[2] ?? '').trim());
  if (!list.length) continue;
  console.log(`  ${t.label}（模块 ${t.module}）：命中 ${list.length} 条，其中待填 ${todo.length} 条`);
  for (const [id, owner, cur] of list) {
    const mark = String(cur ?? '').trim() ? '已有值·跳过' : '将回填';
    console.log(`    ${mark}  ${id}  ←  ${owner}`);
  }
  total += todo.length;
}
console.log(`\n合计待回填：${total} 条`);

// ③ 写入
console.log('\n③ 写入（只填空字段）');
for (const t of TARGETS) {
  const sql = `
    update ${t.table} r
       set data = r.data || jsonb_build_object('${t.field}', nb.owner), updated_at = now()
      from (
        select c.data->>'目标记录ID' as rec_id, nullif(b.data->>'归属人','') as owner
          from ${CONV} c
          join ${BODY} b on b.data->>'笔记ID' = c.data->>'笔记ID'
         where c.data->>'模块KEY' = '${t.module}'
           and coalesce(c.data->>'目标记录ID','') <> ''
      ) nb
     where r.id = nb.rec_id
       and coalesce(r.data->>'${t.field}','') = ''
       and nb.owner is not null;`;
  run(sql, `${t.label}（模块 ${t.module}）`);
}

// ④ 回读复核
console.log('\n④ 回读复核');
const seenField = new Set();
for (const t of TARGETS) {
  const key = `${t.table}.${t.field}`;
  if (seenField.has(key)) continue;
  seenField.add(key);
  const [n, emptyN] = rows(
    `select count(*), count(*) filter (where coalesce(data->>'${t.field}','') = '') from ${t.table};`,
  )[0];
  console.log(`  ${t.label}（${t.table}.${t.field}）：共 ${n} 条，为空 ${emptyN} 条`);
  // 只对「本次碰过的表」打样本，避免把 700 多条笔记的表刷屏
  if (Number(n) > 0 && Number(n) <= 30) {
    const sample = rows(
      `select left(id,24) || ' → ' || coalesce(nullif(data->>'${t.field}',''),'(空)') from ${t.table} order by updated_at desc limit 6;`,
    );
    for (const [s] of sample) console.log(`      ${s}`);
  }
}
console.log(APPLY ? '\n✅ 已执行' : '\n（dry-run 结束，加 --apply 才会真正写库）');
