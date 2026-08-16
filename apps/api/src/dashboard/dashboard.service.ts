import { Inject, Injectable, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';
import { SearchQueryDto, SearchResultDto } from './dashboard.dto.js';

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class DashboardService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /** 4 指标卡 + 待办 + 异常轨（真实聚合，只读） */
  async metrics(user: SessionUser) {
    if (!authorize(toPrincipal(user), 'student:read').allowed) throw new ForbiddenException('FORBIDDEN:student:read');
    const today = new Date().toISOString().slice(0, 10);
    const safe = async (fn: () => Promise<number>) => {
      try { return await fn(); } catch { return 0; }
    };
    const count = async (tableId: string, conditions: { field: string; op?: string; value: string[] }[]) => {
      const r = await this.base.search(tableId, { pageSize: 1, filter: buildFilter(conditions) });
      return r.total ?? 0;
    };
    const countAll = async (tableId: string) => {
      const r = await this.base.search(tableId, { pageSize: 100 });
      return r.items;
    };

    const [在读学生, 今日课次, 待确认课次, 待履约, 待教务审核, 待确认计费, 待审批结算, 待审核调整, 失败通知, 考勤异常] =
      await Promise.all([
        safe(() => count(TABLES.studentProfile.tableId, [{ field: '当前状态', value: ['在读'] }])),
        safe(() => count(TABLES.session.tableId, [{ field: '课次日期', value: [today] }])),
        safe(() => count(TABLES.session.tableId, [{ field: '课次状态', value: ['待确认'] }])),
        safe(async () => {
          const items = await countAll(TABLES.teacherAttendance.tableId);
          return items.filter((r) => (r.fields['出勤状态'] as string) !== '可计费').length;
        }),
        safe(() => count(TABLES.teacherAttendance.tableId, [{ field: '出勤状态', value: ['教师已确认'] }])),
        safe(() => count(TABLES.billingDetail.tableId, [{ field: '计费状态', value: ['待确认'] }])),
        safe(() => count(TABLES.monthlySettlement.tableId, [{ field: '结算状态', value: ['审批中'] }])),
        safe(() => count(TABLES.adjustment.tableId, [{ field: '状态', value: ['待审核'] }])),
        safe(() => count(TABLES.notificationLog.tableId, [{ field: '发送状态', value: ['失败'] }])),
        safe(async () => {
          const items = await countAll(TABLES.teacherAttendance.tableId);
          return items.filter((r) => !!(r.fields['异常描述'] as string)?.trim()).length;
        }),
      ]);

    return {
      cards: [
        { key: 'students', label: '在读学生', value: 在读学生 },
        { key: 'todaySessions', label: '今日课次', value: 今日课次 },
        { key: 'pendingFulfillment', label: '待履约', value: 待履约 },
        { key: 'pendingSessions', label: '待确认课次', value: 待确认课次 },
      ],
      todos: [
        { key: 'attendanceReview', label: '待教务审核履约', value: 待教务审核 },
        { key: 'billingConfirm', label: '待确认计费', value: 待确认计费 },
        { key: 'settlementApprove', label: '待审批结算', value: 待审批结算 },
        { key: 'adjustmentReview', label: '待审核调整', value: 待审核调整 },
      ],
      exceptions: [
        { key: 'notifyFailed', label: '失败通知', value: 失败通知 },
        { key: 'attendanceAnomaly', label: '考勤异常', value: 考勤异常 },
      ],
    };
  }

  /** 全局搜索（跨学生/教师/课程方案/教学班） */
  async search(user: SessionUser, dto: SearchQueryDto): Promise<SearchResultDto> {
    if (!authorize(toPrincipal(user), 'student:read').allowed) throw new ForbiddenException('FORBIDDEN:student:read');
    const q = (dto.q || '').trim();
    const empty: SearchResultDto = { students: [], teachers: [], courses: [], classes: [] };
    if (!q) return empty;
    const safe = async (fn: () => Promise<SearchResultDto[keyof SearchResultDto]>) => {
      try { return await fn(); } catch { return []; }
    };
    const pick = async (tableId: string, field: string, labelField: string) => {
      const r = await this.base.search(tableId, {
        pageSize: 10,
        filter: buildFilter([{ field, op: 'contains', value: [q] }]),
      });
      return r.items.map((it) => ({
        id: it.recordId,
        label: String((it.fields as Record<string, unknown>)[labelField] ?? it.recordId),
      }));
    };
    const [students, teachers, courses, classes] = await Promise.all([
      safe(() => pick(TABLES.studentProfile.tableId, '学生姓名', '学生姓名')),
      safe(() => pick(TABLES.teacherProfile.tableId, '教师姓名', '教师姓名')),
      safe(() => pick(TABLES.coursePlan.tableId, '课程方案名称', '课程方案名称')),
      safe(() => pick(TABLES.teachingClass.tableId, '教学班名称', '教学班名称')),
    ]);
    return { students, teachers, courses, classes };
  }
}
