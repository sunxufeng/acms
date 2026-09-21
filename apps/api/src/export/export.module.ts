/**
 * 通用数据导出（M6 运营工作台·导出）。
 * 任一已注册飞书表 → CSV（含 BOM，Excel 可直接打开），字段以飞书实际字段为准。
 * 权限：export:run。导出为全量分页拉取，单表数据量需可控。
 *
 * 🔴 「三合一」记录表要按**记录类型**分别导出（2026-09-21 修）：
 *    日常跟进 / 家校沟通 / 学生观察 三合一是**一张物理表 + 一个「记录类型」字段**，
 *    而导出页原先照旧给三个表键：`dailyFollowup` 导出整张表（5 类全在里面）、
 *    `homeSchoolComm` / `studentObservation` 指向**合并前的旧表**（生产实测 0 行 ⇒ 空 CSV）。
 *    现在：三个键都落到三合一表 + 各自的默认类型；类型可被 `?记录类型=` 覆盖；
 *    类型权限与列表**同源**（列表看不到的类型，导出也不给）。
 *    解析逻辑见 `export-filter.ts`（纯函数 + 单测）。
 *
 * ⚠️ 已知边界（本次未动，待确认）：导出的**行级范围**还没套用列表那一层
 *    （学生档案数据范围 / `studentScoped`）—— 即「有导出自定义权限的人能导到超过他
 *    可见范围的行」。这一层要复用 `rowScopeFor`（在动态生成的表服务里），
 *    需要先把那批服务的实例暴露出来，属于单独一轮的改动。
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { authorize, getRoleLabels, type Principal } from '@acms/domain';
import { BaseClient, toText } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider';
import { STUDENT_RECORD_TYPE_TO_MODULE, TABLES, modulePermission } from '@acms/contracts';
import type { SessionUser } from '@acms/contracts';
import { typeAllowedValues } from '../shared/generic-crud.module';
import { LIFECYCLE_METAS } from '../shared/lifecycle.meta';
import { RECORD_EXPORT_TABLE, pickRecordRows, resolveRecordExport } from './export-filter';
import { DictService } from '../dictionary/dict.service';
import { FIELD_DICTKEY } from '../dictionary/dict.data';

function toPrincipal(u: SessionUser): Principal {
  return { roles: u.roles, campuses: u.campuses, maxDataLevel: u.maxDataLevel };
}

/** 三合一记录表的元数据（类型域判据要用它的 typeScope）；学生记录是主入口的 path */
const STUDENT_RECORD_META = LIFECYCLE_METAS.find((m) => m.path === 'student-records');

@Controller('export')
@UseGuards(SessionGuard)
export class ExportController {
  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly dict: DictService,
  ) {}

  @Get(':table')
  async export(
    @Req() req: Request,
    @Param('table') table: string,
    @Res() res: Response,
    @Query('记录类型') recordType?: string,
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize(toPrincipal(user), 'module:export:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:module:export:read');
    }
    // 三合一记录表：表键与「记录类型」都由 export-filter 解析（普通表原样全量导出）
    const target = resolveRecordExport(table, recordType);
    if (target.kind === 'bad-type') {
      throw new BadRequestException(`UNKNOWN_RECORD_TYPE:${target.value}`);
    }
    const tableKey = target.kind === 'records' ? target.tableKey : table;
    const t = (TABLES as Record<string, { tableId: string }>)[tableKey];
    if (!t || !t.tableId) throw new NotFoundException('UNKNOWN_TABLE:' + tableKey);
    const tableId = t.tableId;

    // 全量分页拉取
    let rows: { id: string; fields: Record<string, unknown> }[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.base.search(tableId, { pageSize: 100, pageToken });
      for (const it of r.items) rows.push({ id: it.recordId, fields: it.fields });
      pageToken = r.hasMore ? r.pageToken : undefined;
    } while (pageToken);

    if (target.kind === 'records') {
      const ts = STUDENT_RECORD_META?.typeScope;
      if (!ts) throw new Error('学生记录 meta 未登记 typeScope（导出无法按记录类型过滤）');
      // 与列表同源：能导出的类型 ⊆ 能读到的类型（管理员/豁免角色为 null = 不限制）
      const allowed = typeAllowedValues({ typeScope: ts }, user, 'read');
      if (!target.all && allowed && !allowed.includes(target.type)) {
        const mod = STUDENT_RECORD_TYPE_TO_MODULE[target.type] ?? '';
        throw new ForbiddenException(`FORBIDDEN:${modulePermission(mod, 'read')}`);
      }
      rows = pickRecordRows(rows, allowed, target, ts.defaultType ?? '日常跟进');
    }

    // 表头以飞书实际字段顺序为准
    const fields = await this.base.listFields(tableId);
    const headers = ['记录ID', ...fields.map((f) => f.name)];

    const roleLabels = getRoleLabels();
    /** 系统角色等字段存储的是角色 key，导出前解析成展示名；字典字段把旧值/别名解析为当前名；其它字段原样 */
    const resolveFieldValue = (fieldName: string, v: unknown): unknown => {
      if (fieldName === '系统角色') {
        const toLabel = (x: unknown): string => {
          const k = toText(x);
          if (!k) return '';
          return roleLabels[k] ?? k;
        };
        return Array.isArray(v) ? v.map(toLabel) : toLabel(v);
      }
      // 字典字段：fieldName → dictKey（FIELD_DICTKEY），把存量旧值/别名经 aliases 解析为当前展示名
      const dictKey = FIELD_DICTKEY[fieldName];
      if (dictKey) {
        const toLabel = (x: unknown): string => {
          const raw = toText(x);
          if (!raw) return '';
          return this.dict.resolve(dictKey, raw);
        };
        return Array.isArray(v) ? v.map(toLabel) : toLabel(v);
      }
      return v;
    };

    const esc = (v: unknown): string => {
      if (v == null) return '';
      const s = Array.isArray(v) ? v.join('|') : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [headers.join(',')];
    for (const row of rows) {
      const cells: string[] = [row.id];
      for (const f of fields) {
        cells.push(esc(resolveFieldValue(f.name, row.fields[f.name])));
      }
      lines.push(cells.join(','));
    }
    const csv = '﻿' + lines.join('\n');
    const fname = `${table}_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
    res.send(csv);
  }
}

@Module({
  controllers: [ExportController],
  providers: [baseClientProvider, DictService],
})
export class ExportModule {}
