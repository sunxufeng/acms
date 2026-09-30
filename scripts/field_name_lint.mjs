#!/usr/bin/env node
/**
 * 字段名 lint：禁止把「学籍号」当学生档案字段名用。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *   学生档案里那个字段的**真名是 `学籍号（脱敏）`**（带全角括号）。
 *   写成 `学籍号` 用起来**完全正常**（取到的值恒为空 / undefined），
 *   **不报错、不警告**，只是那一栏在界面上永远是「—」。
 *
 *   2026-09-30 摸底时发现**已经有两处**这种老 bug：
 *     · `apps/api/src/ai/lib/tools/studentQuery.ts` —— AI 工具返回的学籍号恒 undefined
 *     · `apps/web/app/portal/page.tsx` —— 学生门户「本人档案」那一行永远显示「—」
 *   两处都已修，这个脚本负责不让第三处出现。
 *
 * ── 为什么是脚本、不是单元测试 ──────────────────────────────────
 *   本机沙箱里读一个文件约有 160ms 的固定开销，全仓 550 个 ts/tsx 要跑 ~90 秒。
 *   放在 `pnpm test` 里会让全量测试慢到没人愿意跑（接着就会被绕过）。
 *   所以：**这里做全仓扫描（提交前手动/CI 跑），单测里只扫"真正读学生字段的那批目录"**
 *   （几十个文件，几秒），两边互补。
 *
 * 用法：
 *   node scripts/field_name_lint.mjs          # 只在有违规时非 0 退出
 *   node scripts/field_name_lint.mjs --verbose
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

/** 真字段名（唯一真源是 `StudentService.STUDENT_NO_FIELD`，这里逐字复制） */
const FIELD = '学籍号（脱敏）';

const ROOTS = ['apps/api/src', 'apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages'];

/** 剥注释（注释里为讲清规矩会写出被禁的写法 —— 本仓踩过多次） */
const strip = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/[^\n]*/g, '');

/**
 * 把「学籍号」当**字段名**用的两种写法（真名带全角括号，所以这两条都不会命中真名）。
 *
 * 🔴 判据只有这两条，是**故意**收窄的（第一版写宽了，误报把自己那道断言搞红）：
 *    ① `'学籍号'` / `"学籍号"` —— 带引号的字段名。两个老 bug 里的门户那处就是这个形态
 *       （`PROFILE_FIELDS = ['学生姓名', '学籍号', ...]`）。
 *    ② `.学籍号`（后面不跟全角括号）—— 点号属性访问。另一个老 bug 是 `s.学籍号`。
 *
 * ⚠️ **不查** `学籍号: xxx` 这种对象键：它与"展示用的标签"长得一模一样，
 *    例如 `ai/lib/tools/studentQuery.ts` 里的 `学籍号: s['学籍号（脱敏）']` ——
 *    那是**输出给 AI 的字段名**，完全合法。写数据用的键在本仓一律是带引号的
 *    （`'学籍号（脱敏）': value`），所以①已经覆盖。
 *    ⇒ 判据宁可窄一点、零误报，也不要宽到天天红（红了就会被加豁免，然后失效）。
 */
const BAD = [/['"]学籍号['"]/, /\.学籍号(?!（)/];

const offenders = [];
let scanned = 0;
let skipped = 0;

function walk(relDir) {
  let entries;
  try {
    entries = readdirSync(path.join(ROOT, relDir), { withFileTypes: true, recursive: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // ⚠️ 必须显式跳过：`apps/web/.next` 会让扫描拖到被 SIGTERM（本仓踩过）
    if (e.name === 'node_modules' || e.name.startsWith('.next') || e.name === 'dist') continue;
    if (!e.isFile()) continue;
    const rel = path.join(relDir, e.parentPath ? path.relative(path.join(ROOT, relDir), e.parentPath) : '', e.name);
    if (!/\.(ts|tsx)$/.test(e.name)) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    let text;
    try {
      text = readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = strip(text).split('\n');
    lines.forEach((l, i) => {
      if (BAD.some((re) => re.test(l))) {
        offenders.push(`${rel}:${i + 1}\n    ${l.trim().slice(0, 160)}`);
      }
    });
  }
}

for (const r of ROOTS) walk(r);

if (VERBOSE) {
  console.log(`[field-name-lint] 扫描 ${scanned} 个文件（跳过 ${skipped} 个非 ts/tsx）`);
  console.log(`[field-name-lint] 真字段名：${FIELD}`);
}

if (offenders.length) {
  console.error('');
  console.error(`❌ 以下地方把「学籍号」当字段名用了 —— 真名是「${FIELD}」`);
  console.error('   症状：取到的值恒为空 / undefined，**不报错**，界面上那一栏永远显示「—」。');
  console.error('');
  for (const o of offenders) console.error(`  · ${o}`);
  console.error('');
  console.error(`共 ${offenders.length} 处。请改用字段全名（或后端常量 STUDENT_NO_FIELD）。`);
  process.exit(1);
}

console.log(`[field-name-lint] OK —— ${scanned} 个文件里没有把「学籍号」当字段名的写法。`);
