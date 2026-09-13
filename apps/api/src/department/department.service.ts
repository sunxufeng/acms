import { Injectable, Logger } from '@nestjs/common';
import {
  TABLES,
  type DepartmentListResult,
  type DepartmentMemberResult,
  type DepartmentNode,
  type DepartmentStatus,
  type DepartmentSyncProgress,
} from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { runAs, systemActor } from '../shared/actor-context.js';
import { getRootDepartment, listDepartments, listDepartmentMembers } from '../ai/lib/feishu/client.js';

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
    // 成员快照表（2026-09-13 新增）：「点部门看员工」用，随部门同步一起写
    await sql.ensureTable(TABLES.departmentMembers.tableId, '部门成员表', []);
    this.logger.log('[department] 部门表 / 部门成员表已就绪');
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

  /**
   * 部门子树 id 集合（含自身）。
   * 用于「含下级」展开：飞书 find_by_department 只给直属成员，
   * 点「公司」或任何中间层部门想知道全部人，就必须先展开子树再筛。
   */
  private subtreeIds(nodes: DepartmentNode[], rootId: string): string[] {
    const childrenMap = new Map<string, string[]>();
    for (const n of nodes) {
      if (n.status === 'invalid') continue;
      const p = n.parent_department_id || '';
      const arr = childrenMap.get(p);
      if (arr) arr.push(n.open_department_id);
      else childrenMap.set(p, [n.open_department_id]);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (x: string) => {
      if (!x || seen.has(x)) return;
      seen.add(x);
      out.push(x);
      for (const c of childrenMap.get(x) ?? []) walk(c);
    };
    walk(rootId);
    return out;
  }

  /**
   * 读取某部门下的员工（来自成员快照表，不打上游）。
   *
   * includeSub 默认 **true**：含子部门。因为飞书只给直属成员，
   * 点「公司」/中间层部门时若不含下级就永远是空的 —— 那不是用户要的「部门下的员工」。
   * 只想看直属成员时传 includeSub=false。
   */
  async listMembers(openDepartmentId: string, includeSub = true): Promise<DepartmentMemberResult> {
    const sql = getSqlStore();
    if (!sql) return { items: [], total: 0, department_ids: [], synced_at: 0 };
    const id = String(openDepartmentId || '').trim();
    if (!id) return { items: [], total: 0, department_ids: [], synced_at: 0 };

    const all = await this.list();
    const ids = includeSub ? this.subtreeIds(all.items, id) : [id];
    const idSet = new Set(ids);

    const res = await sql.search(TABLES.departmentMembers.tableId, { pageSize: 5000 });
    const items = (res.items || [])
      .map((r) => {
        const f = (r.fields || {}) as Record<string, unknown>;
        const st = String(f.status ?? 'active');
        return {
          open_id: String(f.user_open_id ?? ''),
          name: String(f.name ?? ''),
          en_name: String(f.en_name ?? ''),
          job_title: String(f.job_title ?? ''),
          employee_no: String(f.employee_no ?? ''),
          user_id: String(f.user_id ?? ''),
          avatar: String(f.avatar ?? ''),
          open_department_id: String(f.open_department_id ?? ''),
          department_name: String(f.department_name ?? ''),
          status: (st === 'resigned' || st === 'inactive' ? st : 'active') as
            | 'active'
            | 'resigned'
            | 'inactive',
          synced_at: Number(f.synced_at ?? 0),
        };
      })
      .filter((m) => m.open_id && idSet.has(m.open_department_id))
      // 在职在前、再按姓名；同一人可能在多个部门（飞书本来就允许多部门）
      .sort((a, b) => {
        const rank = (s: string) => (s === 'active' ? 0 : s === 'resigned' ? 2 : 1);
        return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name, 'zh-CN');
      });

    const syncedAt = items.reduce((m, it) => Math.max(m, it.synced_at), 0);
    return { items, total: items.length, department_ids: ids, synced_at: syncedAt };
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
        const upsertDept = async (d: Record<string, any>, isRoot: boolean) => {
          const status: DepartmentStatus = d.status?.is_deleted
            ? 'invalid'
            : d.status?.is_deactivated
              ? 'disabled'
              : 'active';
          // ⚠️ 飞书对**根部门**返回的 name 是空串（实测 /departments/0 → "name":""），
          //    不兜底的话树的最上层就是一行空白 —— 用户报的「公司没有显示出来」正是这个。
          const rawName = String(d.name ?? '').trim() || String(d.i18n_name ?? '').trim();
          const name = rawName || (isRoot ? '公司' : String(d.open_department_id ?? ''));
          await sql.createWithId(TABLES.departments.tableId, String(d.open_department_id), {
            open_department_id: String(d.open_department_id),
            name,
            // 根部门强行置空 parent：列表接口把一级部门的 parent 写成 '0'，
            // 根若也存 '0' 就成了「自己是自己的父」，前端建树会出环
            parent_department_id: isRoot ? '' : String(d.parent_department_id ?? ''),
            order: Number(d.order ?? 0),
            status,
            leader_user_id: String(d.leader_user_id ?? ''),
            manager_user_id: String(d.manager_user_id ?? ''),
            i18n_name: d.i18n_name ?? null,
            member_count: Number(d.member_count ?? 0),
            synced_at: now,
          });
          stored++;
        };

        // 0) 根部门（公司）：部门列表接口只返回「根的子孙」、不含根自身，
        //    不补这一条，前端树就永远缺最上层「公司」（2026-09-13 用户反馈的现场）。
        let rootName = '';
        const rr = await getRootDepartment(undefined);
        if (rr && 'error' in rr) {
          this.logger.warn(`[department] 根部门读取失败（不影响子部门同步）：${rr.error}`);
        } else if (rr && 'department' in rr) {
          rootName = String(rr.department.name || '');
          await upsertDept(rr.department as Record<string, any>, true);
        }

        for (const d of depts) await upsertDept(d, false);

        // 1) 成员快照：逐部门拉「直属」成员（飞书该接口不含子部门，含下级由查询侧递归子树）。
        //    记录 id = `${部门ID}__${成员open_id}`，用 bulkInsert 批量 upsert（多值 INSERT + ON CONFLICT）。
        const memberRows: { id: string; fields: Record<string, unknown> }[] = [];
        const failedDepts = new Set<string>();
        for (const d of depts) {
          const id = String(d.open_department_id || '');
          if (!id) continue;
          const mr = await listDepartmentMembers(undefined, id);
          if (mr && 'error' in mr) {
            // ⚠️ 记录失败部门：下面的「清理陈旧成员」必须跳过它们，
            //    否则一次上游抖动会把该部门的成员快照整段删掉
            failedDepts.add(id);
            this.logger.warn(`[department] 部门 ${id} 成员读取失败：${mr.error}`);
            continue;
          }
          for (const u of (mr as { users: Array<Record<string, any>> }).users || []) {
            if (!u.open_id) continue;
            memberRows.push({
              id: `${id}__${u.open_id}`,
              fields: {
                open_department_id: id,
                department_name: String(d.name ?? ''),
                user_open_id: String(u.open_id),
                user_id: String(u.user_id ?? ''),
                name: String(u.name ?? ''),
                en_name: String(u.en_name ?? ''),
                job_title: String(u.job_title ?? ''),
                employee_no: String(u.employee_no ?? ''),
                avatar: String(u.avatar ?? ''),
                status: u.is_resigned ? 'resigned' : u.is_activated ? 'active' : 'inactive',
                synced_at: now,
              },
            });
          }
          // 上游 QPS 保护（部门数不多，但别打太密）
          await new Promise((res) => setTimeout(res, 120));
        }
        let memberStored = 0;
        if (memberRows.length) {
          memberStored = await sql.bulkInsert(TABLES.departmentMembers.tableId, memberRows);
        }

        // 2) 清理陈旧成员（调岗/离职）：本轮没被写回（synced_at != now）且所属部门同步成功的，即已不在快照里。
        //    ⚠️ SqlStore.search 返回的记录里 id 字段名是 recordId，不是 id（本项目反复踩过）
        let memberRemoved = 0;
        const prev = await sql.search(TABLES.departmentMembers.tableId, { pageSize: 5000 });
        for (const row of prev.items || []) {
          const f = (row.fields || {}) as Record<string, unknown>;
          if (Number(f.synced_at ?? 0) === now) continue;
          if (failedDepts.has(String(f.open_department_id ?? ''))) continue;
          const r = row as unknown as { recordId?: string; id?: string };
          const rid = String(r.recordId ?? r.id ?? '');
          if (!rid) continue;
          await sql.delete(TABLES.departmentMembers.tableId, rid);
          memberRemoved++;
        }

        const deleted = depts.filter((d) => d.status?.is_deleted).length;
        state.fetched = depts.length;
        state.stored = stored;
        state.result =
          `同步完成：部门 ${stored} 个（含已删除 ${deleted} 个标记为无效` +
          `${rootName ? `，根部门「${rootName}」已补齐` : ''}），` +
          `成员 ${memberStored} 条${memberRemoved ? `（清理失效 ${memberRemoved} 条）` : ''}`;
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
