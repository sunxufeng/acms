import { Inject, Injectable, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { LoginLogService } from '../login-log/login-log.service.js';

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
  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly loginLog: LoginLogService,
  ) {}

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
  /**
   * 活跃时段统计（权限点 `report:read`）。
   *
   * 口径（页面会写明，避免被误读成「在线时长」）：
   *  - **登录** = 登录日志表（每次成功登录一条，SessionService.create 时写入）
   *  - **操作** = 审计日志表的写操作（创建/更新/删除，不含查看）
   * 系统里没有访问日志，也没有在线时长记录，所以这只反映「什么时候登录过、什么时候动过数据」。
   */
  async activity(user: SessionUser, query: { from?: string; to?: string } = {}) {
    if (!authorize(toPrincipal(user), 'report:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:report:read');
    }

    const dayMs = 86_400_000;
    const startOf = (d: string): number | null => {
      const t = new Date(`${d}T00:00:00`).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const endOf = (d: string): number | null => {
      const t = new Date(`${d}T23:59:59.999`).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const dayKey = (t: number): string => {
      const d = new Date(t);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    // 默认最近 30 天
    const now = Date.now();
    const fromMs = (query.from ? startOf(query.from) : null) ?? now - 29 * dayMs;
    const toMs = (query.to ? endOf(query.to) : null) ?? now;

    // 1) 登录记录
    const logins = await this.loginLog.list(fromMs, toMs);

    // 2) 审计（写操作）
    const actions: { at: number; actor: string; module: string; action: string }[] = [];
    try {
      let token: string | undefined;
      for (let i = 0; i < 20; i += 1) {
        const page = await this.base.search(TABLES.auditLog.tableId, {
          pageSize: 500,
          ...(token ? { pageToken: token } : {}),
        });
        for (const r of page.items ?? []) {
          const f = (r as unknown as { fields?: Record<string, unknown> }).fields ?? {};
          const at = Number(f['操作时间'] ?? 0);
          if (at >= fromMs && at <= toMs) {
            actions.push({
              at,
              actor: String(f['操作人'] ?? ''),
              module: String(f['业务模块'] ?? ''),
              action: String(f['操作类型'] ?? ''),
            });
          }
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch {
      /* 审计表不可读时只统计登录 */
    }

    interface Agg {
      name: string;
      logins: number;
      actions: number;
      days: Set<string>;
      hours: number[];
      firstAt: number;
      lastAt: number;
    }
    const empty = (): Agg => ({
      name: '',
      logins: 0,
      actions: 0,
      days: new Set<string>(),
      hours: new Array(24).fill(0),
      firstAt: 0,
      lastAt: 0,
    });
    const users = new Map<string, Agg>();
    const touch = (name: string): Agg => {
      let a = users.get(name);
      if (!a) {
        a = empty();
        a.name = name;
        users.set(name, a);
      }
      return a;
    };
    const byHour = new Array(24).fill(0);
    const byDayMap = new Map<string, { date: string; logins: number; actions: number }>();
    const moduleMap = new Map<string, number>();
    const allDays = new Set<string>();

    const bump = (name: string, at: number, kind: 'login' | 'action') => {
      const a = touch(name);
      const h = new Date(at).getHours();
      a.hours[h] = (a.hours[h] ?? 0) + 1;
      byHour[h] = (byHour[h] ?? 0) + 1;
      const dk = dayKey(at);
      a.days.add(dk);
      allDays.add(dk);
      if (!a.firstAt || at < a.firstAt) a.firstAt = at;
      if (at > a.lastAt) a.lastAt = at;
      const day = byDayMap.get(dk) ?? { date: dk, logins: 0, actions: 0 };
      if (kind === 'login') {
        a.logins += 1;
        day.logins += 1;
      } else {
        a.actions += 1;
        day.actions += 1;
      }
      byDayMap.set(dk, day);
    };

    for (const l of logins) if (l.姓名) bump(l.姓名, l.登录时间, 'login');
    for (const a of actions) {
      if (a.actor) bump(a.actor, a.at, 'action');
      if (a.module) moduleMap.set(a.module, (moduleMap.get(a.module) ?? 0) + 1);
    }

    const byUser = [...users.values()]
      .map((a) => ({
        name: a.name,
        logins: a.logins,
        actions: a.actions,
        activeDays: a.days.size,
        firstAt: a.firstAt || null,
        lastAt: a.lastAt || null,
        hours: a.hours,
        peakHour: a.hours.indexOf(Math.max(...a.hours)),
      }))
      .sort((x, y) => y.logins + y.actions - (x.logins + x.actions));

    const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const modules = [...moduleMap.entries()]
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      from: dayKey(fromMs),
      to: dayKey(toMs),
      summary: {
        activeUsers: byUser.length,
        logins: logins.length,
        actions: actions.length,
        activeDays: allDays.size,
        peakHour: byHour.indexOf(Math.max(...byHour)),
      },
      byHour,
      byUser,
      byDay,
      modules,
    };
  }
}
