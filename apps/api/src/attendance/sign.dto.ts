/** 移动端打卡（签到）请求体，见 docs/student-portal-plan.md §9 / §10(P1)。
 *  设计上 studentId 由小程序登录态附带（同会话），此处保留在 body 便于联调与后续 P0 接入。
 *  具体字段校验在服务层（sign.service.ts）完成，与本项目其他 DTO 保持一致（不使用 class-validator）。 */
export interface SignDto {
  /** 关联学生档案的 record_id（关联学生编号字段写入用） */
  studentId: string;
  /** 打卡方式：gps=仅 GPS 校验；wifi=仅 WiFi 校验。二者亦可同时携带，服务端按 OR 判定。 */
  mode: 'gps' | 'wifi';
  /** 当前连入 WiFi 的 SSID（mode=wifi 或携带 WiFi 信息时提供） */
  ssid?: string;
  /** 当前连入 WiFi 的 BSSID（MAC 地址，防伪造；可选） */
  bssid?: string;
  /** GPS 坐标，gcj02 坐标系，"纬度,经度" 形如 "31.2304,121.4737"（mode=gps 或携带 GPS 信息时提供） */
  gps?: string;
  /** 打卡时间戳（ISO 字符串或毫秒）。缺省取服务端当前时间。用于确定考勤日期与签到时间。 */
  at?: string;
  /** 归属/打卡校区（可选，优先取命中围栏的校区） */
  campus?: string;
}
