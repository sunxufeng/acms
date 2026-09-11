import { Injectable, Logger } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import type { SessionUser } from '@acms/contracts';

export interface LoginLogRow {
  id: string;
  /** 登录时间（毫秒时间戳） */
  登录时间: number;
  姓名: string;
  飞书OpenID: string;
  角色: string;
  端类型: string;
}

/**
 * 登录日志：把每次成功登录落到自建 SQL 表，供「活跃时段统计」使用。
 *
 * 为什么需要：会话只存在 Redis（TTL 1 小时、不落库、不可回溯），
 * 而审计日志只记写操作、不含登录 —— 没有这张表就统计不出「用户什么时候用了系统」。
 *
 * ⚠️ 写入是 fire-and-forget：登录链路不能因为日志失败而变慢或失败。
 */
@Injectable()
export class LoginLogService {
  private readonly logger = new Logger(LoginLogService.name);

  /** 启动期幂等建表（自建 SQL 表不存在则首次写入会失败） */
  async ensureTable(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('未配置 DATABASE_URL，跳过登录日志表建表');
      return;
    }
    await sql.ensureTable(TABLES.loginLog.tableId, '登录日志表', []);
  }

  /** 记录一次成功登录。任何异常都吞掉，不影响登录主流程。 */
  async record(user: Pick<SessionUser, 'openId' | 'name' | 'roles'>): Promise<void> {
    try {
      const sql = getSqlStore();
      if (!sql) return;
      const roles = user.roles ?? [];
      const isExternal = roles.some((r) => r === 'student' || r === 'parent');
      await sql.create(TABLES.loginLog.tableId, {
        登录时间: Date.now(),
        姓名: user.name ?? '',
        飞书OpenID: user.openId ?? '',
        角色: roles.join('、'),
        端类型: isExternal ? '学生/家长端' : '管理端',
      });
    } catch (e) {
      this.logger.error(`登录日志写入失败: ${(e as Error).message}`);
    }
  }

  /** 读取时间范围内的登录记录（毫秒时间戳区间，闭区间） */
  async list(fromMs: number, toMs: number): Promise<LoginLogRow[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const out: LoginLogRow[] = [];
    let token: string | undefined;
    // 上限 20 页 × 500 条，防止异常数据量把接口拖垮
    for (let i = 0; i < 20; i++) {
      const res = await sql.search(TABLES.loginLog.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of res.items ?? []) {
        const f = (r as unknown as { fields?: Record<string, unknown> }).fields ?? {};
        const t = Number(f['登录时间'] ?? 0);
        if (t >= fromMs && t <= toMs) {
          out.push({
            id: String((r as unknown as { id?: string }).id ?? ''),
            登录时间: t,
            姓名: String(f['姓名'] ?? ''),
            飞书OpenID: String(f['飞书OpenID'] ?? ''),
            角色: String(f['角色'] ?? ''),
            端类型: String(f['端类型'] ?? ''),
          });
        }
      }
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
    return out;
  }
}
