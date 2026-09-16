#!/usr/bin/env node
/**
 * ACMS MCP Server（2026-09-16）—— 给 WorkBuddy、Claude Desktop 等 MCP 客户端用。
 *
 * ## 为什么 CLI 之外还要 MCP
 * Codex 这类工具靠命令行（`acms`），而 WorkBuddy 靠 **MCP 工具**。
 * 两者共用同一个 `acms-client.mjs`，只是入参形状不同 ——
 * 写两套客户端必然漂移，而漂移会体现在「CLI 能用、MCP 报错」这种最烦人的故障上。
 *
 * ## 零依赖
 * 手写 stdio JSON-RPC（每行一个 JSON 对象）。不引 `@modelcontextprotocol/sdk` 的原因同 CLI：
 * 生产不能跑 pnpm install，宿主机也不一定有依赖树。
 *
 * ## 安全取向
 *  - **默认只读**：令牌若是只读的，写方法直接拒（`acms_api` 只允许 GET）。
 *  - **不提供删记录 / 改分工具**：不是技术做不到，而是这类操作不该由 LLM 在对话里随手触发。
 *
 * ## 配置（`~/.workbuddy/mcp.json`）
 * ```json
 * { "mcpServers": { "acms": { "command": "acms-mcp",
 *   "env": { "ACMS_BASE_URL": "https://acms.areteailab.com", "ACMS_TOKEN": "acms-sk-…" } } } }
 * ```
 * 令牌也可以放在 `~/.acms/config.json`（先跑一次 `acms login` 即可），两种都认。
 */

import { AcmsError, EXIT, clientFromEnv, fetchAll, resolveAuth } from './acms-client.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'acms', version: '0.1.0' };

/** 标准输出必须是纯净的 JSON-RPC 流，日志一律走 stderr */
const log = (msg) => process.stderr.write(`[acms-mcp] ${msg}\n`);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ─────────────────────────────────────────────────────────────────────
// 会话状态
// ─────────────────────────────────────────────────────────────────────

let client = null;
/** `/auth/me` 的结果：身份 + limits（令牌是否只读） */
let me = null;
/** 模块清单缓存：key → { path, label, crud } */
let modules = null;

function ensureClient() {
  if (client) return client;
  const { client: c } = clientFromEnv();
  client = c;
  return c;
}

async function ensureIdentity() {
  if (me) return me;
  const c = ensureClient();
  const { data } = await c.get('/auth/me');
  me = data;
  return me;
}

function isReadOnly() {
  return Boolean(me?.limits?.readOnly);
}

async function ensureModules() {
  if (modules) return modules;
  const c = ensureClient();
  const { data } = await c.get('/schema');
  modules = new Map((data.modules ?? []).map((m) => [m.key, m]));
  return modules;
}

// ─────────────────────────────────────────────────────────────────────
// 工具实现
// ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'acms_whoami',
    description:
      '查看当前 ACMS 身份：姓名、角色、校区、密级、数据范围，以及本次凭证的限制项（是否只读、限定了哪些模块）。**建议第一步就调它** —— 先把「我是谁、能看什么」确定下来，再决定后续调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'acms_schema',
    description:
      '查询 ACMS 有哪些模块与字段。不传 module 时返回全部模块（含统一 CRUD 端点形状与筛选后缀语法）；传 module 时返回该模块的表与字段清单（字段名、类型、下拉选项）。ACMS 没有 OpenAPI，**靠这个接口自己发现能力**。',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模块 key，如 students / markbook / examGrades；省略则返回模块清单' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'acms_list',
    description:
      '按模块列出记录（只读）。只能用于 `acms_schema` 里 crud=true 的模块。支持 ACMS 的筛选语法：裸字段名=等值，`字段__contains`、`字段__has`、`字段__notempty`、`字段__empty`、`字段__gt`、`字段__lt`、`日期字段_from`/`_to`，全文关键词用 `q`。结果受当前令牌的数据范围限制。',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模块 key（crud=true）' },
        query: { type: 'object', description: '筛选条件，如 { "当前班级__contains": "Pre-1" }' },
        pageSize: { type: 'number', description: '每页条数，默认 50' },
        all: { type: 'boolean', description: '自动翻页拉完（默认 false，大表慎用）' },
      },
      required: ['module'],
      additionalProperties: false,
    },
  },
  {
    name: 'acms_get',
    description: '按 id 取单条记录（只读）。id 通常是 `rec_…` 形式的记录标识，可由 `acms_list` 得到。',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模块 key（crud=true）' },
        id: { type: 'string', description: '记录 id' },
      },
      required: ['module', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'acms_report',
    description:
      '跑 ACMS 内置报表，返回结构化结果。可用 key：students（学生结构）、notes（跟进记录）、activity（活跃度）、contact-dedup（联系方式去重）、attendance（出勤）、exam-dist（考试成绩分布）、exam-gpa（GPA 与排名）。',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['students', 'notes', 'activity', 'contact-dedup', 'attendance', 'exam-dist', 'exam-gpa'],
        },
        params: {
          type: 'object',
          description: '报表参数，常见：{ from, to, class, grade, batchId, cls, subject }',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
];

/** 写操作透传：**仅在令牌可写时注册** */
const API_TOOL = {
  name: 'acms_api',
  description:
    '直接调用 ACMS 的 REST 端点，用于覆盖未被上面工具策展的接口（全站 300+ 端点）。路径是 `/api/v1` **之后**的部分，如 `/exam-types?pageSize=5`。能用策展工具时优先用策展工具。当前令牌为只读时，本工具只允许 GET。',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', description: '如 /students 或 /exam-types?pageSize=5' },
      body: { type: 'object', description: '请求体（POST/PUT/PATCH），JSON 对象' },
      query: { type: 'object', description: '查询参数对象（会与 path 里已有的查询串合并）' },
    },
    required: ['method', 'path'],
    additionalProperties: false,
  },
};

const REPORT_PATHS = {
  students: '/reports/students',
  notes: '/reports/notes',
  activity: '/reports/activity',
  'contact-dedup': '/reports/contact-dedup',
  attendance: '/reports/attendance',
  'exam-dist': '/reports/exam-dist',
  'exam-gpa': '/reports/exam-gpa',
};

/** 把模块 key 解析成可用的 CRUD 路径（只读工具都走这里，避免各自猜路径） */
async function resolveModule(key) {
  const mods = await ensureModules();
  const m = mods.get(key);
  if (!m) {
    const sample = [...mods.keys()].slice(0, 12).join(', ');
    throw new AcmsError(`未知模块：${key}`, {
      code: 'UNKNOWN_MODULE',
      hint: `可用模块如：${sample}…（用 acms_schema 看全部）`,
    });
  }
  if (!m.crud) {
    throw new AcmsError(`模块「${m.label}」没有通用 CRUD，请用 acms_api 调它的专用接口`, {
      code: 'NO_CRUD',
      hint: `路径前缀是 ${m.path}`,
    });
  }
  return m;
}

async function callTool(name, args = {}) {
  const c = ensureClient();

  switch (name) {
    case 'acms_whoami': {
      const identity = await ensureIdentity();
      return { identity };
    }

    case 'acms_schema': {
      if (args.module) {
        const { data } = await c.get(`/schema/${encodeURIComponent(String(args.module))}`);
        return data;
      }
      const { data } = await c.get('/schema');
      return data;
    }

    case 'acms_list': {
      const m = await resolveModule(String(args.module));
      const query = { ...(args.query ?? {}) };
      if (args.all) {
        const rows = await fetchAll(c, m.path, { query, pageSize: Number(args.pageSize) || 200 });
        return { module: args.module, count: rows.length, items: rows };
      }
      const { data } = await c.get(m.path, {
        query: { ...query, pageSize: String(Number(args.pageSize) || 50) },
      });
      if (Array.isArray(data)) return { module: args.module, count: data.length, items: data };
      return { module: args.module, ...data };
    }

    case 'acms_get': {
      const m = await resolveModule(String(args.module));
      const { data } = await c.get(`${m.path}/${encodeURIComponent(String(args.id))}`);
      return data;
    }

    case 'acms_report': {
      const path = REPORT_PATHS[String(args.key)];
      if (!path) {
        throw new AcmsError(`未知报表：${args.key}`, {
          code: 'UNKNOWN_REPORT',
          hint: `可用：${Object.keys(REPORT_PATHS).join(' / ')}`,
        });
      }
      const { data } = await c.get(path, { query: args.params ?? {} });
      return data;
    }

    case 'acms_api': {
      const method = String(args.method ?? 'GET').toUpperCase();
      if (isReadOnly() && WRITE_METHODS.has(method)) {
        throw new AcmsError('当前令牌为只读，不能执行写操作', {
          code: 'TOKEN_READONLY',
          hint: '需要写入请让管理员在「令牌管理」里关掉只读开关。',
        });
      }
      const { data } = await c.request(method, String(args.path), {
        body: args.body,
        query: args.query,
      });
      return data;
    }

    default:
      throw new AcmsError(`未知工具：${name}`, { code: 'UNKNOWN_TOOL' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// JSON-RPC over stdio
// ─────────────────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        // 按客户端请求的协议版本回，降低版本不匹配的概率
        const want = params?.protocolVersion;
        sendResult(id, {
          protocolVersion: typeof want === 'string' && want ? want : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'ACMS 校务管理系统。默认只读。第一次调用请先 acms_whoami 确认身份与数据范围，' +
            '再用 acms_schema 发现可用模块与字段。注意：结果受当前令牌的数据范围限制，' +
            '「查到的比预期少」通常是范围限制而不是故障。',
        });
        return;
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // 通知无需响应

      case 'ping':
        sendResult(id, {});
        return;

      case 'tools/list': {
        // 先 ping 一次身份：既是「配好没有」的自检，也决定是否注册写工具
        let identityNote = '';
        try {
          await ensureIdentity();
          const auth = resolveAuth();
          identityNote = `\n\n当前身份：${me?.name ?? '—'}${isReadOnly() ? '（只读令牌）' : ''}；凭证来源：${auth.source === 'env' ? '环境变量' : '~/.acms/config.json'}。`;
        } catch (e) {
          identityNote = `\n\n⚠️ 尚未连通 ACMS：${e.message}`;
        }
        const tools = TOOLS.map((t) => ({ ...t, description: t.description + identityNote }));
        tools.push(API_TOOL);
        sendResult(id, { tools });
        return;
      }

      case 'tools/call': {
        const name = String(params?.name ?? '');
        try {
          const out = await callTool(name, params?.arguments ?? {});
          sendResult(id, {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            isError: false,
          });
        } catch (e) {
          const err = e instanceof AcmsError ? e : new AcmsError(String(e?.message ?? e));
          // 工具级失败走 isError（不是 JSON-RPC error）——客户端据此展示给模型，让它自己纠偏
          sendResult(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: false,
                    error: {
                      code: err.code || 'ERROR',
                      message: err.message,
                      hint: err.hint || '',
                      exitCode: err.exitCode ?? EXIT.BIZ,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          });
        }
        return;
      }

      default:
        if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log(`处理 ${method} 失败：${e?.stack ?? e}`);
    if (!isNotification) sendError(id, -32603, String(e?.message ?? e));
  }
}

let buffer = '';
/** 在途请求。见下方 `end` 处理：一次性管道输入时 stdin 会先 EOF，不能立刻退出 */
const inflight = new Set();

function dispatch(msg) {
  const p = handle(msg)
    .catch((e) => log(`处理失败：${e?.stack ?? e}`))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`忽略非 JSON 输入：${line.slice(0, 120)}`);
      continue;
    }
    dispatch(msg);
  }
});

process.stdin.on('end', async () => {
  /**
   * ⚠️ 必须等在途请求回完再退出。
   * MCP 客户端（以及 `printf … | acms-mcp` 这种一次性管道）会在收到响应**之前**
   * 就关闭 stdin；此时若直接 `process.exit(0)`，那些还没发出去的响应会被丢掉 ——
   * 表现是「第一次 tools/list 没有响应」，看起来像 server 挂了。
   */
  let guard = 0;
  while (inflight.size && guard < 300) {
    await Promise.all([...inflight]);
    guard += 1;
  }
  process.exit(0);
});
log(`已启动（协议 ${PROTOCOL_VERSION}）`);
