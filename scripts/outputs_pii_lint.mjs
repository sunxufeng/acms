#!/usr/bin/env node
/**
 * outputs/ 入库前 PII 自检。
 *
 * 🔴 为什么需要它：**这个仓库是 public**。`outputs/` 里放的是设计稿 / 方案 / 上线前后截图，
 *    而截图与示例数据里**很容易夹带真实学生姓名、家长手机号、联系人昵称**。
 *    学生是未成年人 ⇒ 一旦推上去就是公开可检索的合规事故（而且 git 历史删不干净）。
 *
 * 判据（扫**已被 git 跟踪**的文件，不是扫工作区 —— 本地留着的"待脱敏"文件不该报警）：
 *   ① 结构性特征：邮箱 / 手机号 / 飞书 openId / 学籍号值 / 长十六进制串（token） / 私钥块 / 内网 IP
 *   ② 真实姓名：拿生产姓名清单比对。⚠️ 清单本身是 PII，**不进仓库** ——
 *      由环境变量 `ACMS_NAME_LIST=/path/to/names.txt`（一行一个名字）提供；
 *      没提供时只跑 ①，并在输出里明确说"姓名没查"。
 *
 * 用法：
 *   node scripts/outputs_pii_lint.mjs                 # 只查结构性特征
 *   ACMS_NAME_LIST=~/.acms-names.txt node scripts/outputs_pii_lint.mjs   # 连姓名一起查
 *   名字怎么拉：
 *     psql -A -t -c "SELECT coalesce(data->>'学生姓名','') FROM t_tbl2pevecjhnm8la WHERE coalesce(data->>'学生姓名','')<>''" > ~/.acms-names.txt
 *     psql -A -t -c "SELECT coalesce(data->>'姓名','') FROM t_tbltv6vao5x2967y WHERE coalesce(data->>'姓名','')<>''" >> ~/.acms-names.txt
 *
 * ⚠️ **截图（png/jpg）扫不了** —— 脚本只能提醒你人工过一眼，尤其这几类：
 *    家长/学生门户、学生记录、联系人去重、笔记与会议列表、参会人/部门树、成绩册（示例学生姓名）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const ROOT = 'outputs';

const PATTERNS = [
  ['邮箱', /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi],
  ['手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ['飞书 openId', /ou_[0-9a-f]{10,}/gi],
  ['学籍号值', /\b\d{2}(?:FA|SP)-[A-Z0-9]{1,4}-\d{3}\b/g],
  ['学生编号值', /\bSTU-\d{3,}\b/g],
  ['长十六进制串（疑似 token）', /\b[0-9a-f]{32,}\b/g],
  ['私钥块', /BEGIN [A-Z ]*PRIVATE KEY/g],
  ['内网 IP', /(?<![\d.])(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){1,3}(?![\d.])/g],
];

/** 只挑**已被跟踪**的文件：策略是「进仓库的必须干净」，本地待处理的不该让 lint 响 */
function trackedFiles() {
  try {
    // ⚠️ 必须关掉 `core.quotePath`：默认 git 会把中文路径输出成 C 风格转义
    //    （`"outputs/acms-\344\274\232..."`），带引号的名字既读不到文件、
    //    也会因为结尾不是 `.md` 而被当成二进制**静默跳过**（我第一版就踩了）。
    return execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', ROOT], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 文本类才逐字节扫；二进制（截图等）只登记 */
const isText = (f) => /\.(md|html?|txt|json|ya?ml|csv|tsx?|jsx?|css)$/i.test(f);

function loadNames() {
  const raw = process.env.ACMS_NAME_LIST || '';
  const p = raw.startsWith('~/') ? raw.replace('~', homedir()) : raw;
  if (!p) return null;
  if (!existsSync(p)) {
    console.error(`⚠️ ACMS_NAME_LIST 指向的文件不存在：${p}（本次不查姓名）`);
    return null;
  }
  const names = readFileSync(p, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .map((s) => s.split(/[｜|]/)[0].trim())
    .filter((s) => s.length > 1 && s.length <= 12);
  return [...new Set(names)];
}

const files = trackedFiles();
if (!files.length) {
  console.log(`[outputs-pii] ${ROOT}/ 下没有已跟踪的文件 —— 无需要检查的内容`);
  process.exit(0);
}

const names = loadNames();
const problems = [];
const shots = [];

for (const f of files) {
  if (!isText(f)) {
    shots.push(f);
    continue;
  }
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [label, re] of PATTERNS) {
    const hits = [...new Set(text.match(re) ?? [])];
    if (hits.length) {
      problems.push(`${f}\n      ${label} ×${hits.length}：${hits.slice(0, 4).join('、')}${hits.length > 4 ? ' …' : ''}`);
    }
  }
  if (names) {
    const hit = names.filter((n) => text.includes(n));
    if (hit.length) {
      problems.push(`${f}\n      真实姓名 ×${hit.length}：${hit.slice(0, 8).join('、')}${hit.length > 8 ? ' …' : ''}`);
    }
  }
}

console.log(`[outputs-pii] 已跟踪 ${files.length} 个文件（文本 ${files.length - shots.length} · 截图/二进制 ${shots.length}）`);
console.log(`[outputs-pii] 姓名比对：${names ? `已启用（${names.length} 个名字）` : '⚠️ 未启用（设 ACMS_NAME_LIST 才查）'}`);

if (problems.length) {
  console.error(`\n❌ 发现 ${problems.length} 处疑似真实数据 —— **不要提交**：\n  ` + problems.join('\n  '));
  console.error('\n  处理方式（三选一）：脱敏成占位值 / 不收进仓库 / 仓库转私有后再收。');
  process.exit(1);
}

console.log('✅ 结构性与姓名特征均未命中');
if (shots.length) {
  console.log(`\n⚠️ 另有 ${shots.length} 张截图**扫不了内容**，请人工过一眼（重点：家长/学生门户、学生记录、`);
  console.log('   联系人去重、笔记与会议列表、参会人/部门树、成绩册 —— 这些页面的示例数据里常有真实姓名）：');
  for (const s of shots.slice(0, 40)) console.log(`     ${s}`);
}
