import { Module } from '@nestjs/common';
import { SchemaController } from './schema.controller.js';

/**
 * 能力发现模块（2026-09-16）。
 *
 * 只为 CLI / MCP / agent 提供「这个系统有哪些模块与字段」——
 * 仓库没有 OpenAPI，这份自建 schema 就是 agent 的接口文档。
 *
 * 依赖说明：`SessionGuard` 与 `getSqlStore()` 都来自 `@Global` 的 AuthModule / base.provider，
 * 直接注入即可，无需 imports。
 */
@Module({
  controllers: [SchemaController],
})
export class SchemaModule {}
