import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { securityMiddleware } from './security/security.middleware.js';
import { AllExceptionsFilter } from './common/exception.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3100'],
    credentials: true,
  });
  // 全局异常过滤器：透传真实错误信息，避免「Internal Server Error」掩盖校验/业务错误
  app.useGlobalFilters(new AllExceptionsFilter());
  // M7 安全加固：安全响应头 +  ️写接口跨域来源校验（全局）
  app.use(securityMiddleware);
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.log(`[acms-api] listening on :${port}`);
}

void bootstrap();
