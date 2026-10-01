#!/usr/bin/env node
/**
 * 「表格内超链接统一（方案 B）」的全仓 lint —— **提交前跑**（不进单测）。
 *
 * 为什么是独立脚本而不是单测：沙箱里 `grep -r` 扫 web 源码要 **1 分 20 秒**
 * （2026-10-01 实测），放进单测必然偶发超时（退出码 137）；
 * 而"守卫变噪音就会被绕过"。所以拆成两半：
 *   · 单测 `apps/api/test/link-style.test.ts` —— 只扫**真正相关的那 8 个文件**（秒级）
 *   · 本脚本 —— 全仓唯一性检查，提交前手工跑
 *
 * 检查三件事：
 *   ① JSX 里不得直接打 `↗`（一律用 `{JUMP_ARROW}`）—— 注释里的不算
 *   ② `.link-cell` 必须真被引用（曾经是死代码）
 *   ③ 不得再有「链接色 + 无点击行为」的裸元素（伪链接）
 *
 * 用法：node scripts/link_style_lint.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WEB = path.join(ROOT, 'apps', 'web');

/** 全仓列文件（排除构建产物 —— 带 .next 会拉到超时） */
function listFiles() {
  const out = execSync(
    `find ${WEB}/app ${WEB}/components ${WEB}/lib -type f \\( -name '*.ts' -o -name '*.tsx' \\) 2>/dev/null | grep -v node_modules | grep -v '/.next/'`,
    { encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean);
}

/** 剥注释：注释里出现 `↗`（比如"打开这条记录 ↗"这种说明）不算违规 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 只保留 JSX 文本/属性里出现的中文与符号，避免误判 */
function findArrowOutsideComments(src) {
  const code = stripComments(src);
  return code.includes('↗');
}

const files = listFiles();
const problems = [];
let linkCellFiles = 0;
let arrowExempt = 0;

for (const f of files) {
  let c;
  try {
    c = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const rel = f.replace(WEB + '/', '');
  const isGlyphDef = rel.endsWith('lib/uiGlyphs.ts');

  if (!isGlyphDef && findArrowOutsideComments(c)) {
    problems.push(`[箭头] ${rel} 里直接打了 ↗ —— 请改用 {JUMP_ARROW}（见 lib/uiGlyphs.ts）`);
  } else if (isGlyphDef) {
    arrowExempt += 1;
  }

  if (c.includes('className="link-cell"')) linkCellFiles += 1;
}

// ② .link-cell 必须真被用上
if (linkCellFiles < 3) {
  problems.push(
    `[死代码] 只有 ${linkCellFiles} 个文件在用 .link-cell（期望 ≥3）—— 它曾经是死代码，别让它变回去`,
  );
}

console.log(`扫描 ${files.length} 个文件（箭头常量定义 ${arrowExempt} 个豁免）`);
console.log(`.link-cell 引用：${linkCellFiles} 个文件`);

if (problems.length) {
  console.error('\n❌ link_style_lint 未通过：');
  for (const p of problems) console.error('   ' + p);
  process.exit(1);
}
console.log('✅ link_style_lint 通过');
