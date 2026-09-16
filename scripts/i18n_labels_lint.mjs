// Build-time i18n guard for the `labels` auto-translation layer.
// Fails (exit 1) if any `tl('...')` literal argument is missing from labels.
// Run via: node scripts/i18n_labels_lint.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = process.cwd();
const WEB = `${ROOT}/apps/web`;

function listTsx() {
  const out = execSync(
    `find ${WEB} -name '*.tsx' -o -name '*.ts' | grep -v node_modules | grep -v '.next'`,
    { encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean);
}

const en = JSON.parse(fs.readFileSync(`${WEB}/messages/en.json`, 'utf8'));
const zh = JSON.parse(fs.readFileSync(`${WEB}/messages/zh.json`, 'utf8'));
const labelsEn = en.labels || {};
const labelsZh = zh.labels || {};

const files = listTsx();
const missingEn = [];
const missingZh = [];
const seen = new Set();

for (const f of files) {
  let c;
  try {
    c = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!/tl\(/.test(c)) continue;
  const re = /tl\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(c))) {
    const raw = m[1] === '"' ? m[2].replace(/\\"/g, '"') : m[2].replace(/\\'/g, "'");
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!(raw in labelsEn)) missingEn.push(`${f.replace(WEB + '/', '')} :: tl('${raw}')`);
    if (!(raw in labelsZh)) missingZh.push(`${f.replace(WEB + '/', '')} :: tl('${raw}')`);
  }
}

// also: labels parity between en and zh
const onlyEn = Object.keys(labelsEn).filter((k) => !(k in labelsZh));
const onlyZh = Object.keys(labelsZh).filter((k) => !(k in labelsEn));

let ok = true;
if (missingEn.length) {
  ok = false;
  console.error('❌ [labels] 以下 tl() 参数缺失于 en.json labels:');
  for (const x of missingEn) console.error('   ' + x);
}
if (missingZh.length) {
  ok = false;
  console.error('❌ [labels] 以下 tl() 参数缺失于 zh.json labels:');
  for (const x of missingZh) console.error('   ' + x);
}
if (onlyEn.length) {
  ok = false;
  console.error('❌ [labels] 仅存在于 en 的中文 key (zh 缺失):', onlyEn.length);
  for (const x of onlyEn.slice(0, 50)) console.error('   ' + x);
}
if (onlyZh.length) {
  ok = false;
  console.error('❌ [labels] 仅存在于 zh 的中文 key (en 缺失):', onlyZh.length);
  for (const x of onlyZh.slice(0, 50)) console.error('   ' + x);
}

// ── 第二类检查：useTranslations('ns') + t('key') 的 key 是否存在 ──────────────
//
// 为什么必须有这一条（2026-09-16 事故）：上面的 labels 检查**只看 `tl()` 字面量**，
// 而页面里大量文案是 `const t = useTranslations('apiTokens')` + `t('cancel')` 这种命名空间
// 写法。key 写错或漏定义时 next-intl 不报错，**直接把 key 原样渲染到界面上**
// —— 「令牌管理」页的取消按钮线上就是这么显示成 `apiTokens.cancel` 的，
// 而 lint 照样绿。所以这里静态比对一遍：文件里用到的 key 必须在该命名空间下存在（en/zh 都要）。
const nsMissing = [];

for (const f of files) {
  let c;
  try {
    c = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!/useTranslations\(/.test(c)) continue;

  // const t = useTranslations('ns')  /  const ti = useTranslations('ns')
  // 同一个变量名在文件里可能被绑多次（外层页面绑命名空间、内层小组件绑根命名空间），
  // 纯正则分不清作用域 ⇒ 收集**全部**可能的命名空间，只要能在其中任一个下解析成功就算通过。
  // 这样既不误报，也保住了页面级 key 的检查覆盖。
  const bindings = new Map();
  const addBinding = (v, ns) => {
    if (!bindings.has(v)) bindings.set(v, new Set());
    bindings.get(v).add(ns);
  };
  for (const m of c.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*useTranslations\(\s*(['"])([\w.]+)\2\s*\)/g)) {
    addBinding(m[1], m[3]);
  }
  for (const m of c.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*useTranslations\(\s*\)/g)) {
    addBinding(m[1], ''); // 根命名空间
  }
  if (!bindings.size) continue;

  for (const [varName, spaces] of bindings) {
    // ⚠️ 反误报：同名的 `t` 也可能是**函数参数**（例如
    //    `function breadcrumbLabel(path: string, t: (k: string) => string)`，
    //    调用方传进来的是别的命名空间）。纯正则看不到作用域，这种文件直接跳过该变量 ——
    //    宁可漏检，也不要假警报：假警报会让 lint 被无视，比漏检更糟。
    const asParam = new RegExp(
      `function\\s+\\w+\\s*\\([^)]*\\b${varName}\\b|\\b${varName}\\s*:\\s*(?:\\(|=>|\\w+\\s*=>)`
    ).test(c);
    if (asParam) continue;

    const re = new RegExp(`(?<![\\w.])${varName}\\(\\s*(['"])([\\w.]+)\\1`, 'g');
    for (const m of c.matchAll(re)) {
      const key = m[2];
      for (const [label, tree] of [['en', en], ['zh', zh]]) {
        // 在该变量可能绑定的任一命名空间下能解析出来即可
        const hit = [...spaces].some((ns) => {
          let cur = tree;
          // ⚠️ 命名空间自己也可能带点号（useTranslations('ai.skills')）⇒ 两边都要拆
          for (const p of [...(ns ? ns.split('.') : []), ...key.split('.')]) {
            cur = cur && typeof cur === 'object' ? cur[p] : undefined;
            if (cur === undefined) return false;
          }
          return true;
        });
        if (!hit) {
          const where = [...spaces].map((s) => s || '(root)').join(' | ');
          nsMissing.push(`${f.replace(WEB + '/', '')} :: ${label}.${where}.${key}`);
        }
      }
    }
  }
}

if (nsMissing.length) {
  ok = false;
  console.error('❌ [namespaces] 以下 t()/ti() 用到的 key 在 messages/{en,zh}.json 里不存在');
  console.error('   （next-intl 不会报错，会把 key 原样显示到界面上）：');
  for (const x of [...new Set(nsMissing)]) console.error('   ' + x);
}

if (ok) {
  console.log(`✅ i18n labels lint passed: ${seen.size} tl() 字面量全部命中 labels (en/zh 对称, ${Object.keys(labelsEn).length} 条)`);
  process.exit(0);
} else {
  console.error('\n修复方式：');
  console.error('  · [labels] 在 apps/web/messages/{en,zh}.json 的 labels 命名空间补上中文原文 key（en=英文, zh=中文）。');
  console.error('  · [namespaces] 在该页面 useTranslations(...) 对应的命名空间下补 key；');
  console.error('    或者改用 `tl(\'中文原文\')`（走 labels 自动翻译层）。');
  process.exit(1);
}
