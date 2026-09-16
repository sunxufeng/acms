import { Controller, Get, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MODULE_RESOURCES, TABLES, type SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { getSqlStore } from '../base.provider.js';
import { META_BY_PATH, ALL_METAS } from './schema.registry.js';

/**
 * 能力发现接口（2026-09-16）—— 给 CLI / MCP / agent 用。
 *
 * ## 为什么必须有这个接口
 * 仓库**没有 OpenAPI / Swagger**（`@nestjs/swagger` 未装），全站 300+ 路由端点。
 * 没有它的话，agent 用 `acms api GET /xxx` 只能靠猜路径与字段名 ——
 * 那正是「只是个 curl 包装」与「能被 agent 用」的分界线。
 *
 * ## 权限
 * 只要求**登录态**（会话或令牌）+ 模块的 read 权限由各自接口把关。
 * 这里返回的是**结构信息**（模块名、表、字段名与类型），不含任何业务数据，
 * 所以不额外收权限：agent 知道「有哪些字段」并不等于能看到数据。
 *
 * ⚠️ 字段清单取自运行时 `acms_fields`（`sql.listFields`），不是 TS 里的静态定义 ——
 * 生产上真正生效的是前者（历史上出现过「字典与实际数据不符」的坑）。
 */

/** 字段 type 数值 → 语义名（口径来自生产 `acms_fields` 实测） */
const FIELD_TYPE_NAMES: Record<number, string> = {
  1: 'text',
  2: 'number',
  3: 'select',
  4: 'multiSelect',
  5: 'date',
  7: 'checkbox',
  11: 'user',
  17: 'attachment',
  18: 'link',
  21: 'twoWayLink',
  1001: 'createdTime',
  1005: 'autoNumber',
};

@Controller('schema')
@UseGuards(SessionGuard)
export class SchemaController {
  /**
   * 全部模块清单：key / 中文名 / 路径 / 可用动作 / 是否通用 CRUD / 表 ID。
   * agent 第一步调它，就能知道「这个系统有哪些能力」。
   */
  @Get()
  list(@Req() _req: Request & { user: SessionUser }) {
    const modules = MODULE_RESOURCES.map((m) => {
      const meta = META_BY_PATH.get(m.path);
      return {
        key: m.key,
        label: m.label,
        path: m.path,
        aliases: m.aliases ?? [],
        actions: m.actions,
        // 通用 CRUD 的模块有统一的 5 个端点形状（GET / POST / PUT :id / DELETE :id / POST :id/transition）
        crud: Boolean(m.genericCrud),
        tableId: meta?.tableId ?? null,
        readPerm: `module:${m.key}:read`,
      };
    });
    return {
      modules,
      total: modules.length,
      /**
       * 通用 CRUD 的端点形状写在这里，agent 不必逐个模块猜。
       * 与 `acms api` 命令配合使用：路径 = `/` + path 段。
       */
      crudShape: {
        list: 'GET    /<path>?pageSize&pageToken&q&<field>__contains=...',
        get: 'GET    /<path>/:id',
        create: 'POST   /<path>',
        update: 'PUT    /<path>/:id',
        remove: 'DELETE /<path>/:id',
        transition: 'POST /<path>/:id/transition  { action: "approve" | "reject" | ... }',
      },
      /** 筛选后缀（写进响应，省得 agent 靠试） */
      filterSuffix: {
        exact: '裸字段名 = 等值',
        contains: '__contains',
        has: '__has',
        notEmpty: '__notempty',
        empty: '__empty',
        gt: '__gt',
        lt: '__lt',
        dateFrom: '_from',
        dateTo: '_to',
        keyword: 'q',
      },
      note: 'CRUD 模块的 `crud: true` 表示可用上面统一的 5 个端点；否则请用 §CLI 的策展命令或查看该模块的专用接口。',
    };
  }

  /** 单个模块的细节：表 ID + 字段清单（名称、类型、选项） */
  @Get(':key')
  async detail(@Req() _req: Request & { user: SessionUser }, @Param('key') key: string) {
    const mod = MODULE_RESOURCES.find((m) => m.key === key);
    if (!mod) throw new NotFoundException(`未知模块：${key}`);

    const meta = META_BY_PATH.get(mod.path);
    const tableId = meta?.tableId ?? null;

    let fields: { name: string; type: number; typeName: string; options?: string[] }[] = [];
    let tableName = '';
    if (tableId) {
      const sql = getSqlStore();
      if (sql) {
        const metas = await sql.listFields(tableId);
        fields = metas.map((f) => {
          const opt = (f.property as { options?: { name?: string }[] } | undefined)?.options;
          const out: { name: string; type: number; typeName: string; options?: string[] } = {
            name: f.name,
            type: f.type,
            typeName: FIELD_TYPE_NAMES[f.type] ?? `type${f.type}`,
          };
          const names = (opt ?? []).map((o) => String(o?.name ?? '')).filter(Boolean);
          if (names.length) out.options = names;
          return out;
        });
      }
      tableName = Object.entries(TABLES).find(([, v]) => v.tableId === tableId)?.[0] ?? '';
    }

    return {
      key: mod.key,
      label: mod.label,
      path: mod.path,
      actions: mod.actions,
      crud: Boolean(mod.genericCrud),
      tableId,
      tableName,
      fields,
      fieldCount: fields.length,
      /** 该模块是否有独立元数据（没有的话多半是专用接口，不是通用 CRUD） */
      hasMeta: Boolean(meta),
      hint: meta
        ? `用 \`acms api GET ${mod.path}?pageSize=5\` 试读；创建用 \`acms api POST ${mod.path}\`（需可写令牌）。`
        : '该模块没有通用 CRUD 元数据，请查阅专用接口（多为只读或流程型）。',
    };
  }
}

/** 供诊断接口（doctor）复用：注册表里有多少张表 */
export const SCHEMA_TABLE_COUNT = new Set(ALL_METAS.map((m) => m.tableId)).size;
