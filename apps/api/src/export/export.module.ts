/**
 * 通用数据导出（M6 运营工作台·导出）。
 * 任一已注册飞书表 → CSV（含 BOM，Excel 可直接打开），字段以飞书实际字段为准。
 * 权限：export:run。导出为全量分页拉取，单表数据量需可控。
 */
import { Controller, Get, Param, Query, Res, Req, UseGuards, Inject, Module, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Response, Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider';
import { TABLES } from '@acms/contracts';
import type { SessionUser } from '@acms/contracts';

function toPrincipal(u: SessionUser): Principal {
  return { roles: u.roles, campuses: u.campuses, maxDataLevel: u.maxDataLevel };
}

@Controller('export')
@UseGuards(SessionGuard)
export class ExportController {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  @Get(':table')
  async export(
    @Req() req: Request,
    @Param('table') table: string,
    @Res() res: Response,
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize(toPrincipal(user), 'export:run').allowed) {
      throw new ForbiddenException('FORBIDDEN:export:run');
    }
    const t = (TABLES as Record<string, { tableId: string }>)[table];
    if (!t || !t.tableId) throw new NotFoundException('UNKNOWN_TABLE:' + table);
    const tableId = t.tableId;

    // 全量分页拉取
    const rows: { id: string; fields: Record<string, unknown> }[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.base.search(tableId, { pageSize: 100, pageToken });
      for (const it of r.items) rows.push({ id: it.recordId, fields: it.fields });
      pageToken = r.hasMore ? r.pageToken : undefined;
    } while (pageToken);

    // 表头以飞书实际字段顺序为准
    const fields = await this.base.listFields(tableId);
    const headers = ['记录ID', ...fields.map((f) => f.name)];

    const esc = (v: unknown): string => {
      if (v == null) return '';
      const s = Array.isArray(v) ? v.join('|') : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push([row.id, ...fields.map((f) => esc(row.fields[f.name]))].join(','));
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
  providers: [baseClientProvider],
})
export class ExportModule {}
