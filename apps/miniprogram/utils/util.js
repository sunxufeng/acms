// 通用小工具

function pad(n) {
  return ('' + n).padStart(2, '0');
}

/** 本地时间 YYYY-MM-DD HH:mm:ss（用于打卡 at 字段，服务端按此判定考勤日期） */
function formatNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 从打卡记录里取出时间（到校时间 / 离校时间）并格式化为 YYYY-MM-DD HH:mm */
function extractTime(rec) {
  const t = (rec && (rec['到校时间'] || rec['离校时间'])) || '';
  if (!t) return '';
  return ('' + t).replace('T', ' ').slice(0, 16);
}

/** 把 "纬度,经度" 拆成 [lat, lng] 数字数组 */
function parseGps(gps) {
  if (!gps) return null;
  const p = ('' + gps).split(',').map((s) => Number(s.trim()));
  if (p.length !== 2 || Number.isNaN(p[0]) || Number.isNaN(p[1])) return null;
  return p;
}

module.exports = { formatNow, extractTime, parseGps };
