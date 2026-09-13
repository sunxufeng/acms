/**
 * 组织管理 / 部门管理 共享类型。
 *
 * 部门数据只读同步自飞书通讯录（contact:department:readonly），落本地 SQL 表
 * t_tbldept0000001，记录 id = 飞书 open_department_id。
 *
 * status 取值（前端据此决定树形呈现）：
 * - 'active'  正常
 * - 'disabled' 已停用（飞书 status.is_deactivated），保留在树中并打「停用」标
 * - 'invalid' 已删除（飞书 status.is_deleted），不在树中出现（用户需求：标记无效，不显示）
 */

export type DepartmentStatus = 'active' | 'disabled' | 'invalid';

/** 单个部门节点（已归一化，与飞书原始响应解耦） */
export interface DepartmentNode {
  open_department_id: string;
  name: string;
  parent_department_id: string;
  /** 飞书排序权重，越大越靠前 */
  order: number;
  status: DepartmentStatus;
  leader_user_id: string;
  manager_user_id: string;
  member_count: number;
  /** 最近一次同步时间戳（毫秒） */
  synced_at: number;
}

export interface DepartmentListResult {
  items: DepartmentNode[];
  total: number;
  /** 全部记录中最大的 synced_at，用于前端展示「最近同步时间」 */
  lastSyncedAt: number;
}

/** 同步进度（HTTP 立即返回，前端轮询 sync-status 取实时状态） */
export interface DepartmentSyncProgress {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  stored: number;
  sourceName: string;
  error?: string;
  result?: string;
}

/**
 * 部门成员（「点部门看员工」用的直属成员快照）。
 *
 * 数据来源：飞书 contact v3 `users/find_by_department`，随部门同步一起落本地
 * 表 t_tbldeptmem000001（记录 id = `${部门ID}__${成员 open_id}`），点开即出、不打上游。
 *
 * ⚠️ 只存**直属**成员：该接口不含子部门成员。含下级展开由后端按部门树递归子树后过滤，
 *    所以同一个人可能出现在多条记录里（他在多个部门时飞书本来就如此）。
 */
export interface DepartmentMember {
  open_id: string;
  name: string;
  en_name: string;
  /** 职务（飞书 job_title）—— ⚠️ 实测 find_by_department 不返回该字段，通常为空 */
  job_title: string;
  /** 工号（飞书 employee_no）—— ⚠️ 实测不返回，通常为空 */
  employee_no: string;
  /** 飞书 user_id（企业内成员编号，可作为「用户ID」展示） */
  user_id: string;
  avatar: string;
  /** 其**直属**部门 ID（含下级展开时用于区分同一个人来自哪个部门） */
  open_department_id: string;
  /** 其直属部门名（前端展示用，避免再查一次部门表） */
  department_name: string;
  /** active 在职 / resigned 已离职 / inactive 未激活 */
  status: 'active' | 'resigned' | 'inactive';
  synced_at: number;
}

export interface DepartmentMemberResult {
  items: DepartmentMember[];
  total: number;
  /** 命中的部门 ID 集合（含下级展开时有多个），供前端提示口径 */
  department_ids: string[];
  /** 这份快照的同步时间（取最大值），为 0 表示还没同步过成员 */
  synced_at: number;
}
