/**
 * ACMS CLI / MCP **共用的 HTTP 客户端**（2026-09-16）。
 *
 * 为什么 CLU 与 MCP 必须共用这一份：两边都要处理鉴权、分页、错误映射、
 * 退出码语义。写两套必然漂移 —— 而「token 失效」和「权限不足」分不清，
 * 使用者就会拿着过期的令牌去找管理员（或反过来），这种漂移在运维上很贵。
 *
 * ## 零依赖
 * 只用 Node 22 内置能力（`fetch` / `node:fs`）。原因：
 *  - 生产不能跑 `pnpm install`（会重建整个 node_modules，两个 slot 共用、失败即全站不可用）
 *  - Codex / 脚本宿主机不一定有依赖树，也不一定允许联网装包
 * 所以整个 CLI 是「拷几个 .mjs 文件就能跑」，没有构建步骤。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 退出码语义（脚本与 agent 靠它分支，别随意改） */
export const EXIT = {
  OK: 0,
  /** 业务错误：校验失败、找不到记录 */
  BIZ: 1,
  /** 用法错误：参数写错 */
  USAGE: 2,
  /** 认证失败：令牌无效/过期/已吊销 ⇒ **该换令牌** */
  AUTH: 3,
  /** 权限不足：认证没问题，是没授权/被限制 ⇒ **换令牌没用，找管理员** */
  FORBIDDEN: 4,
  /** 网络或服务端错误 ⇒ 可重试 */
  NETWORK: 5,
};

/** 这两类 403 的含义完全不同，必须分开（详见 EXIT 注释） */
const AUTH_403_CODES = new Set([
  'TOKEN_NOT_FOUND',
  'TOKEN_EXPIRED',
  'TOKEN_DISABLED',
  'TOKEN_INVALID_FORMAT',
  'TOKEN_IP_FORBIDDEN',
  'TOKEN_NO_USER',
]);

export class AcmsError extends Error {
  constructor(message, { code = '', status = 0, hint = '', exitCode = EXIT.BIZ } = {}) {
    super(message);
    this.name = 'AcmsError';
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export const CONFIG_PATH =
  process.env.ACMS_CONFIG || join(homedir(), '.acms', 'config.json');

const DEFAULT_BASE = 'https://acms.areteailab.com';

/** 读本地配置（不存在返回空对象，不抛） */
export function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 写本地配置，**权限 0600**（里面存着令牌明文，不能给别人读） */
export function saveConfig(cfg) {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod，忽略 */
  }
}

export function clearConfig() {
  try {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } catch {
    /* ignore */
  }
}

/**
 * 解析生效的凭证。
 * 环境变量优先于配置文件 —— CI 里不该往磁盘写令牌。
 */
export function resolveAuth() {
  const cfg = loadConfig();
  const baseUrl = String(process.env.ACMS_BASE_URL || cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const fromEnv = Boolean(process.env.ACMS_TOKEN);
  const token = String(process.env.ACMS_TOKEN || cfg.token || '').trim();
  return { baseUrl, token, source: fromEnv ? 'env' : 'config', configPath: CONFIG_PATH };
}

/** 错误消息里前缀的机器码（我们自己的异常都用 `CODE: 人话` 的形式） */
function leadingCode(message) {
  const m = /^([A-Z][A-Z0-9_]{2,})\b/.exec(String(message ?? '').trim());
  return m ? m[1] : '';
}

/** 按状态码 + 机器码决定退出码（这是 CLI 最需要想清楚的一处） */
function classify(status, code) {
  if (status === 401) return EXIT.AUTH;
  if (status === 403) return AUTH_403_CODES.has(code) ? EXIT.AUTH : EXIT.FORBIDDEN;
  if (status === 429) return EXIT.NETWORK; // 限流，可重试
  if (status >= 500) return EXIT.NETWORK;
  if (status >= 400) return EXIT.BIZ;
  return EXIT.BIZ;
}

/** 按机器码给出「下一步该怎么办」——比错误本身更有用 */
function hintFor(code) {
  switch (code) {
    case 'TOKEN_NOT_FOUND':
    case 'TOKEN_INVALID_FORMAT':
      return '令牌无效：请确认复制完整，或让管理员在「令牌管理」里重新签发。';
    case 'TOKEN_EXPIRED':
      return '令牌已过期：请让管理员在「令牌管理」里延长有效期，或重新签发。';
    case 'TOKEN_DISABLED':
    case 'TOKEN_PATH_FORBIDDEN':
      return '令牌已被停用/不允许访问该地址：请联系管理员。';
    case 'TOKEN_IP_FORBIDDEN':
      return '当前 IP 不在该令牌的白名单内：请让管理员把出口 IP 加进去。';
    case 'TOKEN_READONLY':
      return '这是只读令牌。需要写入请让管理员在「令牌管理」里关掉只读开关。';
    case 'TOKEN_MODULE_DENIED':
      return '该令牌只允许访问指定模块：请让管理员把它需要的模块加进白名单。';
    case 'UNAUTHENTICATED':
      return '未提供凭证：先执行 `acms login --token <令牌>`，或设置 ACMS_TOKEN 环境变量。';
    case 'ADMIN_ONLY':
      return '需要系统管理员身份。';
    default:
      return '';
  }
}

/**
 * 建一个客户端。
 *
 * `path` 一律是 `/api/v1` **之后**的部分（如 `/students`），
 * 这样调用点看到的路径与浏览器开发者工具里一致，排查时不用做心算。
 */
export function createClient({ baseUrl, token, timeoutMs = 30000 } = {}) {
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/v1`;

  async function request(method, path, { body, query, retries = 2 } = {}) {
    const url = new URL(apiBase + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      if (typeof body === 'string') {
        headers['Content-Type'] = 'application/json';
        payload = body;
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastErr = e;
        // 部署/重启时会有短暂连接失败；这类请求多半没抵达后端，重试安全
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        throw new AcmsError(`无法连接 ${baseUrl}：${e.message}`, {
          code: 'NETWORK',
          exitCode: EXIT.NETWORK,
          hint: '检查网络与 ACMS_BASE_URL；服务在部署重启时可能有几秒不可用。',
        });
      }

      // 502/503/504 视作瞬时上游错误
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (res.ok) return { data, status: res.status, headers: res.headers };

      const message =
        (data && typeof data === 'object' && (data.message || data.error)) || `HTTP ${res.status}`;
      const code = leadingCode(message) || (data?.code ?? '');
      const exitCode = classify(res.status, code);
      throw new AcmsError(String(message), {
        code,
        status: res.status,
        exitCode,
        hint: hintFor(code),
      });
    }
    throw new AcmsError(lastErr?.message ?? '未知网络错误', { exitCode: EXIT.NETWORK });
  }

  return {
    apiBase,
    baseUrl,
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, b, o) => request('POST', p, { ...o, body: b }),
    put: (p, b, o) => request('PUT', p, { ...o, body: b }),
    patch: (p, b, o) => request('PATCH', p, { ...o, body: b }),
    del: (p, o) => request('DELETE', p, o),
  };
}

/** 从「已解析的鉴权」直接建客户端（找不到令牌就抛出带 AUTH 退出码的错误） */
export function clientFromEnv() {
  const auth = resolveAuth();
  if (!auth.token) {
    throw new AcmsError('未配置令牌', {
      code: 'NO_TOKEN',
      exitCode: EXIT.AUTH,
      hint: '执行 `acms login --token <令牌>`，或设置 ACMS_TOKEN 环境变量。',
    });
  }
  return { client: createClient({ baseUrl: auth.baseUrl, token: auth.token }), auth };
}

/** 自动翻页拉完（带最大页数保护，避免脚本把库拉爆） */
export async function fetchAll(client, path, { query = {}, pageSize = 500, maxPages = 40 } = {}) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < maxPages; i += 1) {
    const { data } = await client.get(path, {
      query: { ...query, pageSize: String(pageSize), ...(pageToken ? { pageToken } : {}) },
    });
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    out.push(...items);
    pageToken = (!Array.isArray(data) && data?.pageToken) || '';
    if (!pageToken || items.length < pageSize) break;
  }
  return out;
}
