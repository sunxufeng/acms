import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

/**
 * 上游请求的统一出口：直连走内置 fetch，配了代理就走 HTTP 代理隧道。
 *
 * ⚠️ 为什么不用 undici 的 ProxyAgent：
 *   生产服务器上 `require.resolve('undici')` 解析到的是系统全局路径
 *   （/usr/share/nodejs/undici），apps/api 进程不一定能解析到 —— 项目有明确教训：
 *   引入不可解析的运行时依赖会导致 API 直接起不来（MODULE_NOT_FOUND）。所以零依赖自实现。
 *
 * 支持：
 *   - http/https 目标 + HTTP(S) 代理（CONNECT 隧道 + TLS）
 *   - 流式响应（SSE）逐块转发
 * 不支持：socks5（需要额外的握手实现，遇到会明确报错而不是静默直连 —— 静默直连会暴露真实 IP）
 */

export interface ProxyConfig {
  /** http / https（socks5 暂不支持） */
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** 上游响应的统一形态：与 fetch 的 Response 保持最小一致，便于两条路径共用同一段逻辑 */
export interface SimpleResponse {
  status: number;
  headers: Record<string, string>;
  /** 一次性读取全文 */
  text(): Promise<string>;
  /** 逐块读取（SSE 用），yield Uint8Array */
  stream(): AsyncIterable<Uint8Array>;
}

export interface UpstreamInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** 直连：内置 fetch */
async function directFetch(url: string, init: UpstreamInit): Promise<SimpleResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    throw new Error(err.name === 'AbortError' ? `上游超时（${init.timeoutMs / 1000}s）` : err.message);
  }
  clearTimeout(timer);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    status: res.status,
    headers,
    text: () => res.text(),
    stream: async function* () {
      const reader = res.body?.getReader();
      if (!reader) return;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    },
  };
}

/** 经 HTTP(S) 代理：https 目标用 CONNECT 隧道 + TLS；http 目标直接让代理转发 */
function proxiedFetch(targetUrl: string, init: UpstreamInit, proxy: ProxyConfig): Promise<SimpleResponse> {
  return new Promise<SimpleResponse>((resolve, reject) => {
    const u = new URL(targetUrl);
    const isHttpsTarget = u.protocol === 'https:';
    const proxyProtocol = String(proxy.protocol ?? 'http').toLowerCase();
    if (proxyProtocol === 'socks5') {
      reject(new Error('暂不支持 socks5 代理，请改用 http/https 代理（避免静默直连导致暴露真实 IP）'));
      return;
    }
    const proxySecure = proxyProtocol === 'https';
    const proxyPort = Number(proxy.port) || (proxySecure ? 443 : 80);
    const auth =
      proxy.username && proxy.username.length
        ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`
        : '';
    const proxyAuthHeader = auth ? { 'Proxy-Authorization': auth } : {};

    const toSimple = (status: number, rawHeaders: Record<string, string | string[] | undefined>, body: NodeJS.ReadableStream): SimpleResponse => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      const chunks: Buffer[] = [];
      return {
        status,
        headers,
        async text() {
          for await (const c of body) chunks.push(Buffer.from(c as Buffer));
          return Buffer.concat(chunks).toString('utf8');
        },
        async *stream() {
          for await (const c of body) yield Buffer.from(c as Buffer);
        },
      };
    };

    if (!isHttpsTarget) {
      // 明文 HTTP：目标地址写在请求行里，交给代理转发
      const req = httpRequest(
        {
          host: proxy.host,
          port: proxyPort,
          method: init.method,
          path: targetUrl,
          headers: { ...init.headers, ...proxyAuthHeader, Host: u.host },
          timeout: init.timeoutMs,
        },
        (res) => resolve(toSimple(res.statusCode ?? 0, res.headers, res)),
      );
      req.on('timeout', () => req.destroy(new Error(`代理请求超时（${init.timeoutMs / 1000}s）`)));
      req.on('error', (e) => reject(new Error(`经代理请求失败：${e.message}`)));
      if (init.body) req.write(init.body);
      req.end();
      return;
    }

    // HTTPS 目标：先 CONNECT 建隧道，再在隧道里做 TLS 握手
    const connectReq = httpRequest({
      host: proxy.host,
      port: proxyPort,
      method: 'CONNECT',
      path: `${u.hostname}:${u.port || 443}`,
      headers: { Host: `${u.hostname}:${u.port || 443}`, ...proxyAuthHeader },
      timeout: init.timeoutMs,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理拒绝 CONNECT（HTTP ${res.statusCode}）`));
        return;
      }
      const tls = tlsConnect({ socket, servername: u.hostname });
      tls.on('error', (e) => reject(new Error(`代理隧道 TLS 握手失败：${e.message}`)));
      const inner = httpsRequest(
        {
          host: u.hostname,
          port: Number(u.port || 443),
          method: init.method,
          path: `${u.pathname}${u.search}`,
          headers: init.headers,
          createConnection: () => tls,
          timeout: init.timeoutMs,
        },
        (r) => resolve(toSimple(r.statusCode ?? 0, r.headers, r)),
      );
      inner.on('timeout', () => inner.destroy(new Error(`经代理请求超时（${init.timeoutMs / 1000}s）`)));
      inner.on('error', (e) => reject(new Error(`经代理请求失败：${e.message}`)));
      if (init.body) inner.write(init.body);
      inner.end();
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error(`代理连接超时（${init.timeoutMs / 1000}s）`)));
    connectReq.on('error', (e) => reject(new Error(`代理连接失败：${e.message}`)));
    connectReq.end();
  });
}

/** 统一入口：传了代理就走隧道，否则直连 */
export function openUpstream(url: string, init: UpstreamInit, proxy?: ProxyConfig | null): Promise<SimpleResponse> {
  return proxy ? proxiedFetch(url, init, proxy) : directFetch(url, init);
}
