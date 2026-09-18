#!/usr/bin/env node
/**
 * 「学生记录」三合一：生产数据迁移（幂等，默认 dry-run）。
 *
 *   node scripts/migrate_student_records.mjs            # 只看将要做什么
 *   node scripts/migrate_student_records.mjs --apply    # 真正执行
 *
 * 做四件事，顺序固定：
 *   ① 备份（建 bak_* 表，已存在则跳过 —— 重复执行不会覆盖第一次的备份）
 *   ② 主表（日常跟进表）补齐 7 个字段元数据 → acms_fields
 *   ③ 主表现有记录补「记录类型」= 日常跟进（原本就是「日常跟进」表，语义不变）
 *   ④ 生产配置迁移：nav_menu_config 三个菜单合一、note_convert_config 三条合一
 *
 * ⚠️ 幂等要求（远端命令可能被重复执行 —— 2026-09-18 实测两次）：每个步骤都先查现状，
 *    已经是目标状态就跳过；JSON 配置按 key 判断而不是按位置。
 *
 * ⚠️ 不动任何业务数据：家校沟通表 / 学生观察表都是 0 条记录（2026-09-19 实测），
 *    所以没有「搬记录」这一步。旧表原样保留，随时可回退。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const MAIN = 'tbljjbChYx9uhbbb'; // 合并后主表 = 日常跟进表
const HS = 'tbl8Isr46G3BRQ52'; // 家校沟通表（字段来源）
const SO = 'tblDtqXu3yXLp56l'; // 学生观察表（字段来源）
const CONF_TABLE = 't_tblqeukqlsuoieuy'; // 系统配置表
const STAMP = '20260919';

const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'season69130' };
const PG_ARGS = ['-h', '127.0.0.1', '-U', 'acms', '-d', 'acms-prd'];

/** 查询，返回行数组（每行按 | 分列） */
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

/** 单值查询 */
function one(sql) {
  const r = rows(sql);
  return r.length ? r[0][0] : '';
}

const log = [];
function step(msg) {
  log.push(msg);
  console.log(msg);
}

/** 执行写语句（dry-run 只打印） */
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

function fieldId(seed) {
  return 'fld_' + crypto.createHash('md5').update(seed).digest('hex').slice(0, 12);
}

function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// ─────────────────────────────────────────────────────────────
console.log(`=== 学生记录迁移 ${APPLY ? '（APPLY 实际执行）' : '（dry-run）'} ===\n`);

// ① 备份
console.log('① 备份');
const bakData = `bak_sr_data_${STAMP}`;
const bakFields = `bak_sr_fields_${STAMP}`;
const bakConf = `bak_sr_conf_${STAMP}`;
const has = (t) => one(`select to_regclass('public.${t}') is not null;`) === 't';
if (has(bakData) && has(bakFields) && has(bakConf)) {
  step('  备份表已存在，跳过（重复执行不会覆盖第一次的备份）');
} else {
  run(`create table if not exists ${bakData} as select * from t_tbljjbchyx9uhbbb;`, `备份主表数据 → ${bakData}`);
  run(
    `create table if not exists ${bakFields} as select * from acms_fields where table_id in ('${MAIN}','${HS}','${SO}');`,
    `备份字段元数据 → ${bakFields}`,
  );
  run(
    `create table if not exists ${bakConf} as select * from ${CONF_TABLE} where data->>'配置键' in ('nav_menu_config','note_convert_config');`,
    `备份系统配置 → ${bakConf}`,
  );
}

// ② 主表补字段
console.log('\n② 主表补 7 个字段（acms_fields）');
const RECORD_TYPE_OPTS = [
  { id: 'optsr000001', name: '日常跟进', color: 0 },
  { id: 'optsr000002', name: '家校沟通', color: 1 },
  { id: 'optsr000003', name: '学生观察', color: 2 },
];

/** 从源表抄 property（含选项 id），保证与旧模块的选项完全一致 */
function copyProp(srcTable, srcName) {
  const raw = one(`select property::text from acms_fields where table_id='${srcTable}' and name=${sqlStr(srcName)};`);
  if (!raw) throw new Error(`找不到源字段 ${srcTable}.${srcName}`);
  return raw;
}

const FIELDS = [
  { name: '记录类型', type: 3, prop: JSON.stringify({ options: RECORD_TYPE_OPTS }) },
  { name: '家长', type: 1, prop: '{}' },
  { name: '家长反馈态度', type: 3, prop: copyProp(HS, '家长反馈态度') },
  { name: '家长反馈', type: 1, prop: '{}' },
  { name: '观察类型', type: 3, prop: copyProp(SO, '观察类型') },
  { name: '关联学生编号', type: 18, prop: copyProp(HS, '关联学生编号') },
  { name: '关联监护人', type: 18, prop: copyProp(HS, '关联监护人') },
];

for (const f of FIELDS) {
  const exists = one(`select count(*) from acms_fields where table_id='${MAIN}' and name=${sqlStr(f.name)};`);
  if (exists !== '0') {
    step(`  ${f.name}：已存在，跳过`);
    continue;
  }
  run(
    `insert into acms_fields (table_id, field_id, name, type, property) values ('${MAIN}', ${sqlStr(fieldId(f.name))}, ${sqlStr(f.name)}, ${f.type}, ${sqlStr(f.prop)}::jsonb);`,
    `新增字段 ${f.name}（type=${f.type}）`,
  );
}

// ③ 现有记录补「记录类型」
console.log('\n③ 主表现有记录补「记录类型」');
const needType = one(`select count(*) from t_tbljjbchyx9uhbbb where coalesce(data->>'记录类型','')='';`);
step(`  待补记录数：${needType}`);
if (needType !== '0') {
  run(
    `update t_tbljjbchyx9uhbbb set data = data || '{"记录类型":"日常跟进"}'::jsonb, updated_at = now() where coalesce(data->>'记录类型','')='';`,
    `补「记录类型=日常跟进」（${needType} 条）`,
  );
}

// ④ 配置迁移
console.log('\n④ 生产配置迁移');

/** 读取一条系统配置的 JSON 值 */
function readConf(key) {
  const raw = one(`select coalesce(data->>'配置值','') from ${CONF_TABLE} where data->>'配置键'=${sqlStr(key)};`);
  return raw ? JSON.parse(raw) : null;
}
function writeConf(key, obj) {
  const json = JSON.stringify(obj);
  run(
    `update ${CONF_TABLE} set data = data || jsonb_build_object('配置值', ${sqlStr(json)}), updated_at = now() where data->>'配置键'=${sqlStr(key)};`,
    `写入配置 ${key}（${json.length} 字符）`,
  );
}

// 4.1 导航菜单：三个菜单 → 一个「学生记录」
const nav = readConf('nav_menu_config');
if (!nav) {
  step('  nav_menu_config 不存在，跳过');
} else if ((nav.items || []).some((i) => i.key === 'studentRecords')) {
  step('  nav_menu_config：已有 studentRecords，跳过');
} else {
  const LEGACY = ['homeSchoolComms', 'dailyFollowups', 'studentObservations'];
  const dropped = (nav.items || []).filter((i) => LEGACY.includes(i.key));
  const anchor = dropped.find((i) => i.key === 'homeSchoolComms') ?? dropped[0] ?? {};
  nav.items = (nav.items || []).filter((i) => !LEGACY.includes(i.key));
  nav.items.push({
    key: 'studentRecords',
    label: '学生记录',
    enLabel: 'Student Records',
    href: '/student-records',
    icon: 'notifications',
    section: anchor.section ?? '学生闭环',
    // 沿用被合并项里最靠前的 order，避免新菜单跳到末尾
    order: anchor.order ?? 120,
    perm: '',
  });
  step(`  导航：删除 ${dropped.length} 项（${dropped.map((i) => i.key).join(', ')}）→ 新增 studentRecords`);
  writeConf('nav_menu_config', nav);
}

// 4.2 笔记转换配置：三条 → 一条
const ncc = readConf('note_convert_config');
if (!ncc) {
  step('  note_convert_config 不存在，跳过');
} else if ((ncc.items || []).some((i) => i.key === 'studentRecords')) {
  step('  note_convert_config：已有 studentRecords，跳过');
} else {
  const LEGACY = ['homeSchoolComms', 'dailyFollowups', 'studentObservations'];
  const dropped = (ncc.items || []).filter((i) => LEGACY.includes(i.key));
  const anchor = dropped.find((i) => i.key === 'homeSchoolComms') ?? dropped[0] ?? {};
  // 三者字段映射完全一致，取任一即可；enabled 用「任一启用」——原来启用了就不该被合没
  const enabled = dropped.some((i) => i.enabled);
  ncc.items = (ncc.items || []).filter((i) => !LEGACY.includes(i.key));
  ncc.items.push({
    ...anchor,
    key: 'studentRecords',
    label: '学生记录',
    enLabel: 'Student Records',
    href: '/student-records',
    enabled,
    summaryField: anchor.summaryField ?? '沟通总结',
    rawField: anchor.rawField ?? '沟通明细',
    audioField: anchor.audioField ?? '沟通附件清单',
  });
  step(`  笔记转换：删除 ${dropped.length} 项（${dropped.map((i) => i.key).join(', ')}）→ 新增 studentRecords（enabled=${enabled}）`);
  writeConf('note_convert_config', ncc);
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 回读复核 ===');
console.log('主表字段数：', one(`select count(*) from acms_fields where table_id='${MAIN}';`));
console.log(
  '新增字段：',
  rows(`select name, type from acms_fields where table_id='${MAIN}' and name in ('记录类型','家长','家长反馈态度','家长反馈','观察类型','关联学生编号','关联监护人') order by name;`)
    .map((r) => `${r[0]}(t${r[1]})`)
    .join(', ') || '(无)',
);
console.log('主表无类型的记录数：', one(`select count(*) from t_tbljjbchyx9uhbbb where coalesce(data->>'记录类型','')='';`));
console.log(
  '导航里的沟通类菜单：',
  one(`select coalesce(string_agg(k, ','), '(无)') from ${CONF_TABLE}, jsonb_array_elements((data->>'配置值')::jsonb -> 'items') e, lateral (select e->>'key' as k) x where data->>'配置键'='nav_menu_config' and (e->>'key') in ('studentRecords','homeSchoolComms','dailyFollowups','studentObservations');`),
);
console.log(
  '转换配置里的沟通类模块：',
  one(`select coalesce(string_agg(k, ','), '(无)') from ${CONF_TABLE}, jsonb_array_elements((data->>'配置值')::jsonb -> 'items') e, lateral (select e->>'key' as k) x where data->>'配置键'='note_convert_config' and (e->>'key') in ('studentRecords','homeSchoolComms','dailyFollowups','studentObservations');`),
);
console.log(APPLY ? '\n✅ 已执行' : '\n（dry-run 结束，加 --apply 才会真正写库）');
