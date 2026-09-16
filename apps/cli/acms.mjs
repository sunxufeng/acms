#!/usr/bin/env node
/**
 * ACMS CLI（2026-09-16）。
 *
 * 让 Codex / 终端 / CI / 脚本以「一个有权限的账号」的身份读写 ACMS，
 * 而不是把浏览器 Cookie 抠出来塞进脚本。
 *
 * ## 设计取向
 *  - **策展命令 + 通用透传 + 能力发现** 三层。全站 300+ 端点不可能逐个策展，
 *    所以 `acms api <METHOD> <PATH>` 是必需的兜底；而 `acms schema` 让 agent
 *    能自己发现「有哪些模块、哪些字段」（仓库没有 OpenAPI）。
 *  - **退出码语义化**：3 = 认证失败（换令牌）、4 = 权限不足（换令牌没用，找管理员）。
 *    这两件事混在一起，使用者就会拿过期令牌去问管理员。
 *  - **`--json` 是给 agent 的稳定契约**：`{ ok, data, meta }`，
 *    与后端原始响应解耦（后端有的接口直接返回数组、有的返回 {items,total}）。
 *
 * ## 零依赖
 * 只用 Node 22 内置能力，没有构建步骤、没有 node_modules ——
 * 生产不能跑 pnpm install，Codex 宿主机也不一定有依赖树。
 */

import { readFileSync } from 'node:fs';
import {
  AcmsError,
  CONFIG_PATH,
  EXIT,
  clearConfig,
  clientFromEnv,
  createClient,
  fetchAll,
  loadConfig,
  resolveAuth,
  saveConfig,
} from './acms-client.mjs';

const VERSION = '0.1.0';

// ─────────────────────────────────────────────────────────────────────
// 参数解析（手写，零依赖）
// ─────────────────────────────────────────────────────────────────────

/**
 * 支持 `--k v`、`--k=v`、`--flag`（布尔）、重复出现（聚成数组）。
 * 位置参数进 `_`。
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let val;
      if (eq >= 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          val = next;
          i += 1;
        } else {
          val = true;
        }
      }
      if (key in flags) {
        flags[key] = Array.isArray(flags[key]) ? [...flags[key], val] : [flags[key], val];
      } else {
        flags[key] = val;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const asStr = (v) => (v === undefined || v === true ? '' : String(v));
const asBool = (v) => v === true || v === 'true' || v === '1';
/** 同一参数可重复（如 `--module a --module b`） */
const asList = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean));

// ─────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────

const NO_COLOR = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
const paint = (s, code) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint(s, '2');
const bold = (s) => paint(s, '1');
const cyan = (s) => paint(s, '36');
const green = (s) => paint(s, '32');
const yellow = (s) => paint(s, '33');
const red = (s) => paint(s, '31');

/** 去掉引号/换行，避免把表格列挤爆 */
function cell(v, width = 0) {
  let s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = `${s.slice(0, 79)}…`;
  if (!width) return s;
  // 中文按 2 列宽估算（够用：目的是让列大致对齐，不是像素级排版）
  const w = (t) => [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
  const cur = w(s);
  return cur >= width ? s : s + ' '.repeat(width - cur);
}

/** 极简表格：给定列定义渲染行 */
function renderTable(rows, cols) {
  if (!rows.length) return dim('（无数据）');
  const widths = cols.map((c) => {
    const head = cell(c.label).length;
    const body = rows.reduce((m, r) => Math.max(m, cell(c.get(r)).length), 0);
    return Math.min(40, Math.max(head, body) + 2);
  });
  const head = cols.map((c, i) => dim(cell(c.label, widths[i]))).join('');
  const lines = rows.map((r) => cols.map((c, i) => cell(c.get(r), widths[i])).join(''));
  return [head, ...lines].join('\n');
}

/**
 * 统一输出。
 * `--json` 走稳定信封（给 agent）；否则人类可读。
 */
function emit(data, { meta = {}, human } = {}) {
  if (JSON_GLOBAL) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data, meta: { baseUrl: META_BASE, ...meta } }, null, 2)}\n`,
    );
    return;
  }
  if (human) {
    process.stdout.write(`${human(data)}\n`);
    return;
  }
  if (Array.isArray(data)) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** 打印告知性信息（人类模式才显示，避免污染 --json 的 stdout） */
function note(text) {
  if (!JSON_GLOBAL) process.stderr.write(`${text}\n`);
}

let JSON_GLOBAL = false;
let META_BASE = '';

function fail(err) {
  const e = err instanceof AcmsError ? err : new AcmsError(String(err?.message ?? err));
  if (JSON_GLOBAL) {
    process.stdout.write(
      `${JSON.stringify(
        { ok: false, error: { code: e.code || 'ERROR', message: e.message, hint: e.hint || '' } },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(`${red('✗')} ${e.message}\n`);
    if (e.code) process.stderr.write(`  ${dim('code')}  ${e.code}   ${dim('退出码')} ${e.exitCode}\n`);
    if (e.hint) process.stderr.write(`  ${dim('hint')}  ${yellow(e.hint)}\n`);
  }
  process.exit(e.exitCode ?? EXIT.BIZ);
}

// ─────────────────────────────────────────────────────────────────────
// 命令
// ─────────────────────────────────────────────────────────────────────

const HELP = `
${bold('ACMS CLI')} ${dim(`v${VERSION}`)} —— 校务管理系统的命令行入口（CLI / MCP 接入）

${bold('接入')}
  acms login --token <acms-sk-…> [--base <url>]   保存令牌到 ~/.acms/config.json（0600）
  acms logout                                     清除本地令牌
  acms whoami                                     我是谁 / 角色 / 校区 / 数据范围
  acms doctor                                     逐项自检：配置 / 网络 / 鉴权 / 权限 / 范围

${bold('能力发现（给 agent 用）')}
  acms schema                                     全部模块（48 个）+ 统一端点形状 + 筛选后缀
  acms schema <模块>                              该模块的表与字段（名称 / 类型 / 选项）

${bold('学生')}
  acms student list [--class X] [--status X] [--q 关键词] [--all]
  acms student get <id|姓名>
  acms student 360 <id>

${bold('教学')}
  acms markbook classes                           成绩册里有数据的班级
  acms markbook grid --class <班级>
  acms exam batches                               成绩批次
  acms exam term-grades --batch <批次> [--class X] [--subject X]
  acms exam dist --batch <批次> [--class X] [--subject X]
  acms exam report-card --student <id> --batch <批次> [--pdf 文件]

${bold('其他')}
  acms report <students|notes|activity|contact-dedup|attendance|exam-dist|exam-gpa> [...]
  acms api <GET|POST|PUT|PATCH|DELETE> <路径> [--data '<json>' | --data @file] [--query k=v]

${bold('通用选项')}
  --json        机器可读输出（稳定信封 { ok, data, meta }）
  --base <url>  覆盖服务地址
  --all         自动翻页拉完（列表类命令）

${bold('退出码')}
  0 成功 · 1 业务错误 · 2 用法错误 · 3 ${yellow('认证失败（换令牌）')} · 4 ${yellow('权限不足（找管理员）')} · 5 网络/服务端
`;

/** 当前身份 + 数据范围。`/auth/me` + `/students/my-scope` 组合出「我能看到谁」 */
async function cmdWhoami(client) {
  const { data: me } = await client.get('/auth/me');
  let scope = null;
  try {
    const r = await client.get('/students/my-scope');
    scope = r.data;
  } catch {
    scope = null; // 没有学生档案权限时会 403，不影响 whoami
  }
  const human = (d) => {
    const lim = d.limits;
    const lines = [
      `${bold(d.name)}  ${dim(d.openId ?? '')}`,
      `  ${dim('角色')}    ${(d.roles ?? []).join('、') || '（无）'}`,
      `  ${dim('校区')}    ${(d.campuses ?? []).join('、') || '（无）'}`,
      `  ${dim('密级')}    ${d.maxDataLevel ?? '—'}`,
      `  ${dim('凭证')}    ${d.authVia === 'token' ? 'API 令牌' : '会话'}`,
    ];
    // 令牌的限制项 —— agent 必须先知道自己能不能写、能进哪些模块，
    // 否则会一路试错（每次试错都是一次 403）
    if (lim) {
      lines.push(
        `  ${dim('读写')}    ${lim.readOnly ? yellow('只读（不能提交修改）') : green('可写')}`,
      );
      lines.push(
        `  ${dim('模块')}    ${
          (lim.modules ?? []).length ? (lim.modules ?? []).join('、') : dim('不限')
        }`,
      );
    }
    lines.push(`  ${dim('数据范围')} ${d.scope?.note ?? '—'}`);
    return lines.join('\n');
  };
  emit({ ...me, scope: scope ?? undefined }, { human, meta: { endpoint: '/auth/me' } });
}

/** 逐项自检 —— 一次把「为什么用不了」定位到具体环节 */
async function cmdDoctor(client, auth) {
  const steps = [];
  const ok = (label, detail = '') => steps.push({ ok: true, label, detail });
  const bad = (label, detail = '') => steps.push({ ok: false, label, detail });
  const warn = (label, detail = '') => steps.push({ ok: 'warn', label, detail });

  ok('配置', auth.source === 'env' ? '来自环境变量 ACMS_TOKEN' : CONFIG_PATH);
  if (auth.source === 'config') {
    try {
      const st = readFileSync(CONFIG_PATH, 'utf8');
      ok('令牌', `已保存（${st.length} 字节）`);
    } catch {
      warn('令牌', '配置文件读取失败');
    }
  }

  const t0 = Date.now();
  let me = null;
  try {
    const r = await client.get('/auth/me');
    me = r.data;
    ok('网络与鉴权', `${client.apiBase} 可达（${Date.now() - t0}ms）`);
    ok('身份', `${me.name} · ${(me.roles ?? []).join('、') || '无角色'}`);
    if (me.authVia === 'token') ok('凭证类型', 'API 令牌');
  } catch (e) {
    if (e.exitCode === EXIT.AUTH) bad('鉴权', `${e.message}${e.hint ? ` — ${e.hint}` : ''}`);
    else bad('网络或服务', e.message);
    report();
    return;
  }

  // 能力发现
  try {
    const { data } = await client.get('/schema');
    ok('能力发现', `${data.total} 个模块可查询（acms schema）`);
  } catch (e) {
    warn('能力发现', `/schema 不可用：${e.message}`);
  }

  // 学生数据范围（最能解释「为什么查不到数据」）
  try {
    const { data } = await client.get('/students/my-scope');
    const note = data?.note ?? JSON.stringify(data).slice(0, 120);
    if (data?.restricted) warn('学生数据范围', `${note} —— 这是正常的范围限制，不是故障`);
    else ok('学生数据范围', note);
  } catch (e) {
    warn('学生数据范围', `不可用：${e.code || e.message}`);
  }

  // 写权限探测：拿一个只读安全的探测（GET）判断能否写入是做不到的，
  // 所以这里只提示「令牌是否只读」，不真的发写请求（doctor 不该产生副作用）
  try {
    const { data: list } = await client.get('/students', { query: { pageSize: '1' } });
    const n = Array.isArray(list) ? list.length : (list?.total ?? list?.items?.length ?? 0);
    ok('读取探测', `/students 返回 ${n} 条`);
  } catch (e) {
    warn('读取探测', `/students 不可用：${e.code || e.message}`);
  }

  report();

  function report() {
    const human = (d) => {
      const icon = (s) => (s === true ? green('✓') : s === false ? red('✗') : yellow('!'));
      return d.steps.map((s) => `${icon(s.ok)} ${cell(s.label, 16)}${s.detail ? dim(s.detail) : ''}`).join('\n');
    };
    emit({ steps, baseUrl: client.baseUrl, tokenSource: auth.source }, { human });
  }
}

async function cmdSchema(client, positional) {
  const key = positional[0];
  if (!key) {
    const { data } = await client.get('/schema');
    const human = (d) => {
      const byModule = d.modules ?? [];
      const lines = [
        `${bold('模块')} ${dim(`共 ${d.total} 个`)}`,
        '',
        renderTable(byModule, [
          { label: 'key', get: (r) => r.key },
          { label: '名称', get: (r) => r.label },
          { label: '路径', get: (r) => r.path },
          { label: 'CRUD', get: (r) => (r.crud ? '✓' : '') },
        ]),
        '',
        dim('统一端点形状（crud=true 的模块都适用）：'),
        ...Object.entries(d.crudShape ?? {}).map(([k, v]) => `  ${dim(k.padEnd(11))}${v}`),
        '',
        dim('筛选后缀：'),
        ...Object.entries(d.filterSuffix ?? {}).map(([k, v]) => `  ${dim(k.padEnd(11))}${v}`),
        '',
        dim('提示：`acms schema <key>` 看该模块的表与字段；`acms api GET <路径>` 直接读。'),
      ];
      return lines.join('\n');
    };
    emit(data, { human, meta: { endpoint: '/schema' } });
    return;
  }

  const { data } = await client.get(`/schema/${encodeURIComponent(key)}`);
  const human = (d) => {
    const lines = [
      `${bold(d.label)} ${dim(`(${d.key})`)}`,
      `  ${dim('路径')}   ${d.path}`,
      `  ${dim('动作')}   ${(d.actions ?? []).join(', ')}`,
      `  ${dim('表')}     ${d.tableId ?? '—'} ${d.tableName ? dim(`(${d.tableName})`) : ''}`,
      `  ${dim('字段')}   ${d.fieldCount} 个`,
      '',
      renderTable(d.fields ?? [], [
        { label: '字段', get: (r) => r.name },
        { label: '类型', get: (r) => r.typeName },
        { label: '选项', get: (r) => (r.options ?? []).join(' / ') },
      ]),
      '',
      dim(d.hint ?? ''),
    ];
    return lines.join('\n');
  };
  emit(data, { human, meta: { endpoint: `/schema/${key}` } });
}

/** 通用透传：覆盖未策展的 300+ 端点 */
async function cmdApi(client, positional, flags) {
  const [methodRaw, path] = positional;
  if (!methodRaw || !path) {
    throw new AcmsError('用法：acms api <GET|POST|PUT|PATCH|DELETE> <路径> [--data <json>]', {
      exitCode: EXIT.USAGE,
    });
  }
  const method = methodRaw.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new AcmsError(`不支持的方法：${methodRaw}`, { exitCode: EXIT.USAGE });
  }

  let body;
  const raw = asStr(flags.data);
  if (raw) {
    body = raw.startsWith('@')
      ? readFileSync(raw.slice(1), 'utf8')
      : raw;
    // 提前校验 JSON，避免把语法错误发到服务端（那边只会回一个含糊的 400）
    try {
      JSON.parse(body);
    } catch (e) {
      throw new AcmsError(`--data 不是合法 JSON：${e.message}`, { exitCode: EXIT.USAGE });
    }
  }

  const query = {};
  for (const kv of asList(flags.query)) {
    const i = kv.indexOf('=');
    if (i > 0) query[kv.slice(0, i)] = kv.slice(i + 1);
  }

  const { data } = await client.request(method, path, { body, query });
  const human = (d) => {
    if (Array.isArray(d)) {
      return `${renderTable(d.slice(0, 50), Object.keys(d[0] ?? {}).slice(0, 6).map((k) => ({ label: k, get: (r) => r[k] })))}\n${dim(
        `共 ${d.length} 条${d.length > 50 ? '（只显示前 50）' : ''}`,
      )}`;
    }
    if (Array.isArray(d?.items)) {
      const cols = Object.keys(d.items[0] ?? {}).slice(0, 6).map((k) => ({ label: k, get: (r) => r[k] }));
      return `${renderTable(d.items.slice(0, 50), cols)}\n${dim(`共 ${d.total ?? d.items.length} 条`)}`;
    }
    return JSON.stringify(d, null, 2);
  };
  emit(data, { human, meta: { method, path } });
}

// ── 策展：学生 ────────────────────────────────────────────────────────

async function cmdStudent(client, sub, positional, flags) {
  if (sub === 'list') {
    const query = {};
    if (asStr(flags.class)) query['当前班级__contains'] = asStr(flags.class);
    if (asStr(flags.grade)) query['当前年级'] = asStr(flags.grade);
    if (asStr(flags.status)) query['当前状态'] = asStr(flags.status);
    if (asStr(flags.q)) query.q = asStr(flags.q);
    if (asList(flags.filter).length) {
      for (const kv of asList(flags.filter)) {
        const i = kv.indexOf('=');
        if (i > 0) query[kv.slice(0, i)] = kv.slice(i + 1);
      }
    }

    let rows;
    if (asBool(flags.all)) {
      rows = await fetchAll(client, '/students', { query, pageSize: 200 });
    } else {
      const { data } = await client.get('/students', {
        query: { ...query, pageSize: asStr(flags['page-size']) || '50' },
      });
      rows = Array.isArray(data) ? data : (data?.items ?? []);
    }

    const human = (d) =>
      `${renderTable(d, [
        { label: '姓名', get: (r) => r['学生姓名'] ?? r.name },
        { label: '英文名', get: (r) => r['英文名'] ?? r.englishName },
        { label: '当前班级', get: (r) => r['当前班级'] ?? r.className },
        { label: '当前状态', get: (r) => r['当前状态'] ?? r.status },
        { label: '校区', get: (r) => (Array.isArray(r['所在校区']) ? r['所在校区'].join('/') : r['所在校区']) },
      ])}\n${dim(`共 ${d.length} 条`)}`;

    emit(rows, { human, meta: { count: rows.length, endpoint: '/students', query } });
    return;
  }

  if (sub === 'get') {
    const key = positional[0];
    if (!key) throw new AcmsError('用法：acms student get <id|姓名>', { exitCode: EXIT.USAGE });
    // 姓名走精确匹配（`is`），避免「张三」命中「张三丰」；id 走 contains 以兼容前缀
    const looksLikeId = /^rec[_A-Za-z0-9-]+$/.test(key);
    const { data } = await client.get('/students', {
      query: looksLikeId ? { 'id__contains': key, pageSize: '2' } : { 学生姓名: key, pageSize: '2' },
    });
    const rows = Array.isArray(data) ? data : (data?.items ?? []);
    if (!rows.length) {
      throw new AcmsError(`未找到学生：${key}`, { code: 'NOT_FOUND', exitCode: EXIT.BIZ });
    }
    if (rows.length > 1 && !looksLikeId) {
      throw new AcmsError(`「${key}」匹配到 ${rows.length} 条，请用更完整的姓名或 id`, {
        code: 'AMBIGUOUS',
        exitCode: EXIT.BIZ,
        hint: '用 `acms student list --q 关键词` 先看清有哪些人。',
      });
    }
    const human = (d) =>
      Object.entries(d)
        .filter(([, v]) => v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => `${dim(cell(k, 14))}${Array.isArray(v) ? v.join('、') : v}`)
        .join('\n');
    emit(rows[0], { human, meta: { endpoint: '/students', matched: rows.length } });
    return;
  }

  if (sub === '360') {
    const id = positional[0];
    if (!id) throw new AcmsError('用法：acms student 360 <id>', { exitCode: EXIT.USAGE });
    const { data } = await client.get(`/student-360/${encodeURIComponent(id)}`);
    const human = (d) => {
      const lines = [`${bold(d.student?.姓名 ?? id)}`];
      for (const s of d.sections ?? []) {
        lines.push('', `${cyan(s.label)} ${dim(`(${(s.items ?? []).length} 条)`)}`);
        for (const it of (s.items ?? []).slice(0, 5)) {
          const brief = Object.entries(it)
            .filter(([k]) => k !== 'id')
            .slice(0, 4)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`)
            .join('  ');
          lines.push(`  ${brief}`);
        }
        if ((s.items ?? []).length > 5) lines.push(dim(`  … 其余 ${s.items.length - 5} 条`));
      }
      return lines.join('\n');
    };
    emit(data, { human, meta: { endpoint: `/student-360/${id}` } });
    return;
  }

  throw new AcmsError(`未知子命令：student ${sub ?? ''}`, {
    exitCode: EXIT.USAGE,
    hint: '可用：list / get / 360',
  });
}

// ── 策展：教学 ────────────────────────────────────────────────────────

async function cmdMarkbook(client, sub, flags) {
  if (sub === 'classes') {
    const { data } = await client.get('/markbook/classes');
    const rows = Array.isArray(data) ? data : (data?.items ?? []);
    emit(rows, {
      human: (d) => (d.length ? d.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : dim('（无）')),
    });
    return;
  }
  if (sub === 'grid') {
    const cls = asStr(flags.class);
    if (!cls) throw new AcmsError('用法：acms markbook grid --class <班级>', { exitCode: EXIT.USAGE });
    const { data } = await client.get('/markbook/grid', { query: { cls } });
    const human = (d) => {
      const cols = (d.columns ?? []).length;
      const students = (d.students ?? []).length;
      const cells = (d.cells ?? []).length;
      return [
        `${bold(cls)}  列 ${cols} 个 · 学生 ${students} 人 · 已录 ${cells} 格`,
        '',
        ...(d.columns ?? []).slice(0, 12).map(
          (c) =>
            `  ${cell(c.name, 20)} ${dim(`类型=${c.type || '—'} 权重=${c.weight} 满分=${c.fullMark} 科目=${c.subject || '—'}`)}`,
        ),
        cols > 12 ? dim(`  … 其余 ${cols - 12} 列`) : '',
      ]
        .filter(Boolean)
        .join('\n');
    };
    emit(data, { human, meta: { endpoint: '/markbook/grid', cls } });
    return;
  }
  throw new AcmsError(`未知子命令：markbook ${sub ?? ''}`, {
    exitCode: EXIT.USAGE,
    hint: '可用：classes / grid',
  });
}

async function cmdExam(client, sub, positional, flags) {
  if (sub === 'batches') {
    const { data } = await client.get('/exam-grades/batches');
    const rows = Array.isArray(data) ? data : (data?.items ?? []);
    emit(rows, {
      human: (d) =>
        d.length
          ? renderTable(d, [
              { label: '批次', get: (r) => r.name },
              { label: '学年', get: (r) => r.year },
              { label: '学期', get: (r) => r.term },
              { label: '状态', get: (r) => r.status },
              { label: 'id', get: (r) => r.id },
            ])
          : dim('（没有成绩批次。先到「考试与成绩 → 成绩批次」建一个）'),
    });
    return;
  }

  if (sub === 'term-grades') {
    const batchId = asStr(flags.batch);
    if (!batchId) throw new AcmsError('用法：acms exam term-grades --batch <批次>', { exitCode: EXIT.USAGE });
    const { data } = await client.get('/exam-grades/term-grades', {
      query: { batchId, cls: asStr(flags.class), subject: asStr(flags.subject) },
    });
    const rows = data?.rows ?? [];
    emit(data, {
      human: () =>
        `${renderTable(rows.slice(0, 50), [
          { label: '学生', get: (r) => r.studentName },
          { label: '科目', get: (r) => r.subject },
          { label: '总评', get: (r) => r.total },
          { label: '等级', get: (r) => r.level },
          { label: '班内排名', get: (r) => (r.rank == null ? '—' : `${r.rank}/${r.rankTotal}`) },
          { label: '状态', get: (r) => r.status },
        ])}\n${dim(`共 ${rows.length} 条`)}`,
    });
    return;
  }

  if (sub === 'dist') {
    const batchId = asStr(flags.batch);
    if (!batchId) throw new AcmsError('用法：acms exam dist --batch <批次>', { exitCode: EXIT.USAGE });
    const { data } = await client.get('/reports/exam-dist', {
      query: { batchId, cls: asStr(flags.class), subject: asStr(flags.subject) },
    });
    const human = (d) => {
      if (d.reason) return dim(d.reason);
      const s = d.summary ?? {};
      return [
        `${bold(d.batchName)}  学生 ${s.students} 人 · 记录 ${s.records} 条`,
        `  平均 ${s.avg ?? '—'} · 中位 ${s.median ?? '—'} · 及格率 ${s.passRate ?? '—'}% · 达标率 ${s.attainedRate ?? '—'}%`,
        '',
        dim('分数段：'),
        ...(d.bands ?? []).map((b) => `  ${cell(b.label, 10)}${'█'.repeat(Math.min(40, b.count))} ${b.count}`),
        '',
        dim(d.scopeNote ?? ''),
      ].join('\n');
    };
    emit(data, { human });
    return;
  }

  if (sub === 'report-card') {
    const studentId = asStr(flags.student);
    const batchId = asStr(flags.batch);
    if (!studentId || !batchId) {
      throw new AcmsError('用法：acms exam report-card --student <id> --batch <批次> [--pdf 文件]', {
        exitCode: EXIT.USAGE,
      });
    }
    const pdfPath = asStr(flags.pdf);
    if (pdfPath) {
      const url = `${client.apiBase}/exam-grades/report-card.pdf?studentId=${encodeURIComponent(
        studentId,
      )}&batchId=${encodeURIComponent(batchId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${resolveAuth().token}` },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new AcmsError(`导出 PDF 失败 HTTP ${res.status}：${t.slice(0, 200)}`, {
          exitCode: res.status === 403 ? EXIT.FORBIDDEN : EXIT.BIZ,
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import('node:fs');
      writeFileSync(pdfPath, buf);
      emit({ file: pdfPath, bytes: buf.length }, {
        human: (d) => `${green('✓')} 已导出 ${d.file}（${(d.bytes / 1024).toFixed(1)} KB）`,
      });
      return;
    }
    const { data } = await client.get('/exam-grades/report-card', { query: { studentId, batchId } });
    const human = (d) => {
      if (!d) return dim('（没有找到成绩单，可能该批次还没结转）');
      return [
        `${bold(d.studentName)}  ${dim(d.cls ?? '')}`,
        '',
        renderTable(d.subjects ?? [], [
          { label: '科目', get: (r) => r.subject },
          { label: '总评', get: (r) => r.total },
          { label: '等级', get: (r) => r.level },
          { label: '班内排名', get: (r) => (r.rank == null ? '—' : `${r.rank}/${r.rankTotal}`) },
          { label: '任课评语', get: (r) => r.comment },
        ]),
        '',
        `  加权 GPA ${d.gpa?.weighted ?? '—'} · 班内排名 ${d.rank ?? '—'}/${d.rankTotal ?? '—'}`,
        d.summaryComment ? `  班主任评语：${d.summaryComment}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    };
    emit(data, { human });
    return;
  }

  throw new AcmsError(`未知子命令：exam ${sub ?? ''}`, {
    exitCode: EXIT.USAGE,
    hint: '可用：batches / term-grades / dist / report-card',
  });
}

async function cmdReport(client, sub, flags) {
  const map = {
    students: '/reports/students',
    notes: '/reports/notes',
    activity: '/reports/activity',
    'contact-dedup': '/reports/contact-dedup',
    attendance: '/reports/attendance',
    'exam-dist': '/reports/exam-dist',
    'exam-gpa': '/reports/exam-gpa',
  };
  const path = map[sub];
  if (!path) {
    throw new AcmsError(`未知报表：${sub ?? ''}`, {
      exitCode: EXIT.USAGE,
      hint: `可用：${Object.keys(map).join(' / ')}`,
    });
  }
  const query = {};
  for (const kv of asList(flags.query)) {
    const i = kv.indexOf('=');
    if (i > 0) query[kv.slice(0, i)] = kv.slice(i + 1);
  }
  for (const k of ['from', 'to', 'class', 'grade', 'batchId', 'cls', 'subject']) {
    if (asStr(flags[k])) query[k] = asStr(flags[k]);
  }
  const { data } = await client.get(path, { query });
  emit(data, { human: (d) => JSON.stringify(d, null, 2), meta: { endpoint: path, query } });
}

// ─────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  JSON_GLOBAL = asBool(flags.json) || asBool(flags.j);

  const cmd = positional[0] ?? 'help';
  const auth0 = resolveAuth();
  META_BASE = asStr(flags.base) || auth0.baseUrl;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (cmd === 'login') {
    const token = asStr(flags.token).trim();
    if (!token) {
      throw new AcmsError('用法：acms login --token <acms-sk-…> [--base <url>]', { exitCode: EXIT.USAGE });
    }
    const base = asStr(flags.base) || auth0.baseUrl;
    // 先验证再落盘：避免把一个错的令牌写进去，之后每个命令都莫名其妙失败
    const probe = createClient({ baseUrl: base, token });
    const { data: me } = await probe.get('/auth/me');
    saveConfig({ baseUrl: base, token, savedAt: new Date().toISOString() });
    emit(
      { baseUrl: base, name: me.name, configPath: CONFIG_PATH },
      {
        human: (d) =>
          `${green('✓')} 已保存到 ${d.configPath}（权限 0600）\n  ${dim('身份')} ${d.name}\n  ${dim('地址')} ${d.baseUrl}`,
      },
    );
    return;
  }

  if (cmd === 'logout') {
    clearConfig();
    emit({ cleared: true }, { human: () => `${green('✓')} 已清除本地令牌（${CONFIG_PATH}）` });
    return;
  }

  const { client } = clientFromEnv();

  switch (cmd) {
    case 'whoami':
      return cmdWhoami(client);
    case 'doctor':
      return cmdDoctor(client, auth0);
    case 'schema':
      return cmdSchema(client, positional.slice(1));
    case 'api':
      return cmdApi(client, positional.slice(1), flags);
    case 'student':
      return cmdStudent(client, positional[1], positional.slice(2), flags);
    case 'markbook':
      return cmdMarkbook(client, positional[1], flags);
    case 'exam':
      return cmdExam(client, positional[1], positional.slice(2), flags);
    case 'report':
      return cmdReport(client, positional[1], flags);
    default:
      throw new AcmsError(`未知命令：${cmd}`, {
        exitCode: EXIT.USAGE,
        hint: '执行 `acms help` 看可用命令。',
      });
  }
}

main().catch(fail);
