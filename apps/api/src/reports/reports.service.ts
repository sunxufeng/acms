import { Inject, Injectable, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/** 报表维度字段：保留真实值（分组统计与筛选需要） */
const DIMENSION_FIELDS: readonly string[] = [
  '校区', '当前年级', '入学年级', '入学年份', '是否是新生', '性别',
];

/**
 * 参与「档案完整度」统计的字段。
 * 必须与前端 `apps/web/components/reports/panels.tsx` 的 COMPLETENESS_FIELDS 保持一致，
 * 否则前后两端的缺失率会不一致。
 */
const COMPLETENESS_FIELDS: readonly string[] = [
  '性别', '出生日期', '入学日期', '校区', '当前年级', '入学年级', '入学年份',
  '当前学段', '实际学制', '入学类型', '来源渠道', '原学校', '原学校类型',
  '合同状态', '付款状态', '综合评定等级', '签证情况', '数据密级',
  '学生手机号', '学生邮箱', '现居住省', '城市',
  '班主任', '招生负责老师', '升学导师',
  'GPA成绩', '出勤率', '作业完成率', '意向专业', '目标国家', '预计毕业日期',
];

/** 有值占位符：让「不给看明细」与「能统计缺失率」同时成立 */
const PLACEHOLDER = '●';

function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/** 只保留报表所需字段；非维度字段一律降级为「有无」占位符，避免泄露学生明细 */
function project(fields: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const k of DIMENSION_FIELDS) row[k] = fields[k] ?? '';
  for (const k of COMPLETENESS_FIELDS) {
    if (DIMENSION_FIELDS.includes(k)) continue;
    row[k] = hasValue(fields[k]) ? PLACEHOLDER : '';
  }
  return row;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /**
   * 报表专用学生数据（权限点 `report:read`，与 `student:read` 解耦）。
   * 只返回维度字段真值 + 完整度占位符，不含姓名/联系方式等明细。
   */
  async studentRows(user: SessionUser, pageSize = 200) {
    if (!authorize(toPrincipal(user), 'report:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:report:read');
    }
    const out: Record<string, unknown>[] = [];
    let token: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = await this.base.search(TABLES.studentProfile.tableId, {
        pageSize,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items) out.push(project((r.fields ?? {}) as Record<string, unknown>));
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return { items: out, total: out.length };
  }
}
