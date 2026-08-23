/**
 * 坐标系转换工具。
 *
 * 背景（docs/student-portal-plan.md §6）：
 *  - 微信小程序 wx.getLocation({type:'gcj02'}) 返回国测局偏移坐标（gcj02）。
 *  - 围栏中心坐标与小程序的 GPS 必须处于同一坐标系，haversine 距离计算才正确。
 *  - 但 OSM 地图瓦片是 WGS-84（GPS 原始坐标）。
 *
 * 因此约定：ACMS 系统内所有落库坐标统一为 gcj02；
 * 地图组件（OSM 瓦片）在显示时把 gcj02→WGS-84，在用户选取时把 WGS-84→gcj02。
 * 本文件即这一转换的唯一事实来源，前端（MapPicker）与小程序端共用同一算法。
 */

const PI = Math.PI;
const A = 6378245.0; // Krasovsky 1940 椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

export function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(lng: number, lat: number): number {
  let ret =
    -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.2 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lat * PI) + 40.0 * Math.sin((lat / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((lat / 12.0) * PI) + 320 * Math.sin((lat * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(lng: number, lat: number): number {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lng * PI) + 40.0 * Math.sin((lng / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((lng / 12.0) * PI) + 300.0 * Math.sin((lng / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS-84（GPS 原始）→ GCJ-02（国测局，微信/高德/腾讯使用） */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}

/** GCJ-02 → WGS-84（近似逆变换，迭代一次即足够地图显示精度） */
export function gcj02ToWgs84(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  const [gLat, gLng] = wgs84ToGcj02(lat, lng);
  return [lat * 2 - gLat, lng * 2 - gLng];
}
