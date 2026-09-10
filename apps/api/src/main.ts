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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
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
