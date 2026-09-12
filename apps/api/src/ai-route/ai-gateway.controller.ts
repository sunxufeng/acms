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
import { AiRouteService, GatewayError, MAX_ATTEMPTS, UPSTREAM_TIMEOUT_MS } from './ai-route.service.js';

/**
 * AI 路由网关（对外入口）。
 * ──────────────────────────────────────────────────────────────────
 * 路径是 `/v1/chat/completions`、`/v1/messages`、`/v1/embeddings` 这类**厂商原生路径**，
 * 故意不套 ACMS 的 `/api/v1` 前缀与 `{code,message,data}` 响应包装 ——
 * 使用方拿到的必须是 OpenAI / Anthropic SDK 能直接吃下的格式，否则失去网关的意义。
 * 对应地：main.ts 里把这几条路径从全局前缀中排除（见 setGlobalPrefix 的 exclude）。
 *
 * 一次请求的完整链路：
 *   Bearer 密钥 → 校验（状态/过期/IP/额度）→ 模型白名单 → 分组月配额
 *   → RPM 与并发闸门（Redis）→ 选上游（优先级 + 权重）→ 转发
 *   → 失败按优先级降级重试 → 计费落库（成功/失败都记）→ 回写上游健康状态
 */
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

  /** 模型列表：把当前可达的逻辑模型列出来（方便使用方确认该填什么模型名） */
  @Get('models')
  async models(@Req() req: GateReq, @Res() res: GateRes): Promise<void> {
    const started = Date.now();
    try {
      const plain = bearer(req);
      const ip = clientIp(req);
      const key = await this.svc.verifyKey(plain, ip);
      const routes = await this.svc.allRoutes();
      const names = [...new Set(routes.map((r) => r.model))].sort();
      res.status(200).json({
        object: 'list',
        data: names.map((id) => ({ id, object: 'model', created: Math.floor(started / 1000), owned_by: 'acms-ai-route' })),
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
    let lastErr = '';

    try {
      if (!model) throw new GatewayError('missing_model', '请求缺少 model 参数', 400);
      key = await this.svc.verifyKey(bearer(req), ip);
      this.svc.assertModelAllowed(key.group, model);
      await this.svc.assertGroupQuota(key.group, key.groupId);
      await this.svc.acquireSlot(key.id, key.group, ip);

      try {
        const routes = await this.svc.selectRoutes(model, key.groupId);
        if (!routes.length) {
          throw new GatewayError(
            'no_route',
            `没有可用的上游账号（模型 ${model}）—— 请检查「模型路由」与上游分组配置`,
            503,
          );
        }

        const attempts = routes.slice(0, MAX_ATTEMPTS);
        for (let i = 0; i < attempts.length; i += 1) {
          const target = attempts[i]!;
          chosen = { upstreamId: target.upstreamId, upstreamName: target.upstreamName, upstreamModel: target.upstreamModel };
          try {
            const usage = await this.forward(req, res, target, body, suffix, stream);
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
              costUsd: this.svc.computeCost(target.upstreamModel, usage.promptTokens, usage.completionTokens, Number(key.group['价格倍率'] ?? 1)),
              latencyMs: Date.now() - started,
              status: '成功',
              errorMsg: usage.estimated ? '流式响应未返回 usage，按输出字节估算' : '',
              clientIp: ip,
              endpoint,
            });
            // 已选中的上游要用实际成功的那个（降级失败时报的是最后一个）
            return;
          } catch (e) {
            lastErr = (e as Error).message.slice(0, 200);
            await this.svc.markUpstreamResult(target.upstreamId, false, lastErr);
            // 已经往响应里写过数据（流式转发到一半失败）就不要再换上游重试 —— 响应头已发出，无法重来
            if (res.headersSent) throw e;
            if (e instanceof GatewayError && e.status < 500) throw e; // 4xx 是请求本身的问题，换上游也没用
            this.logger.warn(`上游「${target.upstreamName}」失败，${i + 1}/${attempts.length}：${lastErr}`);
          }
        }
        throw new GatewayError('upstream_error', lastErr || '所有上游均调用失败', 502);
      } finally {
        await this.svc.releaseSlot(key.id);
      }
    } catch (e) {
      const ge = e instanceof GatewayError ? e : new GatewayError('server_error', (e as Error).message, 500);
      // 失败也记一条用量（原版如此）：不然排查「为什么这个 key 一直失败」没有任何线索
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
   * 向上游转发。
   * - 非流式：读完整 JSON 回给调用方，并从 usage 取 token
   * - 流式：逐块透传（不缓冲），结束后从流里的 usage 解析 token；解析不到就按输出字节估算
   *   并注入 stream_options.include_usage（OpenAI 兼容上游支持时才返回 usage），
   *   若上游因该参数报 400，则去掉参数重试一次 —— 不能为了拿 token 统计把请求打挂。
   */
  private async forward(
    req: GateReq,
    res: GateRes,
    target: { baseUrl: string; provider: string; upstreamModel: string; credential: Record<string, string> },
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

    const replaced = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...body,
      ...extra,
      model: target.upstreamModel,
    });

    const send = async (b: Record<string, unknown>): Promise<Response> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(b), signal: ctl.signal });
        clearTimeout(timer);
        return r;
      } catch (e) {
        clearTimeout(timer);
        const msg = (e as Error).name === 'AbortError' ? `上游超时（${UPSTREAM_TIMEOUT_MS / 1000}s）` : (e as Error).message;
        throw new GatewayError('upstream_error', `调用上游失败：${msg}`, 502);
      }
    };

    let upstream = await send(replaced(stream ? { stream_options: { include_usage: true } } : {}));
    if (!upstream.ok && stream && upstream.status === 400) {
      // 可能是不认 stream_options，去掉再试一次
      const text = await upstream.text().catch(() => '');
      if (/stream_options/i.test(text)) {
        this.logger.warn(`上游 ${target.baseUrl} 不认 stream_options，去掉后重试`);
        upstream = await send(replaced());
      } else {
        throw new GatewayError('upstream_error', `上游返回 ${upstream.status}：${text.slice(0, 200)}`, 502);
      }
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      throw new GatewayError('upstream_error', `上游返回 ${upstream.status}：${text.slice(0, 300)}`, 502);
    }

    if (!stream) {
      const json = (await upstream.json()) as Record<string, unknown>;
      const u = usageOf(json);
      res.status(200).json(json);
      return u;
    }

    // ── 流式：逐块透传 ────────────────────────────────────────────
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 关键：告诉 nginx 不要缓冲，否则 SSE 会被攒着一次性吐出（表现为"流式不流"）
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const reader = upstream.body?.getReader();
    if (!reader) throw new GatewayError('upstream_error', '上游没有返回可读流', 502);
    let raw = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      res.write(Buffer.from(value));
      raw += Buffer.from(value).toString('utf8');
      // 只保留尾部用于解析最后的 usage，防止长对话把内存吃满
      if (raw.length > 65536) raw = raw.slice(-65536);
    }
    res.end();

    const parsed = usageFromSse(raw);
    if (parsed) return { ...parsed, estimated: false };
    // 拿不到 usage：按输出字节估算（标注 estimated，明细里会写明）
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

/** 从非流式响应里取 token（OpenAI 用 prompt/completion，Anthropic 用 input/output） */
function usageOf(json: Record<string, unknown>): { promptTokens: number; completionTokens: number; estimated: boolean } {
  const u = (json['usage'] ?? {}) as Record<string, unknown>;
  const p = Number(u['prompt_tokens'] ?? u['input_tokens'] ?? 0) || 0;
  const c = Number(u['completion_tokens'] ?? u['output_tokens'] ?? 0) || 0;
  return { promptTokens: p, completionTokens: c, estimated: false };
}

/** 从 SSE 片段里捞最后一个 usage（OpenAI 的最后一帧、Anthropic 的 message_delta 都带） */
function usageFromSse(raw: string): { promptTokens: number; completionTokens: number } | null {
  let best: { promptTokens: number; completionTokens: number } | null = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      const u = (obj['usage'] ?? (obj['message'] as Record<string, unknown> | undefined)?.['usage'] ?? obj['delta']) as
        | Record<string, unknown>
        | undefined;
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
