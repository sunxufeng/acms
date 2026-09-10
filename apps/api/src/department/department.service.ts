import { Injectable, Logger } from '@nestjs/common';
import { TABLES, type DepartmentListResult, type DepartmentNode, type DepartmentStatus, type DepartmentSyncProgress } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { runAs, systemActor } from '../shared/actor-context.js';
import { listDepartments } from '../ai/lib/feishu/client.js';

/**
 * 部门管理：只读同步飞书通讯录部门树到本地 SQL 表（t_tbldept0000001）。
 *
 * 设计要点：
 * - 数据**只读**：本模块不提供任何写接口给前端，所有数据来自「同步飞书部门」按钮，
 *   由后端以 system:department-sync 身份后台写入（审计 created_by/updated_by 记到该身份）。
 * - 不走 RoutingStore / BaseClient（新表不在 SQL_TABLES 灰度清单，飞书侧也无此表），
 *   直接用 getSqlStore() 做幂等建表 + 按 open_department_id 做 upsert。
 * - 已删除部门（飞书 status.is_deleted）落库 status='invalid'，前端树中不展示；
 *   已停用（is_deactivated）落库 status='disabled'，前端保留并打「停用」标。
 */
@Injectable()
export class DepartmentService {
  private readonly logger = new Logger('Department');

  /** 全局唯一同步任务的实时进度（部门只有一份全局同步，用固定 key） */
  private readonly syncState: DepartmentSyncProgress = {
    running: false,
    startedAt: 0,
    fetched: 0,
    stored: 0,
    sourceName: '',
  };

  /** 启动期幂等建表（若未配置 DATABASE_URL 则静默跳过，读取时返回空） */
  async ensureDepartmentTable(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[department] 未配置 DATABASE_URL，跳过建表（部门功能不可用）');
      return;
    }
    await sql.ensureTable(TABLES.departments.tableId, '部门表', []);
    this.logger.log('[department] 部门表已就绪');
  }

  /** 读取全部部门（前端据此构建树）。已删除部门(status='invalid')也一并返回，由前端过滤。 */
  async list(): Promise<DepartmentListResult> {
    const sql = getSqlStore();
    if (!sql) return { items: [], total: 0, lastSyncedAt: 0 };
    const res = await sql.search(TABLES.departments.tableId, { pageSize: 2000 });
    const items: DepartmentNode[] = (res.items || []).map((r) => {
      const f = (r.fields || {}) as Record<string, unknown>;
      return {
        open_department_id: String(f.open_department_id ?? ''),
        name: String(f.name ?? ''),
        parent_department_id: String(f.parent_department_id ?? ''),
        order: Number(f.order ?? 0),
        status: ((f.status as DepartmentStatus) || 'active'),
        leader_user_id: String(f.leader_user_id ?? ''),
        manager_user_id: String(f.manager_user_id ?? ''),
        member_count: Number(f.member_count ?? 0),
        synced_at: Number(f.synced_at ?? 0),
      };
    });
    const lastSyncedAt = items.reduce((m, it) => Math.max(m, it.synced_at), 0);
    return { items, total: items.length, lastSyncedAt };
  }

  /** 触发一次同步（异步）：HTTP 立即返回当前进度，后台跑 listDepartments 并落库 */
  sync(): DepartmentSyncProgress {
    if (this.syncState.running) return this.syncState;
    this.syncState.running = true;
    this.syncState.startedAt = Date.now();
    this.syncState.finishedAt = undefined;
    this.syncState.fetched = 0;
    this.syncState.stored = 0;
    this.syncState.sourceName = '飞书通讯录';
    this.syncState.error = undefined;
    this.syncState.result = undefined;
    void this.runSync();
    return this.syncState;
  }

  /** 查询当前/最近一次同步进度 */
  getSyncStatus(): DepartmentSyncProgress {
    return this.syncState;
  }

  /** 后台执行同步，写身份 system:department-sync，进度写入 syncState 供轮询 */
  private async runSync(): Promise<void> {
    await runAs(systemActor('department-sync', '系统 · 部门同步'), async () => {
      const state = this.syncState;
      try {
        const r = await listDepartments(undefined);
        if (r && 'error' in r) {
          state.error = r.error;
          state.result = `失败：${r.error}`;
          return;
        }
        const depts = (r as { departments: Array<Record<string, any>>; rootId: string }).departments || [];
        const sql = getSqlStore();
        if (!sql) {
          state.error = '未配置数据库';
          state.result = '失败：未配置 DATABASE_URL';
          return;
        }
        const now = Date.now();
        let stored = 0;
        for (const d of depts) {
          const status: DepartmentStatus = d.status?.is_deleted
            ? 'invalid'
            : d.status?.is_deactivated
              ? 'disabled'
              : 'active';
          await sql.createWithId(TABLES.departments.tableId, String(d.open_department_id), {
            open_department_id: String(d.open_department_id),
            name: String(d.name ?? ''),
            parent_department_id: String(d.parent_department_id ?? ''),
            order: Number(d.order ?? 0),
            status,
            leader_user_id: String(d.leader_user_id ?? ''),
            manager_user_id: String(d.manager_user_id ?? ''),
            i18n_name: d.i18n_name ?? null,
            member_count: Number(d.member_count ?? 0),
            synced_at: now,
          });
          stored++;
        }
        const deleted = depts.filter((d) => d.status?.is_deleted).length;
        state.fetched = depts.length;
        state.stored = stored;
        state.result = `同步完成：共 ${depts.length} 个部门（含已删除 ${deleted} 个，已标记为无效）`;
      } catch (e) {
        const msg = (e as Error).message;
        state.error = msg;
        state.result = `失败：${msg}`;
        this.logger.error(`[department] 同步失败: ${msg}`);
      } finally {
        state.running = false;
        state.finishedAt = Date.now();
      }
    });
  }
}
