import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { SecurityMiddleware } from './security/security.middleware.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3100'],
    credentials: true,
  });
  // M7 安全加固：安全响应头 + 写接口跨域来源校验（全局）
  app.use(new SecurityMiddleware());
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.log(`[acms-api] listening on :${port}`);
}

void bootstrap();
