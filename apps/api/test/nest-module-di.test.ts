import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * NestJS 模块装配的**启动期**守卫（2026-09-30 新增）。
 *
 * ── 为什么要单独守这个 ────────────────────────────────────────────
 * 2026-09-30 部署「笔记录音补抓定时任务」时踩到：
 * `scheduled-tasks.module.ts` 里 `import { GetnoteModule } from '../getnote/getnote.module.js';`
 * 写了，但 `@Module({ imports: [ … ] })` 数组里**漏了 `GetnoteModule`**。
 * 后果：
 *   · `tsc` 编译 ✅（数组元素只是类引用，少一个不报错）
 *   · 单测 ✅ · typecheck ✅ · i18n lint ✅ —— **全绿**
 *   · 只有进程启动时炸：`Nest can't resolve dependencies of the ScheduledTasksRunner (…, GetnoteService)`
 *   · 在蓝绿部署里的表现是「新 slot 起不来 ⇒ 探活恒 000」，**部署脚本探活 60 次全 000**
 *     —— 如果放进「先切流再验证」的顺序里，就是线上 502。
 *
 * 这类 bug 的共性：**编译期与测试期都看不见，只有装配期才暴露**。
 * 所以本文件做两件事：
 *   ① 通用静态检查：任何 `*.module.ts` 里写进 `import { XxxModule }` 的模块，
 *      必须出现在该文件 `@Module({ imports: [...] })` 数组里（或显式列入白名单并说明理由）；
 *   ② 定点检查：`ScheduledTasksRunner` 构造函数注入的每个 service，
 *      其「声明它的模块」必须被 `ScheduledTasksModule` 导入，且该模块必须 `exports` 它。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

/**
 * 带缓存的读文件。
 *
 * 🔴 必须缓存：下面的断言会对同一批 module 文件反复 `read + stripComments`
 *    （外层遍历文件、内层再为每个依赖重读一遍）⇒ 无缓存时是 O(n×m) 次磁盘读，
 *    在本机沙箱里会**偶发超时**（实测同一条断言先 29ms、后 >5s 被 kill）。
 *    守卫不该因为磁盘慢而变红 —— 那会让人开始"重跑一次看看"，
 *    而这类守卫一旦被当成噪音就会被绕过。
 */
const fileCache = new Map<string, string>();
const read = (p: string) => {
  const hit = fileCache.get(p);
  if (hit !== undefined) return hit;
  const text = readFileSync(p, 'utf8');
  fileCache.set(p, text);
  return text;
};

/** 带缓存的 `read + stripComments`（注释剥了就等于换了一份内容，单独缓存） */
const strippedCache = new Map<string, string>();
const stripped = (p: string) => {
  const hit = strippedCache.get(p);
  if (hit !== undefined) return hit;
  const text = stripComments(read(p));
  strippedCache.set(p, text);
  return text;
};

/** 递归收集 `*.module.ts` */
function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...moduleFiles(p));
    else if (e.name.endsWith('.module.ts')) out.push(p);
  }
  return out;
}

/** 剥掉注释（`//`、行尾 `//` 与块注释）—— 注释里为了讲规矩会写出被禁的写法，也会出现 `]` */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/[^\n]*/g, '');
}

/**
 * 从 `src[start]` 处的开括号出发，返回配对闭括号之后的下标；找不到返回 -1。
 * ⚠️ 这里**必须真配对**，不能用 `[^\]]*?` 之类的非贪婪正则 ——
 *    `imports: [ GenericCrudModule.registerAll([A, B]), DictModule ]` 这种嵌套写法
 *    会让非贪婪正则在**内层 `]`** 处提前收尾，于是数组后半截被静默丢掉
 *    （第一版守卫就是这么写的，结果漏判了 `idp.module.ts` 里的 `DictModule`）。
 */
function afterBracket(src: string, start: number): number {
  const open = src[start];
  const close = open === '[' ? ']' : open === '{' ? '}' : open === '(' ? ')' : '';
  if (!close) return -1;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 取 `@Module({...})` 装饰器的对象体（配对括号之间的原文） */
function moduleBody(src: string): string {
  const i = src.lastIndexOf('@Module(');
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  const end = afterBracket(src, open);
  return end < 0 ? '' : src.slice(open + 1, end - 1);
}

/**
 * 取 `@Module` 里某个数组字段的**顶层**元素（按 depth=0 的逗号切分）。
 * 只保留标识符形态，`XxxModule.registerAll([...])` 取其中的 `XxxModule`。
 */
function moduleField(src: string, field: 'imports' | 'exports' | 'providers' | 'controllers'): string[] {
  const body = moduleBody(src);
  if (!body) return [];
  const re = new RegExp(`\\b${field}\\s*:\\s*\\[`, 'g');
  const m = re.exec(body);
  if (!m) return [];
  const arrStart = m.index + m[0].length - 1;
  const end = afterBracket(body, arrStart);
  if (end < 0) return [];
  const inner = body.slice(arrStart + 1, end - 1);

  // 按 depth 0 的逗号切分（跳过嵌套的 [] / () / {} 内的逗号）
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of inner) {
    if ('[({'.includes(c)) depth += 1;
    else if ('])}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);

  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const id = /^([A-Za-z_$][\w$]*)\b/.exec(t);
    if (id) out.push(id[1]);
  }
  return out;
}

/** 文件里 `export class XxxModule` 的实际类名（文件名 ≠ 类名，如 `sources.module.ts` → `GetnoteSourceModule`） */
function exportedModuleName(src: string): string | null {
  const m = /export\s+class\s+([A-Za-z_$][\w$]*Module)\b/.exec(src);
  return m ? m[1] : null;
}

/**
 * 允许「import 了但故意不写进 imports 数组」的例外。
 * ⚠️ 加进来必须写清理由 —— 这张表存在的意义是让例外是**显式**的。
 */
const MODULE_IMPORT_EXEMPT: Record<string, string> = {};

describe('NestJS 模块装配守卫', () => {
  const files = moduleFiles(SRC);

  it('🔴 凡 `import { XxxModule }` 出现的模块，必须写进 `@Module.imports` 数组里', { timeout: 30_000 }, () => {
    // 这条断言直接对应 2026-09-30 那次「新 slot 起不来、探活全 000」的事故：
    // 编译器不会报错，因为它只知道"这个标识符被 import 了、也被用到了（或根本没用到）"。
    const violations: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f);
      const src = stripped(f);
      // 该文件 import 进来的所有 `XxxModule`
      const imported = new Set<string>();
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\.module\.js['"]/g)) {
        for (const name of m[1].split(',')) {
          const n = name.trim();
          if (/Module$/.test(n)) imported.add(n);
        }
      }
      // 默认导入形态 `import XxxModule from './xxx.module.js'`
      for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*Module)\s+from\s*['"][^'"]*\.module\.js['"]/g)) {
        imported.add(m[1]);
      }
      if (imported.size === 0) continue;
      const inArray = new Set(moduleField(src, 'imports'));
      for (const name of imported) {
        if (inArray.has(name)) continue;
        if (MODULE_IMPORT_EXEMPT[`${rel}:${name}`]) continue;
        violations.push(`${rel} → import 了 ${name} 但未列入 @Module.imports`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('🔴 ScheduledTasksRunner 注入的每个 service，其声明模块必须被导入且已 exports', { timeout: 30_000 }, () => {
    const runnerPath = path.join(SRC, 'scheduled-tasks', 'scheduled-tasks.runner.ts');
    const schedPath = path.join(SRC, 'scheduled-tasks', 'scheduled-tasks.module.ts');
    const runner = stripped(runnerPath);
    const schedSrc = stripped(schedPath);

    // 构造函数注入的 service 类名（`private readonly xxx: FooService`）
    const ctor = /constructor\(([\s\S]*?)\)\s*\{/.exec(runner);
    expect(ctor, '解析不到 ScheduledTasksRunner 的构造函数').not.toBeNull();
    const deps = [...ctor![1].matchAll(/private\s+readonly\s+\w+\s*:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    // 依赖清单本身也要非空 —— 否则下面的循环会「零断言通过」（回归时静默失效）
    expect(deps.length).toBeGreaterThanOrEqual(6);
    expect(deps).toContain('GetnoteService');

    const importedModules = new Set(moduleField(schedSrc, 'imports'));
    const problems: string[] = [];
    for (const dep of deps) {
      // 找到声明（providers 里含它）的那个模块
      const decl = files.find((f) => moduleField(stripped(f), 'providers').includes(dep));
      if (!decl) {
        problems.push(`${dep}：找不到任何模块在 providers 里声明它`);
        continue;
      }
      const declName = exportedModuleName(read(decl));
      if (!declName) {
        problems.push(`${dep}：${path.relative(SRC, decl)} 里找不到 export class XxxModule`);
        continue;
      }
      const declSrc = stripped(decl);
      if (!importedModules.has(declName)) {
        problems.push(`${dep} → 声明它的 ${declName} 未列入 ScheduledTasksModule.imports`);
      }
      if (!moduleField(declSrc, 'exports').includes(dep)) {
        problems.push(`${dep} → 声明它的 ${declName} 未 exports 它（Nest 无法跨模块注入）`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('🔴 每个模块 `imports` 里出现的 `XxxModule` 都必须是**真模块**（防止笔误写了个不存在的名字）', { timeout: 30_000 }, () => {
    // Nest 对未定义的标识符会直接 ReferenceError，但写法千奇百怪；
    // 这里只守"列进 imports 的模块标识符，源码里确实有对应文件 export 它"。
    // ⚠️ 用 `export class XxxModule` 收集，**不能**按文件名推 —— `sources.module.ts`
    //    导出的是 `GetnoteSourceModule`，按文件名会误报「没有对应的 module 文件」。
    const declared = new Set<string>();
    for (const f of files) {
      const n = exportedModuleName(read(f));
      if (n) declared.add(n);
    }
    // 收集本身要有内容，否则下面的循环会「零断言通过」
    expect(declared.size).toBeGreaterThanOrEqual(20);

    const problems: string[] = [];
    for (const f of files) {
      for (const name of moduleField(stripped(f), 'imports')) {
        if (!/Module$/.test(name)) {
          problems.push(`${path.relative(SRC, f)} → imports 里出现非模块标识符「${name}」`);
          continue;
        }
        if (!declared.has(name)) {
          problems.push(`${path.relative(SRC, f)} → imports 里的「${name}」没有对应的 module 文件`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
