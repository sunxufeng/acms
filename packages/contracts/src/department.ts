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
