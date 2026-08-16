import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3100'],
    credentials: true,
  });
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.log(`[acms-api] listening on :${port}`);
}

void bootstrap();
