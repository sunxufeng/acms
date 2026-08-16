/** 场地资源 DTO（M2 排课域） */

export interface CreateVenueDto {
  场地名称: string;
  校区?: string;
  场地类型?: string;
  容纳人数?: number | string;
  设备与资源?: string;
  可用状态?: string;
  可用时段说明?: string;
  备注?: string;
}

export interface UpdateVenueDto {
  场地名称?: string;
  校区?: string;
  场地类型?: string;
  容纳人数?: number | string;
  设备与资源?: string;
  可用状态?: string;
  可用时段说明?: string;
  备注?: string;
}

export interface VenueFilterDto {
  q?: string;
  场地类型?: string;
  可用状态?: string;
  sortBy?: '场地名称' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}
