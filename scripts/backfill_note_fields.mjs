#!/usr/bin/env node
/**
 * 按「笔记转换记录 → 源笔记」补齐业务记录的主题 / 时间，并把「关联学生编号」关联上学生档案。
 *
 * 背景（2026-09-19 峰哥要求）：
 *   - 笔记的**标题**应当成为记录的「主题」，笔记的**创建时间**应当成为记录的「时间」
 *     （此前主题靠从总结正文里正则抽「沟通主题：」，抽不到就空着）
 *   - 学生列要能点进**学生档案**，而学生记录里存的是学生**姓名文本**，
 *     需要回填「关联学生编号」（type=18 单向关联，指向学生档案表）
 *
 * 用法：
 *   node scripts/backfill_note_fields.mjs            # dry-run
 *   node scripts/backfill_note_fields.mjs --apply    # 实际写入
 *
 * ⚠️ 幂等：只填空字段，重复执行结果一致。
 * ⚠️ 只填空、**不覆盖**已有值 —— 已有值可能是人工修正过的。
 * ⚠️ 时区：笔记创建时间是毫秒时间戳，转 `YYYY-MM-DDTHH:mm` 必须按 **Asia/Shanghai**，
 *    换 UTC 会差 8 小时（用 `toISOString()` 就会踩这个）。
 */
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const PG_ARGS = ['-h', '127.0.0.1', '-U', 'acms', '-d', 'acms-prd'];
const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'season69130' };

const CONV = 't_tblmy5lrwr3yblxf'; // 笔记转换记录
const BODY = 't_tblnotebody000001'; // 笔记正文表（标题 / 笔记创建时间）
const PROFILE = 't_tbl2pevecjhnm8la'; // 学生档案表
const STUDENT_RECORD = 't_tbljjbchyx9uhbbb'; // 学生记录主表
const SOURCE_FOLLOWUP = 't_tbldeuatdoixkjzu'; // 生源跟进记录表（招生跟进）

/**
 * ⚠️ 回填**必须带上模块**，不能让一条转换记录去写别的模块的记录：
 * 同一张学生记录主表上有三类记录，而它们的转换记录带的是各自的旧模块 KEY。
 */
const TARGETS = [
  {
    label: '学生记录',
    table: STUDENT_RECORD,
    themeField: '沟通主题',
    timeField: '沟通时间',
    modules: ['dailyFollowups', 'homeSchoolComms', 'studentObservations', 'studentRecords'],
  },
  {
    label: '招生跟进',
    table: SOURCE_FOLLOWUP,
    themeField: '沟通主题',
    timeField: '跟进时间',
    modules: ['sourceFollowups'],
  },
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

const bak = (t) => `bak_nb_${t.replace(/^t_/, '').slice(0, 12)}_20260919`;
const modList = (t) => t.modules.map((m) => `'${m}'`).join(',');

console.log(`=== 回填 主题 / 时间 / 学生关联 ${APPLY ? '（APPLY）' : '（dry-run）'} ===\n`);

console.log('① 备份');
const has = (t) => rows(`select to_regclass('public.${t}') is not null;`)[0]?.[0] === 't';
for (const t of [...new Set(TARGETS.map((x) => x.table))]) {
  const b = bak(t);
  if (has(b)) {
    console.log(`  ${b}：已存在，跳过`);
    continue;
  }
  run(`create table ${b} as select * from ${t};`, `备份 ${t} → ${b}`);
}

console.log('\n② 待回填清单');
for (const t of TARGETS) {
  const base = `
      from ${CONV} c
      join ${BODY} b on b.data->>'笔记ID' = c.data->>'笔记ID'
      join ${t.table} r on r.id = c.data->>'目标记录ID'
     where c.data->>'模块KEY' in (${modList(t)})
       and coalesce(c.data->>'目标记录ID','') <> ''`;
  const list = rows(`
    select c.data->>'目标记录ID',
           coalesce(nullif(b.data->>'标题',''),'(无标题)'),
           coalesce(b.data->>'笔记创建时间',''),
           coalesce(nullif(r.data->>'${t.themeField}',''),'(空)'),
           coalesce(nullif(r.data->>'${t.timeField}',''),'(空)')
    ${base}
     order by c.data->>'目标记录ID';`);
  console.log(`  ${t.label}：命中 ${list.length} 条`);
  for (const [id, title, ms, curTheme, curTime] of list) {
    console.log(`    ${id}`);
    console.log(`      主题 ${curTheme === '(空)' ? '将回填' : '已有值·跳过'} ← 「${title.slice(0, 26)}」`);
    console.log(`      时间 ${curTime === '(空)' ? '将回填' : '已有值·跳过'} ← ${ms ? new Date(Number(ms)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '(无)'}`);
  }
}

console.log('\n③ 写入');
for (const t of TARGETS) {
  const base = `
      from (
        select c.data->>'目标记录ID' as rec_id, nullif(b.data->>'标题','') as title
          from ${CONV} c
          join ${BODY} b on b.data->>'笔记ID' = c.data->>'笔记ID'
         where c.data->>'模块KEY' in (${modList(t)})
           and coalesce(c.data->>'目标记录ID','') <> ''
      ) nb
     where r.id = nb.rec_id
       and coalesce(r.data->>'${t.themeField}','') = ''
       and nb.title is not null`;
  run(
    `update ${t.table} r set data = r.data || jsonb_build_object('${t.themeField}', nb.title), updated_at = now() ${base};`,
    `${t.label} · 主题 ← 笔记标题`,
  );

  // ⚠️ 时间单独一条 update：主题与时间要**各自判断是否为空**，合在一条里会互相拖累
  //
  // ⚠️ 写**毫秒数字**而不是 `YYYY-MM-DDTHH:mm` 字符串：这两个字段虽然登记成 type=5（日期），
  //    但**库里实际存的是毫秒时间戳**（既有数据 1788951600000 就是这么存的）——
  //    前端表单提交的字符串由后端转成毫秒落库，回填脚本绕过前端，必须自己按毫秒写，
  //    否则同一字段出现两种格式，前端渲染与「按时间筛选」都会出问题。
  run(
    `update ${t.table} r
        set data = r.data || jsonb_build_object('${t.timeField}', to_jsonb((nb.ms)::bigint)),
            updated_at = now()
       from (
         select c.data->>'目标记录ID' as rec_id, (b.data->>'笔记创建时间') as ms
           from ${CONV} c
           join ${BODY} b on b.data->>'笔记ID' = c.data->>'笔记ID'
          where c.data->>'模块KEY' in (${modList(t)})
            and coalesce(c.data->>'目标记录ID','') <> ''
            and coalesce(b.data->>'笔记创建时间','') ~ '^[0-9]+$'
       ) nb
      where r.id = nb.rec_id
        and coalesce(r.data->>'${t.timeField}','') = '';`,
    `${t.label} · 时间 ← 笔记创建时间`,
  );
}

console.log('\n④ 关联学生编号（按学生姓名匹配学生档案）');
for (const t of TARGETS) {
  const list = rows(`
    select r.id, r.data->>'关联学生', p.id
      from ${t.table} r
      join ${PROFILE} p on p.data->>'学生姓名' = r.data->>'关联学生'
     where coalesce(r.data->>'关联学生编号','') = ''
       and coalesce(r.data->>'关联学生','') <> '';`);
  if (!list.length) {
    console.log(`  ${t.label}：无待补记录`);
  }
  for (const [rid, sname, pid] of list) {
    console.log(`  将回填 ${t.label} ${rid}：关联学生编号 ← ${pid}（${sname}）`);
  }
  run(
    `update ${t.table} r
        set data = r.data || jsonb_build_object('关联学生编号', to_jsonb(array[p.id])),
            updated_at = now()
       from ${PROFILE} p
      where coalesce(r.data->>'关联学生编号','') = ''
        and coalesce(r.data->>'关联学生','') <> ''
        and p.data->>'学生姓名' = r.data->>'关联学生';`,
    `${t.label} · 关联学生编号`,
  );
}

console.log('\n⑤ 回读复核');
for (const t of TARGETS) {
  const [n, themeEmpty, timeEmpty, linkEmpty] = rows(
    `select count(*),
            count(*) filter (where coalesce(data->>'${t.themeField}','') = ''),
            count(*) filter (where coalesce(data->>'${t.timeField}','') = ''),
            count(*) filter (where coalesce(data->>'关联学生编号','') = '')
       from ${t.table};`,
  )[0];
  console.log(`  ${t.label}：共 ${n} 条 ｜ 主题空 ${themeEmpty} ｜ 时间空 ${timeEmpty} ｜ 学生关联空 ${linkEmpty}`);
  const sample = rows(
    `select left(id,24) || ' → 主题=' || coalesce(nullif(data->>'${t.themeField}',''),'(空)')
            || ' ｜ 时间=' || coalesce(nullif(data->>'${t.timeField}',''),'(空)')
            || ' ｜ 学生关联=' || coalesce((data->'关联学生编号')::text,'(空)')
       from ${t.table} order by updated_at desc limit 4;`,
  );
  for (const [s] of sample) console.log(`      ${s}`);
}
console.log(APPLY ? '\n✅ 已执行' : '\n（dry-run 结束，加 --apply 才会真正写库）');
