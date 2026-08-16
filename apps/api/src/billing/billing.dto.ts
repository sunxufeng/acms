/** 计费明细 DTO（M3 计费，表：计费明细表） */

export interface CreateBillingDto {
  履约引用文本?: string;
  教师文本?: string;
  教学班文本?: string;
  来源课次文本?: string;
  计费周期?: string;
  课时数量?: number | string;
  单价?: number | string;
  金额?: number | string;
  计费状态?: string;
  快照?: string;
  备注?: string;
}

export interface UpdateBillingDto {
  履约引用文本?: string;
  教师文本?: string;
  教学班文本?: string;
  来源课次文本?: string;
  计费周期?: string;
  课时数量?: number | string;
  单价?: number | string;
  金额?: number | string;
  计费状态?: string;
  快照?: string;
  备注?: string;
}

export interface BillingFilterDto {
  q?: string;
  计费状态?: string;
  计费周期?: string;
  教师文本?: string;
  sortBy?: '计费周期' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

export interface TransitionDto {
  to: string;
}

export interface GenerateBillingDto {
  attendanceId: string;
}

/** 计费明细状态机（BR-008 快照固化；已纳入结算为终态金额锁定） */
export const BILLING_TRANSITIONS: Record<string, { to: string; perm: string }[]> = {
  待生成: [{ to: '待确认', perm: 'billing:write' }],
  待确认: [{ to: '已确认', perm: 'billing:confirm' }],
  已确认: [{ to: '已纳入结算', perm: 'billing:settle' }],
};
