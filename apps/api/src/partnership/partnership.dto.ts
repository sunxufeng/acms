/** 聘用合作关系 DTO（M3 计费，表：聘用合作关系表） */

export interface CreatePartnershipDto {
  教师文本?: string;
  合作机构文本?: string;
  计费方式?: string;
  费率?: number | string;
  计费规则说明?: string;
  生效开始?: string;
  生效结束?: string;
  合作状态?: string;
  备注?: string;
}

export interface UpdatePartnershipDto {
  教师文本?: string;
  合作机构文本?: string;
  计费方式?: string;
  费率?: number | string;
  计费规则说明?: string;
  生效开始?: string;
  生效结束?: string;
  合作状态?: string;
  备注?: string;
}

export interface PartnershipFilterDto {
  q?: string;
  计费方式?: string;
  合作状态?: string;
  教师文本?: string;
  sortBy?: '生效开始' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}
