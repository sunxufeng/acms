import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { AiRouteService, GatewayError, MAX_ATTEMPTS, UPSTREAM_TIMEOUT_MS, type RouteTarget } from './ai-route.service.js';
import { openUpstream, type SimpleResponse } from './ai-proxy.util.js';

/**
 * 网关异常过滤器：把错误转成厂商 SDK 能识别的 {error:{message,type,code}}。
 * ⚠️ 必须挂在网关 controller 上，否则会被 ACMS 的全局 AllExceptionsFilter 改成后台格式。
 */
@Catch()
export class AiGatewayFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<GateRes>();
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const code = exception instanceof GatewayError ? exception.code : 'server_error';
    const message = exception instanceof Error ? exception.message : String(exception);
    res.status(status).json({ error: { message, type: code, code } });
  }
}

/**
 * AI 路由网关（对外入口）。
 * ──────────────────────────────────────────────────────────────────
 * 路径是 `/v1/chat/completions`、`/v1/messages`、`/v1/embeddings` 这类**厂商原生路径**，
 * 故意不套 ACMS 的 `/api/v1` 前缀与 `{code,message,data}` 响应包装 ——
 * 使用方拿到的必须是 OpenAI / Anthropic SDK 能直接吃下的格式。
 * 对应地：main.ts 里把这几条路径从全局前缀中排除。
 *
 * 完整链路（对齐 sub2api 的调度思路）：
 *   Bearer 密钥 → 校验（状态/过期/IP/额度）→ 模型白名单 → 分组三级限额
 *   → 分组 RPM 与并发闸门（Redis）→ 选候选账号（状态机 / 利润门 / 分组归属 + 负载排序）
 *   → 逐个抢账号槽位（抢不到换下一个，不排队）→ 转发（可走代理）
 *   → 失败按错误类型冷却账号并降级到下一个候选 → 计费落库（成功失败都记）
 */
@Controller('v1')
@UseFilters(AiGatewayFilter)
export class AiGatewayController {
  private readonly logger = new Logger(AiGatewayController.name);

  constructor(private readonly svc: AiRouteService) {}

  @Post('chat/completions')
  chatCompletions(@Req() req: GateReq, @Res() res: GateRes): Promise<void> {
    return this.handle(req, res, '/chat/completions');
  }

  @Post('messages')
  messages(@Req() req: GateReq, @Res() res: GateRes): Promise<void> {
    return this.handle(req, res, '/messages');
  }

  @Post('embeddings')
  embeddings(@Req() req: GateReq, @Res() res: GateRes): Promise<void> {
    return this.handle(req, res, '/embeddings');
  }

  /**
   * 模型列表：只列当前分组**实际可用**的逻辑模型。
   * 白名单非空时按其收敛 —— 分组没开放的模型不该出现在列表里（sub2api 同款约束）。
   */
  @Get('models')
  async models(@Req() req: GateReq, @Res() res: GateRes): Promise<void> {
    try {
      const key = await this.svc.verifyKey(bearer(req), clientIp(req));
      const routes = await this.svc.allRoutes();
      const names = this.svc.filterModelsByWhitelist(key.group, [...new Set(routes.map((r) => r.model))]).sort();
      res.status(200).json({
        object: 'list',
        data: names.map((id) => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'acms-ai-route',
        })),
      });
    } catch (e) {
      const ge = e instanceof GatewayError ? e : new GatewayError('server_error', (e as Error).message, 500);
      res.status(ge.status).json({ error: { message: ge.message, type: ge.code, code: ge.code } });
    }
  }

  /** 三个接口共用同一条流水线，只有末段路径不同 */
  private async handle(req: GateReq, res: GateRes, suffix: string): Promise<void> {
    const started = Date.now();
    const endpoint = `/v1${suffix}`;
    const ip = clientIp(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = String(body['model'] ?? '');
    const stream = body['stream'] === true;

    let key: Awaited<ReturnType<AiRouteService['verifyKey']>> | null = null;
    let chosen: { upstreamId: string; upstreamName: string; upstreamModel: string } | null = null;
    const attemptLog: string[] = [];

    try {
      if (!model) throw new GatewayError('missing_model', '请求缺少 model 参数', 400);
      key = await this.svc.verifyKey(bearer(req), ip);
      this.svc.assertModelAllowed(key.group, model);
      await this.svc.assertGroupQuota(key.group, key.groupId);
      await this.svc.acquireSlot(key.id, key.group, ip);

      try {
        const candidates = await this.svc.selectCandidates(model, key.groupId, key.group);
        if (!candidates.length) {
          throw new GatewayError(
            'no_route',
            `没有可调度的上游账号（模型 ${model}）—— 检查模型路由是否配置、账号是否属于该分组、账号是否正在限流/过载/临时摘除冷却中`,
            503,
          );
        }

        for (const target of candidates.slice(0, MAX_ATTEMPTS)) {
          // 账号级并发抢槽：抢不到直接换下一个（sub2api 的做法，不排队死等）
          const got = await this.svc.tryAcquireAccount(target);
          if (!got) {
            attemptLog.push(`${target.upstreamName}(并发已满)`);
            continue;
          }
          chosen = {
            upstreamId: target.upstreamId,
            upstreamName: target.upstreamName,
            upstreamModel: target.upstreamModel,
          };
          try {
            const usage = await this.forward(res, target, body, suffix, stream);
            await this.svc.markUpstreamResult(target.upstreamId, true);
            await this.svc.recordUsage({
              keyId: key.id,
              keyName: key.name,
              userId: key.userId,
              groupId: key.groupId,
              groupName: String(key.group['名称'] ?? ''),
              upstreamName: target.upstreamName,
              model,
              upstreamModel: target.upstreamModel,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.promptTokens + usage.completionTokens,
              // 单价按**实际上游模型**算，倍率 = 基础倍率 × 高峰倍率
              costUsd: this.svc.computeCost(
                target.upstreamModel,
                usage.promptTokens,
                usage.completionTokens,
                this.svc.effectiveMultiplier(key.group),
              ),
              latencyMs: Date.now() - started,
              status: '成功',
              errorMsg: usage.estimated ? '流式响应未返回 usage，按输出字节估算' : '',
              clientIp: ip,
              endpoint,
            });
            return;
          } catch (e) {
            const msg = (e as Error).message.slice(0, 200);
            attemptLog.push(`${target.upstreamName}(${msg.slice(0, 60)})`);
            await this.coolDown(target, e);
            // 已经往响应里写过数据（流式转发中途失败）就不要再换账号 —— 响应头已发出，无法重来
            if (res.headersSent) throw e;
            if (e instanceof GatewayError && e.status < 500) throw e; // 4xx 是请求本身的问题，换账号也没用
            this.logger.warn(`上游「${target.upstreamName}」失败：${msg}`);
          } finally {
            await this.svc.releaseAccount(target);
          }
        }
        throw new GatewayError('upstream_error', `所有候选账号均调用失败：${attemptLog.join('；')}`, 502);
      } finally {
        await this.svc.releaseSlot(key.id);
      }
    } catch (e) {
      const ge = e instanceof GatewayError ? e : new GatewayError('server_error', (e as Error).message, 500);
      // 失败也记一条用量：不然排查「为什么这个 key 一直失败」没有任何线索
      if (key) {
        await this.svc.recordUsage({
          keyId: key.id,
          keyName: key.name,
          userId: key.userId,
          groupId: key.groupId,
          groupName: String(key.group['名称'] ?? ''),
          upstreamName: chosen?.upstreamName ?? '',
          model,
          upstreamModel: chosen?.upstreamModel ?? '',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - started,
          status: '失败',
          errorMsg: `${ge.code}: ${ge.message}`.slice(0, 200),
          clientIp: ip,
          endpoint,
        });
      }
      if (!res.headersSent) {
        res.status(ge.status).json({ error: { message: ge.message, type: ge.code, code: ge.code } });
      } else {
        res.end();
      }
    }
  }

  /**
   * 按错误类型给账号上冷却（对齐 sub2api 的状态机）：
   *  429 → 只写「限流解除时间」（不摘账号，优先用上游的 reset 头）
   *  529 → 写「过载解除时间」
   *  401/403 → 临时摘除（凭证/权限问题，等人工处理或刷新 token）
   *  其它 → 计入连续失败，达到阈值后标「异常」
   */
  private async coolDown(target: RouteTarget, err: unknown): Promise<void> {
    if (err instanceof UpstreamHttpError) {
      if (err.status === 429) {
        await this.svc.markRateLimited(target.upstreamId, err.resetAt);
        return;
      }
      if (err.status === 529) {
        await this.svc.markOverloaded(target.upstreamId);
        return;
      }
      if (err.status === 401 || err.status === 403) {
        await this.svc.markTempUnschedulable(target.upstreamId, `上游返回 ${err.status}（凭证或权限问题）`);
        return;
      }
    }
    await this.svc.markUpstreamResult(target.upstreamId, false, (err as Error).message);
  }

  /**
   * 向上游转发。
   * - 配了代理就走 HTTP 代理隧道（国内访问境外 API 用），否则直连
   * - 非流式：读完整 JSON 回给调用方，从 usage 取 token
   * - 流式：逐块透传（不缓冲）；结束后从流里的 usage 解析 token，解析不到按输出字节估算。
   *   流式请求会自动注入 stream_options.include_usage（OpenAI 兼容上游才返回 usage），
   *   若上游因该参数报 400，则去掉参数重试一次 —— 不能为了统计把请求打挂。
   */
  private async forward(
    res: GateRes,
    target: RouteTarget,
    body: Record<string, unknown>,
    suffix: string,
    stream: boolean,
  ): Promise<{ promptTokens: number; completionTokens: number; estimated: boolean }> {
    const url = `${target.baseUrl.replace(/\/+$/, '')}${suffix}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      ...this.svc.buildAuthHeaders(target.provider, target.credential),
    };
    const proxy = target.proxyId ? await this.svc.getProxy(target.proxyId) : null;
    const replaced = (extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ ...body, ...extra, model: target.upstreamModel });

    const send = async (payload: string): Promise<SimpleResponse> => {
      try {
        return await openUpstream(
          url,
          { method: 'POST', headers, body: payload, timeoutMs: UPSTREAM_TIMEOUT_MS },
          proxy,
        );
      } catch (e) {
        throw new GatewayError('upstream_error', `调用上游失败：${(e as Error).message}`, 502);
      }
    };

    let upstream = await send(replaced(stream ? { stream_options: { include_usage: true } } : {}));
    if (upstream.status >= 400) {
      const text = await safeText(upstream);
      if (stream && upstream.status === 400 && /stream_options/i.test(text)) {
        // 上游不认 stream_options：去掉再试一次（统计精度不值得把请求打挂）
        this.logger.warn(`上游 ${target.baseUrl} 不认 stream_options，去掉后重试`);
        upstream = await send(replaced());
        if (upstream.status >= 400) {
          throw new UpstreamHttpError(upstream.status, await safeText(upstream), parseResetAt(upstream.headers));
        }
      } else {
        throw new UpstreamHttpError(upstream.status, text, parseResetAt(upstream.headers));
      }
    }

    if (!stream) {
      const json = JSON.parse(await upstream.text()) as Record<string, unknown>;
      const u = usageOf(json);
      res.status(200).json(json);
      return u;
    }

    // ── 流式：逐块透传 ────────────────────────────────────────────
    res.status(200);
    res.setHeader('Content-Type', upstream.headers['content-type'] ?? 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 关键：告诉 nginx 不要缓冲，否则 SSE 会被攒着一次性吐出（表现为"流式不流"）
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let raw = '';
    let bytes = 0;
    for await (const chunk of upstream.stream()) {
      bytes += chunk.byteLength;
      res.write(Buffer.from(chunk));
      raw += Buffer.from(chunk).toString('utf8');
      // 只保留尾部用于解析最后的 usage，防止长对话把内存吃满
      if (raw.length > 65536) raw = raw.slice(-65536);
    }
    res.end();

    const parsed = usageFromSse(raw);
    if (parsed) return { ...parsed, estimated: false };
    // 拿不到 usage：按输出字节估算，明细里会写明是估算值
    const est = Math.max(1, Math.ceil(bytes / 4));
    return { promptTokens: 0, completionTokens: est, estimated: true };
  }
}

// ── 类型与工具（不 import express：生产 node_modules 里 apps/api 解析不到它）──
interface GateReq {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
  method: string;
  originalUrl?: string;
}

interface GateRes {
  status(code: number): GateRes;
  json(body: unknown): void;
  setHeader(k: string, v: string): void;
  write(chunk: Buffer | string): boolean;
  end(): void;
  flushHeaders?: () => void;
  headersSent: boolean;
}

/** 上游返回的非 2xx：带上状态码与 reset 时间，供冷却逻辑判断 */
class UpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly resetAt?: number,
  ) {
    super(`上游返回 ${status}：${detail.slice(0, 300)}`);
  }
}

function bearer(req: GateReq): string {
  const raw = req.headers['authorization'] ?? req.headers['x-api-key'] ?? '';
  const s = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
  return s.startsWith('Bearer ') ? s.slice(7).trim() : s.trim();
}

function clientIp(req: GateReq): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff) ?? '';
  const ip = String(first).split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

async function safeText(r: SimpleResponse): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

/** 从上游响应头解析「限流何时解除」：优先 Retry-After，再找 ratelimit-*-reset（sub2api 同款思路） */
function parseResetAt(headers: Record<string, string>): number | undefined {
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) return Date.now() + sec * 1000;
    const at = new Date(retryAfter).getTime();
    if (!Number.isNaN(at)) return at;
  }
  for (const k of Object.keys(headers)) {
    if (!/ratelimit.*reset/i.test(k)) continue;
    const v = headers[k] ?? '';
    const sec = Number(v);
    if (Number.isFinite(sec) && sec > 0) {
      // 既可能是「距现在多少秒」也可能是「秒级时间戳」，取落在合理区间的那种解释
      const asEpoch = sec * 1000;
      return asEpoch > Date.now() - 1000 && asEpoch < Date.now() + 86_400_000 ? asEpoch : Date.now() + sec * 1000;
    }
    const at = new Date(v).getTime();
    if (!Number.isNaN(at)) return at;
  }
  return undefined;
}

/** 从非流式响应取 token（OpenAI 用 prompt/completion，Anthropic 用 input/output） */
function usageOf(json: Record<string, unknown>): { promptTokens: number; completionTokens: number; estimated: boolean } {
  const u = (json['usage'] ?? {}) as Record<string, unknown>;
  const p = Number(u['prompt_tokens'] ?? u['input_tokens'] ?? 0) || 0;
  const c = Number(u['completion_tokens'] ?? u['output_tokens'] ?? 0) || 0;
  return { promptTokens: p, completionTokens: c, estimated: false };
}

/** 从 SSE 片段里捞最后一个 usage（OpenAI 最后一帧、Anthropic message_delta 都带） */
function usageFromSse(raw: string): { promptTokens: number; completionTokens: number } | null {
  let best: { promptTokens: number; completionTokens: number } | null = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      const u = (obj['usage'] ??
        (obj['message'] as Record<string, unknown> | undefined)?.['usage'] ??
        obj['delta']) as Record<string, unknown> | undefined;
      if (!u) continue;
      const p = Number(u['prompt_tokens'] ?? u['input_tokens'] ?? 0) || 0;
      const c = Number(u['completion_tokens'] ?? u['output_tokens'] ?? 0) || 0;
      if (p || c) best = { promptTokens: p, completionTokens: c };
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  return best;
}
