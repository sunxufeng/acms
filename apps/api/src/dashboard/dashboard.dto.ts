/** 运营工作台 DTO（M6，指标聚合 + 全局搜索） */

export interface SearchQueryDto {
  q?: string;
}

export interface SearchResultDto {
  students: { id: string; label: string }[];
  teachers: { id: string; label: string }[];
  courses: { id: string; label: string }[];
  classes: { id: string; label: string }[];
}
