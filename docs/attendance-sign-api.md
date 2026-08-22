# 学生打卡（签到）接口文档 — `POST /student-attendances/sign`

> 对应方案：`docs/student-portal-plan.md` §9 / §10(P1 打开即签到)。
> 本接口为**服务端校验 + 去重**的写入口；围栏配置来自 `attendance-zones`（见 `考勤围栏` 后台）。
> 小程序源码不在本仓库（仅 `apps/api` + `apps/web`），本文给出对接契约与可直接落地的微信小程序片段。

---

## 1. 权限

- 需要登录态（`acms_sid`，复用现有 `SessionGuard`）。
- 需要权限点 `attendance:write`（或管理员 `admin`）。无权限返回 `403 FORBIDDEN:attendance:write`。

---

## 2. 请求

`POST /api/v1/student-attendances/sign`

Content-Type: `application/json`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `studentId` | string | 是 | 学生在 `学生档案表` 的 record_id（即 `关联学生编号` 写入值） |
| `mode` | `'gps' \| 'wifi'` | 是 | 本次判定依据。`gps`=按 GPS 距离校验；`wifi`=按 WiFi(SSID/BSSID)校验。二者亦可同时携带，服务端按 **OR** 判定 |
| `ssid` | string | 否 | 当前连入 WiFi 的 SSID（`mode=wifi` 或携带 WiFi 信息时提供） |
| `bssid` | string | 否 | 当前连入 WiFi 的 BSSID（MAC，防伪造，可选） |
| `gps` | string | 否 | 当前 GPS，`gcj02` 坐标系，`"纬度,经度"` 形如 `"31.2304,121.4737"`（`mode=gps` 或携带 GPS 信息时提供） |
| `at` | string | 否 | 打卡时间戳（ISO 字符串或毫秒）。缺省取服务端当前时间，用于确定考勤日期与签到时间 |
| `campus` | string | 否 | 归属/打卡校区（可选，优先取命中围栏的校区） |

### 校验规则（服务端）

- `studentId` 必填。
- `mode=gps` 时必须提供合法 `gps`（能解析出两个数值）。
- `mode=wifi` 时必须提供 `ssid` 或 `bssid`。
- 不合法返回 `400 VALIDATION:...`。

### 示例

```json
{
  "studentId": "recuX9abcd1234",
  "mode": "wifi",
  "ssid": "Campus-WiFi-5G",
  "bssid": "AA:BB:CC:DD:EE:FF",
  "at": "2026-08-22T08:05:00+08:00"
}
```

```json
{
  "studentId": "recuX9abcd1234",
  "mode": "gps",
  "gps": "31.2304,121.4737"
}
```

---

## 3. 服务端逻辑

1. **去重方向判定**：查询该学生当天已有的签到记录。
   - 若当天**无**「到达」记录 → 本次方向 = `到达`，写入 `到校时间`。
   - 若已有「到达」但**无**「离开」记录 → 本次方向 = `离开`，写入 `离校时间`。
   - 若该方向记录已存在 → **重复打卡**，直接返回已有记录（`duplicated: true`），不重复写。
2. **围栏校验（GPS OR WiFi）**：加载所有 `状态=启用` 的围栏（`attendance-zones`）。
   - GPS：计算到每个围栏中心的 haversine 距离，≤ `围栏半径(米)`（默认 200）即命中。
   - WiFi：将 `ssid`/`bssid` 与围栏的 `WiFi_SSID列表`/`WiFi_BSSID列表` 比对（大小写/分隔符归一化），命中即过。
   - `passed = gpsMatch || wifiMatch`。
3. **写记录**（`考勤记录表`）：

   | 字段 | 值 |
   |------|----|
   | `关联学生编号` | `[studentId]`（link 写入格式） |
   | `考勤日期` | 本地 `YYYY-MM-DD`（取自 `at`） |
   | `方向` | `到达` / `离开` |
   | `考勤状态` | `正常`（命中）/ `异常`（未命中） |
   | `签到方式` | `gps` / `wifi` |
   | `校区` | 命中围栏的 `校区`，否则取请求 `campus` |
   | `到校时间` / `离校时间` | 对应方向的签到时间（ISO） |
   | `签到WiFi_SSID` | 命中 WiFi 时的 SSID |
   | `签到GPS` | 携带 GPS 时的原始坐标串 |
   | `签到距离(米)` | GPS 到最近围栏中心的距离（四舍五入） |
   | `考勤结果` | 命中时填 `出勤`（异常留待教师后续标记） |

---

## 4. 响应

### 首次/正常签到（201 语义，实际返回 200）

```json
{
  "duplicated": false,
  "passed": true,
  "direction": "到达",
  "method": "wifi",
  "distanceMeters": null,
  "matchedCampus": "申昆路校区",
  "record": {
    "id": "recvSign001",
    "关联学生编号": "recuX9abcd1234",
    "考勤日期": "2026-08-22",
    "方向": "到达",
    "考勤状态": "正常",
    "签到方式": "wifi",
    "签到WiFi_SSID": "Campus-WiFi-5G",
    "校区": "申昆路校区",
    "到校时间": "2026-08-22 08:05"
  }
}
```

### 未命中围栏（异常）

```json
{
  "duplicated": false,
  "passed": false,
  "direction": "到达",
  "method": "gps",
  "distanceMeters": 512,
  "matchedCampus": "",
  "record": { "id": "...", "考勤状态": "异常", "签到距离(米)": 512 }
}
```

### 重复打卡（同一方向同一天再签）

```json
{ "duplicated": true, "record": { "id": "recvSign001", "方向": "到达", "考勤状态": "正常" } }
```

### 错误

| 状态码 | body | 场景 |
|--------|------|------|
| 401 | — | 未登录 / 会话失效 |
| 403 | `FORBIDDEN:attendance:write` | 无 `attendance:write` 权限 |
| 400 | `VALIDATION:gps 方式需提供合法 gps=纬度,经度` 等 | 参数不合法 |

---

## 5. 微信小程序对接片段（P1 打开即签到）

> 约束（见方案 §8）：微信不允许后台静默定位，`onShow` 自动判定即「打开即签到」；
> iOS 上 `getConnectedWifi` 需小程序类目为**企业/教育**并在 `app.json` 声明 `requiredPrivateInfos:["getConnectedWifi"]`。

```js
// sign.js —— 在页面 onShow 中调用 autoSign()
const API_BASE = 'https://your-acms-host/api/v1';

// 本地比对用：小程序登录后 GET /attendance-zones?校区=XXX 拉取并缓存
let cachedZones = null;

function nowLocal() {
  // 与服务端一致：提交本地时间 ISO 字符串
  return new Date().toISOString();
}

async function autoSign(studentId, campus) {
  if (!studentId) return;
  const payload = { studentId, at: nowLocal(), campus };

  // 1) GPS（gcj02）
  try {
    const loc = await new Promise((res, rej) =>
      wx.getLocation({ type: 'gcj02', success: res, fail: rej }));
    payload.mode = 'gps';
    payload.gps = `${loc.latitude},${loc.longitude}`;
  } catch (_) { /* 用户拒绝定位 */ }

  // 2) WiFi（需 wx.startWifi 先初始化）
  try {
    await new Promise((res, rej) => wx.startWifi({ success: res, fail: rej }));
    const wifi = await new Promise((res, rej) =>
      wx.getConnectedWifi({ success: res, fail: rej }));
    payload.mode = payload.mode || 'wifi'; // 同时携带亦可
    payload.ssid = wifi.wifi.SSID;
    payload.bssid = wifi.wifi.BSSID;
  } catch (_) { /* iOS 类目/授权限制可能失败 */ }

  if (!payload.mode) {
    wx.showToast({ title: '需授权定位或WiFi', icon: 'none' });
    return;
  }

  const res = await wx.request({
    url: `${API_BASE}/student-attendances/sign`,
    method: 'POST',
    header: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${wx.getStorageSync('acms_sid')}` },
    data: payload,
  });
  const d = res.data;
  if (d && d.duplicated) {
    wx.showToast({ title: '今日已签到', icon: 'none' });
  } else if (d && d.passed) {
    wx.showToast({ title: d.direction === '到达' ? '到校成功' : '离校成功', icon: 'success' });
  } else {
    wx.showToast({ title: '未在校区内，已记录异常', icon: 'none' });
  }
}
```

> 说明：`Authorization: Bearer <acms_sid>` 为示意；实际会话头名以 `apps/api` 的 `SessionGuard` 为准（通常为 `Cookie` 或自定义头，按现有登录实现传递即可）。

---

## 6. 联调要点

- 围栏经纬度用 **gcj02**（微信 `wx.getLocation({type:'gcj02'})` 直接返回）。不要混用 WGS84。
- 围栏半径默认 200m；楼内精确定位靠已连 WiFi 兜底（GPS 误差较大时仍可由 WiFi 命中）。
- 去重键 = `学生 + 考勤日期 + 方向`，同一方向当天重复请求只返回首条。
- `考勤结果` 命中时置 `出勤`；异常记录由教师端在 `考勤记录表` 后续标记（迟到/早退/缺勤等）。
- 后台维护围栏：`/attendance-zones`（见 `考勤围栏` 菜单），字段与 `scripts/setup_attendance_zone_table.mjs` 一致。
