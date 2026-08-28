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

if (ok) {
  console.log(`✅ i18n labels lint passed: ${seen.size} tl() 字面量全部命中 labels (en/zh 对称, ${Object.keys(labelsEn).length} 条)`);
  process.exit(0);
} else {
  console.error('\n修复方式：在 apps/web/messages/{en,zh}.json 的 labels 命名空间补上对应中文 key（en=英文, zh=中文原文）。');
  process.exit(1);
}
