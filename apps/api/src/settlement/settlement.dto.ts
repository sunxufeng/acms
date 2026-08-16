/** 月度结算 DTO（M3 计费，表：月度结算表） */

export interface CreateSettlementDto {
  结算周期?: string;
  结算主体?: string;
  明细数量?: number | string;
  总金额?: number | string;
  审批人?: string;
  审批意见?: string;
  备注?: string;
}

export interface UpdateSettlementDto {
  结算周期?: string;
  结算主体?: string;
  明细数量?: number | string;
  总金额?: number | string;
  审批人?: string;
  审批意见?: string;
  备注?: string;
}

export interface SettlementFilterDto {
  q?: string;
  结算状态?: string;
  结算周期?: string;
  sortBy?: '结算周期' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

export interface TransitionDto {
  to: string;
}

export interface AggregateSettlementDto {
  结算周期: string;
  结算主体?: string;
}

/** 月度结算状态机（SoD：审批中→已批准 需 finance:approve；已关闭禁改金额） */
export const SETTLEMENT_TRANSITIONS: Record<string, { to: string; perm: string }[]> = {
  草拟: [{ to: '已提交', perm: 'billing:settle' }],
  已提交: [{ to: '审批中', perm: 'billing:settle' }],
  审批中: [{ to: '已批准', perm: 'finance:approve' }],
  已批准: [{ to: '已关闭', perm: 'finance:approve' }],
};
