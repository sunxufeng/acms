import 'reflect-metadata';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { securityMiddleware } from './security/security.middleware.js';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { runWithActorStore } from './shared/actor-context.js';

/**
 * ⚠️ 进程级兜底：日志照记，但**绝不让进程退出**。
 *
 * 背景（2026-09-09 真实事故）：imapflow 的 ImapFlow 是 EventEmitter，socket 超时时
 * 会异步 emit 'error'。这个错误不落在任何 await 调用栈上，Nest 的异常过滤器接不到，
 * 我们自己的 try/catch 也接不到 —— Node 直接按 Unhandled 'error' event 终止进程，
 * 整个 API 挂掉、systemd 反复重启，内存里的缓存（如笔记快照）全部丢失。
 *
 * 这类错误几乎全部来自「后台任务 / 第三方客户端库的异步回调」，而不是正在处理的请求，
 * 所以让它继续跑是安全的：服务本身是无状态 HTTP 服务，继续存活的收益
 * （不中断所有人）远大于风险。真正的请求错误仍由 AllExceptionsFilter 正常处理。
 */
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 已捕获，进程继续运行：', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 已捕获，进程继续运行：', reason);
});

/** 请求体上限：10MB。nginx client_max_body_size 为 50m，这里留出余量又不至于撑爆内存。 */
const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * 零依赖的请求体解析中间件（替代 express 的 body-parser）。
 *
 * 覆盖 application/json、application/x-www-form-urlencoded、text/plain；
 * multipart（文件上传）直接放行交给 multer，chunked 流也放行。
 * 超限时抛出带 status=413 / type='entity.too.large' 的错误，
 * 由 AllExceptionsFilter 还原为 413 并给出可操作提示。
 */
function createBodyParser(limitBytes: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase();
    const isJson = ct.includes('application/json');
    const isForm = ct.includes('application/x-www-form-urlencoded');
    const isText = ct.startsWith('text/plain');
    // 无 body、multipart 上传、chunked 流：交给 multer / 后续中间件处理
    if (!ct || req.headers['transfer-encoding'] || !(isJson || isForm || isText)) {
      next();
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limitBytes) {
      next(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (): void => {
      if (done) return;
      done = true;
      next(tooLarge());
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        fail();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        (req as Request & { body?: unknown }).body = isForm ? {} : {};
        next();
        return;
      }
      try {
        if (isJson) (req as Request & { body?: unknown }).body = JSON.parse(raw);
        else if (isForm) {
          const out: Record<string, string> = {};
          for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
          (req as Request & { body?: unknown }).body = out;
        } else (req as Request & { body?: unknown }).body = raw;
        next();
      } catch {
        const err = new Error('请求体不是合法的 JSON') as Error & { status: number };
        err.status = 400;
        next(err);
      }
    });
    req.on('error', (e: Error) => {
      if (done) return;
      done = true;
      next(e);
    });
  };
}

function tooLarge(): Error & { status: number; type: string } {
  const err = new Error('request entity too large') as Error & { status: number; type: string };
  err.status = 413;
  err.type = 'entity.too.large';
  return err;
}

async function bootstrap(): Promise<void> {
  // ⚠️ 请求体上限：express body-parser 默认只有 100kb，会议纪要的「会议明细 / 会议总结」
  // 是长 Markdown，用户粘贴内容后轻松超过 → request entity too large（2026-09-11 实测）。
  // 这里提到 10mb（nginx client_max_body_size 50m，留余量又不撑爆内存）。
  //
  // 为什么不直接 import { json } from 'express'：
  // 生产服务器 node_modules 里 express / body-parser **从 apps/api 不可解析**
  // （只是 @nestjs/platform-express 的传递依赖，未提升到可解析路径），
  // 一旦 import 就 MODULE_NOT_FOUND，API 直接起不来（已踩）。
  // 故关闭 Nest 内置 parser，改用下方零依赖的自实现解析。
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(createBodyParser(BODY_LIMIT_BYTES));
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3100'],
    credentials: true,
  });
  // 全局异常过滤器：透传真实错误信息，避免「Internal Server Error」掩盖校验/业务错误
  app.useGlobalFilters(new AllExceptionsFilter());
  // 操作人上下文：必须最先执行，后续 SessionGuard 写入、存储层读取都依赖它
  app.use((_req: Request, _res: Response, next: NextFunction) => runWithActorStore(next));
  // M7 安全加固：安全响应头 +  ️写接口跨域来源校验（全局）
  app.use(securityMiddleware);
  // 平滑部署：监听 SIGTERM/SIGINT，收到后 drain 在途请求再退出（systemd stop / Blue-Green 切流停旧实例时用到）
  app.enableShutdownHooks();
  // 轻量健康检查端点：供 Blue-Green 切流探活与监控使用（不查 DB，仅确认进程已监听）
  app.getHttpAdapter().getInstance().get('/api/v1/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', ts: Date.now() });
  });
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.log(`[acms-api] listening on :${port}`);
}

void bootstrap();
