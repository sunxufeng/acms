/** 调整冲销 DTO（M3 计费，表：调整冲销表） */

export interface CreateAdjustmentDto {
  关联结算文本?: string;
  关联计费文本?: string;
  方向?: string;
  金额?: number | string;
  原因?: string;
  备注?: string;
}

export interface UpdateAdjustmentDto {
  关联结算文本?: string;
  关联计费文本?: string;
  方向?: string;
  金额?: number | string;
  原因?: string;
  备注?: string;
}

export interface AdjustmentFilterDto {
  q?: string;
  关联结算文本?: string;
  方向?: string;
  状态?: string;
  sortBy?: '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

export interface TransitionDto {
  to: string;
}

/** 调整冲销状态机（BR-009 守恒；SoD：审核人不得为发起人） */
export const ADJUSTMENT_TRANSITIONS: Record<string, { to: string; perm: string }[]> = {
  待审核: [{ to: '已审核', perm: 'finance:approve' }],
};
