# 学生端接入方案(v4 · 微信小程序为主)

> 适用范围:国际学校。课堂禁用手机,考勤以"到校/离校"为主。
> 学生自行安装飞书但**不在学校组织架构下**,经飞书开发者后台确认:标准自建应用无"邀请外部用户"/"管理外部用户"入口,仅有机器人对外共享。
> 因此**飞书集成路径被阻断**,主载体回退为**微信小程序**;飞书仅作为教师/管理员端保留。

---

## 1. 决策要点

| 项 | 决策 | 说明 |
|----|------|------|
| 主载体 | 微信小程序 | 飞书标准自建应用无法让组织外学生登录,已确认不可用 |
| 打卡触发 | 打开小程序即自动判定并提交 | 微信不允许后台静默定位打卡;最小交互 = 打开小程序 |
| 到校判定 | WiFi SSID 命中 **或** GPS 距校 ≤ 围栏半径 | 二选一即过,覆盖"连 WiFi"与"用流量到附近" |
| WiFi 配置 | 多 SSID / 多 AP,按校区配置 | 后台可维护,不写死 |
| 围栏精度 | 校门口 100–200 米 | 楼内精确判定靠已连 WiFi 兜底 |
| 教师/管理端 | 继续用现有飞书端 | 学生端用微信小程序,数据仍写入同一套 Base 表 |

---

## 2. 飞书不可行的原因(已确认)

1. 组织已认证,但开发者后台 **应用权限 → 可用范围 / 应用访问权限** 里没有"外部用户"标签页。
2. **应用发布 → 版本管理与发布 → 创建版本** 中没有"允许邀请外部用户"权限点。
3. **应用权限 → 管理外部用户** 菜单不存在。
4. 仅有的"对外共享"只针对**机器人**(外部群/外部用户单聊),不适用于网页应用或小程序让外部用户登录。

结论:标准自建应用的学生端入口无法以组织外飞书个人账号方式接入。如未来学生纳入组织架构,可再迁移到飞书小程序(复用现有 AppID/会话/Base)。

---

## 3. 整体架构

```
微信小程序(学生端)
   │  wx.login() → code
   ▼
API /student/auth/wechat-login   ← code2Session(小程序AppID+Secret) → openid
   │  首次:绑定学号+姓名(或家长授权)
   │  签发 acms_sid(复用现有 SessionUser 结构,附 studentId)
   ▼
本地存 token;后续请求带 acms_sid
   │
   ├─ GET /attendance-zones?campus=北京   ← 拉取本校围栏中心 / 半径 / SSID 列表
   │
   └─ onShow → 自动检测:
        wx.startWifi() → wx.getConnectedWifi()  → SSID 是否命中本校配置列表
        wx.getLocation(gcj02) → 距围栏中心 ≤ 半径?
        任一满足 → POST /student-attendances/sign
```

后端复用现有 ACMS 能力:
- `acms_sid` 会话(Redis 存储,结构含 `roles`、`campuses`、`maxDataLevel`、`studentId`)。
- `student` 角色 + `attendance:*` 权限点(`packages/contracts/src/role.ts` 已存在)。
- 通用 CRUD 过滤:学生仅可见 `关联学生 == studentId` 的记录。

---

## 4. 登录与学生绑定

1. 小程序 `wx.login()` 拿 `code`,调 `/student/auth/wechat-login`。
2. 后端用微信小程序 **AppID + AppSecret** 调微信 `code2Session` 换 `openid`。
   **注意**:这是全新的凭证,与现有飞书 `FEISHU_APP_ID/SECRET` 无关,需新增 `WECHAT_MINI_APPID/SECRET` 配置。
3. 绑定(一次性):
   - **路径 A(学生自助)**:输入学号 + 姓名(可加出生日期校验)绑定 openid ↔ 学生档案(飞书 base `student-profile`)。
   - **路径 B(家长代绑)**:家长在 H5 端用已有账号授权,扫码/输入绑定学生。
4. 绑定成功后签发 `acms_sid`,`SessionUser.roles = ['student']`,`studentId` 写入会话。
5. 解绑/换绑:后台或 H5 端管理。

---

## 5. 打卡流程(打开即签到)

小程序"签到页" `onShow` 生命周期内自动执行,**无需点击按钮**:

1. `wx.startWifi()` → `wx.getConnectedWifi()` 取 `wifi.SSID`(iOS 需企业/教育类小程序;用户手势由打开小程序满足)。
2. `wx.getLocation({ type: 'gcj02' })` 取经纬度。
3. 与本校配置比对:
   - `SSID ∈ 配置 SSID 列表` → **WiFi 通过**
   - `haversine(gps, 围栏中心) ≤ 围栏半径` → **GPS 通过**
4. 任一通过 → `POST /student-attendances/sign`:
   ```json
   { "studentId": "...", "mode": "wifi|gps", "ssid": "School-WiFi",
     "gps": "39.9xx,116.3xx", "at": "2026-08-22 08:12" }
   ```
5. 后端校验 `studentId`(来自会话) + 去重(同一学生当日同一方向仅记一次) → 写 `student-attendances` → 返回成功。
6. 页面展示"今日已签到 ✅ 08:12(WiFi)"。
7. 两者都不满足 → 提示"未到校,暂不能签到",显示当前距离/检测到的 SSID,并提供"刷新"按钮。

去重规则:按 `学生 + 考勤日期 + 方向(到达/离开)` 取首个有效记录;重复请求返回已有记录,不重复写。

---

## 6. 围栏与 WiFi 判定细节

- **坐标系统一为 gcj02**:`wx.getLocation({type:'gcj02'})` 返回国测局偏移坐标;围栏中心也必须以 gcj02 存储(真实地址需转换)。
- **距离计算**:haversine 公式,地球半径 6371000 米。
- **围栏半径**:默认 200 米,按校区可配置。
- **WiFi 判定强度**:
  - 基础:仅比 SSID(易伪造,但需物理在场才能连上该校 WiFi)。
  - 增强(可选):同时比 BSSID(AP 的 MAC)抗 SSID 仿冒;多 AP 时任一 BSSID 命中即通过。
- **GPS + WiFi 互补**:室外/到校路上靠 GPS;进入楼内 GPS 漂移时靠已连 WiFi。两者 OR 关系。

---

## 7. 区域配置模型(多 AP、可配置 SSID)

新增飞书 base 表 **`attendance-zones`**,由管理员在 Web 后台维护,小程序按校区拉取:

| 字段 | 类型 | 说明 |
|------|------|------|
| 校区 | 单选 | 关联 campuses |
| 围栏中心(纬度) | number | gcj02 |
| 围栏中心(经度) | number | gcj02 |
| 围栏半径(米) | number | 默认 200 |
| WiFi_SSID列表 | 多行文本 / 多选 | 支持多个 AP,如 `School-WiFi;School-WiFi-5G` |
| WiFi_BSSID列表 | 多行文本 | 可选,增强防伪 |
| 适用学生范围 | 文本/筛选 | 默认全部;可限定年级 |

小程序登录后 `GET /attendance-zones?campus=<学生校区>` 拉取本校配置缓存到本地,打卡时本地比对。

---

## 8. 微信平台限制(关键约束)

1. **不允许后台静默定位打卡**:微信小程序 `wx.startLocationUpdateBackground` 不向考勤打卡类目开放,微信官方建议用 `wx.getLocation`。
   → 最小合规交互 = 学生**打开小程序**,`onShow` 内自动判定即"打开即签到"。
2. **WiFi API 类目限制**:iOS 上 `getConnectedWifi` 需要小程序为**企业/教育类**,且需 `requiredPrivateInfos:["getConnectedWifi"]` 声明 + `wx.startWifi()`。
3. **定位授权**:`wx.getLocation` 需 `scope.userLocation`,首次进入引导授权。

---

## 9. 权限与数据模型

- **角色**:新增 `student` 角色(权限点 `student:read/write/archive` 与 `attendance:*` 已存在),绑定到 `SessionUser.studentId`。
- **数据可见性**:学生端列表/详情自动追加过滤 `关联学生 == studentId`。
- **考勤记录表 `student-attendances`**:
  | 字段 | 说明 |
  |------|------|
  | 学生 | 关联学生档案 |
  | 考勤日期 | date |
  | 方向 | 到达 / 离开 |
  | 签到时间 | datetime(HH:mm) |
  | 签到方式 | wifi / gps |
  | 签到WiFi_SSID | 文本 |
  | 签到GPS | 文本(纬度,经度) |
  | 校区 | 关联 campuses |
  | 状态 | 正常 / 异常 |
  | 备注 | 文本 |
- **写入口**:`POST /student-attendances/sign`(需 `attendance:write` 或 `attendance:*`),服务端校验 + 去重。

---

## 10. 实施阶段

- **P0 登录与绑定**:微信小程序脚手架;`/student/auth/wechat-login`(code2Session + openid 绑定学号);签发 `acms_sid`;`student` 角色接入。
- **P1 打开即签到**:onShow 自动 WiFi+GPS 判定;`/student-attendances/sign` 写记录 + 去重;成功/未到校 UI;定位授权引导。
- **P2 区域配置管理**:`attendance-zones` 表 + Web 后台维护;小程序按校区拉取。
- **P3 家长 H5 补充端**:考勤记录查看、代低龄学生、请假/异常反馈(纯浏览,可走外部浏览器)。

---

## 11. 待确认事项

1. 微信小程序 **AppID / AppSecret** 是否已有,还是需要新注册。
2. 小程序账号类目是否已认证为**企业/教育类**(影响 iOS WiFi API 可用性)。
3. 学校各校区 WiFi **SSID(及可选 BSSID)** 清单。
4. 各校区校门口 **gcj02 中心坐标** 与期望围栏半径(默认 200 米)。
5. 是否需要"离开"打卡,还是只记"到达"。
6. 低龄学生是否需家长代绑/代签。

---

## 12. 未来回切飞书的条件

若后续学校将学生纳入飞书组织架构(作为通讯录成员),则可立即回切到飞书小程序:
- 复用现有 `FEISHU_APP_ID/SECRET`、现有 `acms_sid` 会话、现有 Base 表;
- 飞书 `tt.getConnectedWifi` 在 iOS 无企业/教育类目限制,且支持返回 BSSID。
- 届时只需把小程序的 `wx.login`/openid 绑定替换为飞书 `tt.login`/open_id 绑定,业务逻辑(围栏、去重、签到表)不变。
