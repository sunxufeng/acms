# ACMS 任务归档

> 时间跨度：2026-08-25 ~ 2026-09-14（21 个工作日）· 共 **515 条**（已完成 513 · 待处理 2）
>
> ⚠️ 本文件是**执行过程**的归档（含"构建部署验证"这类操作性任务），用于回溯"做过什么"。
> **项目计划**（要做什么、优先级、状态）见仓库根目录 [`PLAN.md`](../PLAN.md)。
>
> 由 AI 助手在每次工作后同步；`[x]` = 已完成，`[ ]` = 待处理。

## 2026-09-14（26 条，完成 25）

- [x] 后端 contact-dedup 接口
- [x] 前端去重报表组件 + 注册
- [x] i18n 文案 + lint
- [x] 构建部署 + 线上验证 + push
- [x] 调研现有报表/考勤代码结构
- [x] 后端：出勤率报表接口 GET /reports/attendance
- [x] 后端：考勤终态审核字段与接口
- [x] 前端：报表面板 attendance.tsx + reports/page.tsx 接线
- [x] 前端：考勤列表页审核动作
- [x] 验证：typecheck + 真实数据自测 + 清理
- [x] 实现作业↔成绩册联动的后端逻辑
- [x] 接入 controller 与网格完成率
- [x] 实现前端作业同步面板组件
- [x] typecheck 与生产链路自测
- [x] 把作业同步面板接进成绩册页
- [x] 补 50 条缺失 i18n 文案
- [x] 构建部署 + 线上验证三块新功能
- [ ] 提交推送 + 同步 PLAN.md 与任务归档
- [x] 全站排查菜单入口权限口径（13 角色 × 70 菜单，前端可见性复算 + 接口 200/403 对照）
- [x] domain：`module:*:read` 蕴含 `module:*:enter` 规范化（修 9 个角色「有权限看不到菜单」）
- [x] contracts：菜单 key 别名表 MENU_KEY_ALIASES + moduleByMenuKey，合并重复的部门管理资源
- [x] 数据侧：「教务」补 module:adjustments:read（GET /adjustments 403 → 200）
- [x] 构建部署 114 + 生产验证（A/B 两类归零）+ push GitHub
- [x] 部门同步接口收权限：`POST /departments/sync` 补 `module:departmentManagement:update`（原仅登录校验）
- [x] 前端部门页「同步」按钮按权限门控（无权限不渲染，避免点了 403）
- [x] 构建部署 + 生产验证（管理员 201 / 教师本人·Phase1·student·教务 403）+ push GitHub

## 2026-09-13（20 条，完成 19）

- [x] 数据层：注册新表 + 权限 + 菜单
- [x] 考勤：考勤码配置 + 终态结算 + 出勤率报表
- [x] 成绩册：等级体系 + 列/条目二维 + 加权汇总 + 目标
- [x] 行为记录：记录/跟进 + 类型配置 + 阈值告警 + 家长通知
- [x] 课程规划与备课：单元/块/成果 + 课时 + 部署复用
- [x] 作业：布置 + 提交/迟交 + 完成打勾 + 成绩册联动
- [ ] 门户：家长多子女 + 学生自助 + 可见性查询层过滤
- [x] 质量门 + 部署 + 端到端验证
- [x] 提交并部署教学域地基（7 文件）
- [x] 部门管理 UI 统一 + 显示公司层 + 点击看部门员工
- [x] markbook 成绩册模块（加权汇总 + 二维录入）
- [x] curriculum 课程规划模块（单元部署 + 作业提交）
- [x] behaviour 行为记录模块（告警重算 + 信件）
- [x] 构建部署 + 线上验证 + push GitHub
- [x] 编写后端 curriculum.meta.ts（全部 RecordMeta）
- [x] 编写 curriculum.service.ts（部署/覆盖率/迟交核算）
- [x] 编写 curriculum.controller.ts 与 curriculum.module.ts
- [x] 追加 apps/web/lib/api.ts 的接口方法
- [x] 编写前端页面（curriculum / learning-outcomes / lesson-plans）
- [x] 跑 typecheck 并修到通过

## 2026-09-12（24 条，完成 24）

- [x] 后端：listDeep 支持字段时间区间 / 自定义字段 / 跟进人下钻
- [x] 后端：analyze 输出下钻所需的原始键值与区间
- [x] 前端：CrudPage 支持 URL 参数初始化筛选
- [x] 前端：重写报表下钻链接并给联系人页加下钻提示
- [x] 构建、部署、线上验证、推送
- [x] 后端：学生列表筛选补「升学导师」「是否是新生」
- [x] 前端：图表基元支持点击（BarRow / MetricCard / SimpleTable）
- [x] 前端：学生结构概览与年级升级流向接入下钻
- [x] 前端：学生列表支持 URL 参数初始化筛选与下钻提示
- [x] 后端：招生跟进新增「关联联系人」link 字段
- [x] 前端：CrudPage 新增 weilingContact 字段类型
- [x] 前端：招生跟进列表/表单/详情改用联系人
- [x] 契约层：注册 6 张 AI 路由表 + 权限点 + 菜单组
- [x] 后端：AI 路由模块（建表 + CRUD + 密钥/凭证/路由核心逻辑）
- [x] 后端：网关转发（/v1/* + SSE + 计费 + Redis 限流 + 健康检查）
- [x] 前端：AI 路由 6 个页面
- [x] 部署与验证：NPM 加 /v1 路由 + 建表 + 端到端验证
- [x] 数据层：上游账号新增 14 个字段 + 字典扩充
- [x] CrudPage 通用能力：批量操作栏、列显示设置、自动刷新
- [x] 后端：账号额度 / 临时不可调度规则 / 模型映射 / 今日统计 / 调度状态
- [x] 网关：额度校验 + 规则摘除 + 映射生效 + 上游ID记录
- [x] 前端：上游账号列表页补齐（批量/筛选/列/行操作）
- [x] 前端：上游账号表单补齐（卡片/模型限制/规则/快捷）
- [x] 部署与验证

## 2026-09-11（6 条，完成 6）

- [x] 摸清 note-convert 与部门数据源
- [x] 开发系统监控模块（后端接口 + 页面 + 菜单）
- [x] 开发登录日志 + 活跃时段统计报表
- [x] 后端：卫瓴联系人同步与只读接口
- [x] 前端：招生管理菜单组 + 联系人管理页面
- [x] 联系人与 ACMS 学生档案关联

## 2026-09-10（33 条，完成 33）

- [x] 确认并补齐 PG 审计列（79 张表）
- [x] DataStore/BaseClient 接口支持 actor 透传
- [x] 通用 CRUD 与业务 service 传递操作人
- [x] 读取注入四个审计值 + 创建人对象解析
- [x] 历史数据回填
- [x] 质量门 + 部署 + 推送
- [x] main.ts 启用 graceful shutdown
- [x] next.config 支持 NEXT_DIST_DIR 环境变量
- [x] 新增 systemd 实例化模板
- [x] 重写 deploy_prod.sh 为 blue-green
- [x] 生成 nginx blue-green 站点配置
- [x] 本地 typecheck + build 验证
- [x] 远程部署并首次零停机切换
- [x] 零停机验证 + commit/push
- [x] 后端：飞书部门读取客户端
- [x] 后端：DepartmentModule/Controller/Service
- [x] 前端：部门管理树形页 + 同步按钮
- [x] 菜单与权限登记
- [x] 构建校验 + 部署确认
- [x] 后端：飞书部门读取客户端 listDepartments
- [x] 构建校验 + 部署确认
- [x] 前端：部门树形只读页 + 同步按钮
- [x] 契约：菜单/权限/表注册
- [x] 后端：DepartmentModule/Controller/Service
- [x] 飞书 client 新增 listDepartments()
- [x] 部门管理后端模块（Service/Controller/Module）
- [x] 契约注册：表/菜单/权限
- [x] 前端部门树形只读页 + 同步按钮
- [x] 构建校验（typecheck/build/i18n lint）
- [x] 提交部门管理 + web@service 修复
- [x] push GitHub（API 通道，剥代理）
- [x] 构建并部署生产 114
- [x] 生产验证 + 飞书 IM + 记忆

## 2026-09-09（65 条，完成 65）

- [x] 新增共享 requireModule 模块鉴权助手
- [x] 财务域 service 接模块鉴权
- [x] AI 域（ai* + ai-summarize）接模块鉴权
- [x] 构建+类型检查+部署验证+提交推送
- [x] 教师/考勤/排课/教学 service 接模块鉴权
- [x] 通知 service 接模块鉴权
- [x] Stage 4b 字段密级表自动脱敏
- [x] 重建 dict.data.ts 的 FIELD_LEVELS 种子（对齐真实字段名）
- [x] 补全 dict.service.ts 字段密级运行时读写
- [x] 补全 generic-crud.module.ts 脱敏接入
- [x] 补全 student.service.ts 与 student-360.service.ts 脱敏接入
- [x] 接入 teacher/billing/partnership 三个 service 脱敏
- [x] 字段密级字典 API 暴露（GET/PUT /dictionaries/field-levels）
- [x] 质量门 + 构建 + 部署 114 + 冒烟验证 + 推送
- [x] 重建 FIELD_LEVELS 种子（对齐真实字段名）
- [x] dict.service.ts 字段密级运行时读写
- [x] student/student-360 脱敏接入
- [x] teacher/billing/partnership 脱敏接入
- [x] generic-crud.module.ts 脱敏接入
- [x] 质量门+构建+部署114+冒烟+推送
- [x] 字段密级字典 API 暴露
- [x] 重建 FIELD_LEVELS 种子（对齐真实字段名）
- [x] 补全 DictService 字段密级运行时读写
- [x] 补全 generic-crud 基类脱敏
- [x] 暴露字段密级字典 API
- [x] 接入 teacher/billing/partnership 脱敏
- [x] 接入 student / student-360 脱敏
- [x] 质量门 + 构建 + 部署 114 + 冒烟 + 推送
- [x] #1 修复 UserForm 存 label 问题
- [x] #2 修复 user.service 静态 ROLES 校验
- [x] 质量门+构建+部署114+验证+推送
- [x] #3-#7 显示侧 key→label 映射
- [x] A1 权限页权限点接 PERMISSION_LABELS
- [x] A2 全局 dataLevelLabel + 权限页密级显示
- [x] A3 导出 CSV 系统角色列接 getRoleLabels
- [x] A4 AI 总结角色/密级字段解析
- [x] A类质量门+构建+部署114+推送+验证
- [x] B3 dict.controller.ts：labels 兼容 + meta 端点
- [x] B2 dict.service.ts：store/resolve + 飞书按 id 重命名
- [x] B1 dict.data.ts：DictOption 模型 + FIELD_DICTKEY
- [x] B7 质量门：typecheck + build
- [x] B6 导出/AI 字典字段解析
- [x] B5 CrudPage 显示解析（改名后旧值→当前名）
- [x] B8 部署 114 + 推送 GitHub（需确认）
- [x] B4 前端：api.ts + DictionariesPage 编辑器 aliases
- [x] 质量门：typecheck + build + 收尾确认
- [x] T1 云文档 docx 内化 ACMS
- [x] T4(b) 退役飞书 Base 字段选项 syncToBase
- [x] T2 云盘 Drive 附件内化 ACMS
- [x] 后端：Get笔记请求加全局限流与 10202 退避重试
- [x] 前端：凭证加载失败不再静默卡「加载中」
- [x] 同步遇限流时保留已处理的部分结果
- [x] 修复：启动期权限配置读取失败导致自定义角色授权静默失效
- [x] 核实 Amy 的 Get笔记账号归属
- [x] 诊断并修复系统管理员打开「我的笔记」很慢
- [x] 修复邮件收取报错「失败：Command failed」
- [x] 将存量飞书附件迁移到 ACMS 本地存储
- [x] 修复 P0：IMAP 未处理 error 事件导致 API 进程崩溃重启
- [x] 为 main.ts 加全局异常兜底日志
- [x] 笔记快照持久化到 Redis，消除重启后冷启动
- [x] 复验存量附件是否残留非 loc_ token
- [x] syncRoleOptionsToFeishu 改名为 syncRoleOptions
- [x] 清理 uploadToFeishu 死代码与 bitablePerm 兼容回退
- [x] 新增应急管理员本地登录入口
- [x] 质量门：typecheck + build 并汇报待确认

## 2026-09-08（25 条，完成 25）

- [x] 实证验证 bitablePerm 下载链路
- [x] 实现 B 架构修复（代码层）
- [x] 部署并验证自定义 logo 显示
- [x] 注册「报表管理」菜单组与菜单项
- [x] 实现报表首页与 4 张学生报表
- [x] 构建部署并验证报表数据
- [x] 新增 report:read 独立权限点
- [x] 新增报表专用后端聚合接口
- [x] 给现有角色补发 report:read，修复权限授权页白名单
- [x] 修复登录角色白名单滤掉自定义角色（曹德强 403）
- [x] 修复 ABAC 行过滤后 total 失真（丁懿 82/0）+ campuses 崩溃兜底
- [x] 业务菜单补权限点 + 菜单自愈回填 perm/adminOnly
- [x] 部署验证三个修复
- [x] 新增菜单级权限点并绑定菜单
- [x] 阶段1：学生全景区块权限过滤
- [x] 阶段2：模块级动作权限点（delete/export/import）
- [x] 阶段3：CrudPage 标准工具栏统一内置
- [x] 阶段4：角色管理页操作矩阵 + 全选能力
- [x] 核对菜单、服务权限与迁移接口
- [x] 实现模块权限目录与版本化角色迁移
- [x] 验证构建、迁移幂等与撤权重启
- [x] 模块权限：补 import 动作 + genericCrud 标记
- [x] CrudPage 导入按钮自动接线
- [x] 角色管理操作矩阵（module×action）
- [x] 构建 + 部署 114 + 验证 + 提交推送

## 2026-09-07（29 条，完成 29）

- [x] 建表脚本 + 生产建表拿 tableId
- [x] contracts 注册 noteConfigMap
- [x] 后端：processNote 落映射 + config-map 接口
- [x] 回填脚本（配置凭证 → 唯一配置）
- [x] commit + 推送 GitHub
- [x] 前端：配置名称列 + 筛选
- [x] 质量门 + 部署 114 + 线上验证
- [x] 写加字段脚本并在生产加「归属人/归属人ID」
- [x] 写回填脚本并在生产回填现有数据归属
- [x] 后端：source-cred.ts + 管理员聚合 + 60秒快照分页
- [x] SourcesService 写归属 + 列表/详情/更新按人隔离
- [x] GetnoteService.listConfigMap 按归属过滤并修重复覆盖
- [x] 前端：管理员可见的「归属人」列 + contracts 类型
- [x] 质量门：contracts 编译 + typecheck + i18n lint + 构建
- [x] 部署生产 114 并端到端验证
- [x] commit 并推送 GitHub，核对三处一致
- [x] P0-1：修复节流失效（日期字段读成字符串）
- [x] P0-2：下载前先查重，命中就跳过
- [x] P1-1：附件并发上传 + 失败快速失败
- [x] P1-2：loadExistingUids 分页 pageSize 100 → 500
- [x] P2-1：加各阶段耗时埋点
- [x] P2-2：清理重复归档记录（先 dry-run 给用户看）
- [x] 质量门 + 部署生产 + 推送 GitHub
- [x] 阶段0：生产全表摸底（结构+行数）
- [x] 阶段1：接口化 + SqlStore 骨架 + 路由
- [x] 阶段2：全量迁移脚本（导出→建表→导入→校验）
- [x] 阶段3：双写与影子写（已开启）
- [x] 阶段4：全量切读（已完成并验证）
- [x] 阶段5：下线飞书写入（待关闭影子写）

## 2026-09-06（28 条，完成 28）

- [x] 补齐 api 全量构建
- [x] 打包并部署到 114 生产
- [x] 线上验证原始记录框
- [x] 提交 commit 并推送 GitHub
- [x] contracts 加转换配置类型与菜单项
- [x] 后端加 note-convert 读写接口
- [x] 前端 api 与两个 lib 模块
- [x] CrudPage 支持通用预填
- [x] getnote 页面加转换按钮
- [x] 新建转换配置页面
- [x] i18n 文案与质量门
- [x] 打包并部署到 114 生产
- [x] 线上验证转换链路
- [x] 提交 commit 并推送 GitHub
- [x] 建飞书表「笔记转换记录」
- [x] 后端转换记录读写接口
- [x] 留痕展示：弹窗 + 列表行
- [x] 前端改造：去掉标签改记记录
- [x] CrudPage 保存后回填目标记录ID
- [x] i18n 与质量门
- [x] 部署 114 并验证推送
- [x] 建表脚本与字典种子
- [x] contracts 注册：表 ID / 菜单 / 转换映射
- [x] 后端：RecordMeta + AI 摘要 + 学生360 + 字典同步
- [x] 前端：学生观察三页 + api + AI 面板
- [x] 质量门：typecheck + i18n lint + 全量构建
- [x] 建表 + 部署 114 + 线上验证（需确认）
- [x] 提交 commit + 推送 GitHub（需确认）

## 2026-09-05（38 条，完成 38）

- [x] 后端 getnote 模块（含 int64 安全解析）
- [x] 建飞书 noteLinks 映射表 + 配置
- [x] 后端 links 接口 + NotePanel 组件
- [x] 挂载 11 个详情页 + 家校沟通存为笔记
- [x] 后端：凭证加密模块 + service/controller 改造为 per-user
- [x] 飞书：用户表加「笔记API Key」字段，noteLink 表加「关联人ID」
- [x] 前端：/getnote 加 Key 设置区 + NotePanel 标注归属
- [x] 后端：OAuth 设备授权 start/poll 接口
- [x] 前端：NotePanel 提示调整 + i18n 对称补齐
- [x] 前端：/getnote 三态 + 一键授权弹窗
- [x] 校验 + 构建 + 部署 + 推送
- [x] 后端：credential 加 clientId + API 错误码结构化解析
- [x] scheduler 复用现有 croner
- [x] 字典新增两个 key
- [x] 前端 /getnote/sources 配置页
- [x] 前端 /getnote 升级
- [x] 本地构建验证
- [x] 新建飞书表 getnote_source
- [x] 部署生产（待确认）
- [x] 推送 GitHub（待确认）
- [x] scheduler 自动同步
- [x] 后端 getnote-source 模块
- [x] 修复菜单高亮：/getnote/sources 和 /getnote 同时被选中
- [x] 排查知识库配置列表不显示已配置的记录
- [x] 知识库配置表单：API Key/Client ID 输入框分两行并加长
- [x] 历史笔记来源字段更新为「得到大脑」
- [x] 移除我的笔记页面上方的凭证配置信息条
- [x] 我的笔记页面标题改为「我的笔记」
- [x] base-adapter 单选/多选写入格式修复
- [x] 后端新增免id测试连通性接口
- [x] CrudPage 增加 formExtraActions
- [x] 前端接线测试连接按钮
- [x] 构建+部署114+推GitHub
- [x] 后端 detail 暴露 rawRecord
- [x] CrudPage 支持 readonly 与 enrichEditRow
- [x] 前端 getnote 页面 2-tab 详情 + 表单 2 字段
- [x] i18n 文案 + lint
- [x] 构建+部署114+验证+推送

## 2026-09-04（6 条，完成 6）

- [x] 修改 CrudPage.tsx 5 处渲染点包 tl()
- [x] 补 9 条 hint 中英译文
- [x] 补 188 个字典值中英译文
- [x] 校验：typecheck + i18n lint + 覆盖率复测
- [x] 部署到 114 生产
- [x] 推送 GitHub

## 2026-09-03（11 条，完成 11）

- [x] 改造 FloatingAIPanel.tsx（ai.chat，7 处）
- [x] 改造 AiSummarizeModal.tsx（homeSchool，5 处）
- [x] 改造 AppShell.tsx（nav + common，3 处）
- [x] 改造 home-school-comms/page.tsx 与 [id]/page.tsx（homeSchool，4 处）
- [x] 改造 AutomationForm.tsx（ai.automations，2 处）
- [x] 改造 TagInput.tsx（common，1 处）并裁决 AgentForm / aiContext
- [x] 输出并校验片段文件 g5.json
- [x] 改造校友跟进模块（alumni 命名空间）
- [x] 改造学生考勤/日常跟进/生源跟进（students 命名空间）
- [x] 改造 SessionForm / BalanceWheel / export 页
- [x] 输出并校验片段文件 g7.json

## 2026-09-02（12 条，完成 12）

- [x] 补 zh.json 7 条自映射彻底消音
- [x] PAT 写入 osxkeychain 打通 git push
- [x] 固化两个验证坑到技能
- [x] 全站列表分页格式检查报告（只报告不改）
- [x] 学生档案筛选标签改名（招生/来源/生源）
- [x] 抽公共 Pagination 组件并接入两处列表
- [x] 构建部署生产并 push GitHub
- [x] T1 抽公共 hook useTl，替换 40+ 处内联定义
- [x] T2 (P2-a) 字段名渲染点包 tl，57 处 / 16 文件
- [x] T3 (P2-c) 字典选项值双语：渲染点包 tl + 补 ~250 条译文
- [x] T4 (P2-b) 纯 UI 文案抽 key，231 处 / 170 条 / 42 文件
- [x] T5 验证闭环：typecheck → lint → 构建 → 部署 → 验收 → push

## 2026-09-01（20 条，完成 20）

- [x] 提交 config UI 对齐改动到 git
- [x] 构建并部署到生产 114
- [x] 推送 commit 到 GitHub
- [x] 升级 MarkdownField 为统一 md 编辑器
- [x] 补 .md 样式：h1/h2/table/任务列表/删除线
- [x] AgentForm 与 SkillForm 换成 MarkdownField
- [x] 清理 md-* 死样式与冗余 i18n 键 + lint/build
- [x] 提交 md 编辑器统一改动
- [x] globals.css 补移动端三个类
- [x] 新建共享组件 MobileBindCard
- [x] messages 新增 bind 命名空间（zh/en 各 26 键）
- [x] 改造 /student-login 与 /parent
- [x] 校验：i18n lint + build + 硬编码残留复查
- [x] 改 dict.data.ts 字典种子
- [x] 改 dict.service.ts 同步映射
- [x] 改学生档案班级字段引用
- [x] 飞书 Base 生产表结构变更
- [x] 导入 82 条最新学生数据
- [x] 清理旧数据
- [x] 构建验证 + 上线

## 2026-08-31（8 条，完成 8）

- [x] 移除 debug 日志并修 99992402 检索
- [x] 排查新邮件账号收不到邮件
- [x] 清理 /tmp 诊断脚本并 commit 修复
- [x] 实现邮件归档筛选下拉动态候选项
- [x] 排查并修复 kevinding 收取"新增 0 封"
- [x] 构建部署并推送 git
- [x] 排查 Kevin Ding 邮箱同步遗漏（187 vs 15）
- [x] 排查并修复生产邮件账户页面 504 超时

## 2026-08-30（5 条，完成 5）

- [x] 生产归档表加「关联学生」关联字段
- [x] 后端新增关联/解除关联接口
- [x] 前端邮件关联学生 UI（列表/详情）
- [x] 学生档案页展示相关邮件
- [x] 构建部署 114 并验证

## 2026-08-29（33 条，完成 33）

- [x] 给 mail-accounts 补 standaloneForm
- [x] Lint 与构建验证
- [x] 部署到 114 服务器并验证
- [x] 推送 GitHub
- [x] 给 attendance-zones 补 standaloneForm
- [x] Lint 与构建验证
- [x] 部署 114 并验证
- [x] 推送 GitHub
- [x] 给 venues 补 inlineEdit + standaloneForm
- [x] Lint 与构建验证
- [x] 部署 114 并验证
- [x] 推送 GitHub
- [x] 给 CrudPage 加自定义表单插槽 renderForm
- [x] 排课改造为 URL 不变的独立表单页
- [x] Lint 与构建验证
- [x] 部署 114 并验证
- [x] 推送 GitHub
- [x] AI 技能改造为 URL 不变的独立表单页
- [x] Lint 与构建验证
- [x] 部署 114 并验证
- [x] AI 配置改造为 URL 不变的独立表单页
- [x] AI 自动化改造为 URL 不变的独立表单页
- [x] IDP 方案改造为 URL 不变的独立表单页
- [x] 学生管理改造为 URL 不变的独立表单页
- [x] 构建、部署并推送
- [x] 修同步结果写不回的 bug（A）
- [x] 发件箱：账户可配 + 探测兜底（B）
- [x] 附件可靠化：原生附件字段 + 可下载（C）
- [x] 收发区分：邮件方向字段 + 徽标列（D）
- [x] 写幂等补字段脚本
- [x] 构建、部署并验证
- [x] 重建邮件归档表（修正 6 个错误字段类型）
- [x] 补录 18 条缺失附件的归档邮件

## 2026-08-28（68 条，完成 68）

- [x] 搭建 next-intl i18n 框架（无路由 Cookie 模式）
- [x] AppShell 顶栏增加语言切换器
- [x] 翻译导航栏与登录页（P0 通用词）
- [x] 翻译 AI 模块页面（P1）
- [x] 构建部署并验证中英切换
- [x] 阶段1: 生产 Base 建两张邮件表
- [x] 阶段2: 配置生产 .env 映射与密钥
- [x] 阶段3: 生产 API 安装邮件依赖
- [x] 阶段4: 部署合并代码到 114
- [x] 阶段5: 验证生产邮件功能
- [x] 补录邮件权限到角色配置
- [x] 扩展菜单数据模型支持 enLabel
- [x] 后端默认分组带 enLabel 并本地类型检查
- [x] 菜单管理/分组配置页加英文输入框
- [x] 更新 AppShell 渲染中英文回退
- [x] AppShell 从菜单分组配置读取分组
- [x] 后端 getMenu/getMenuGroups 自愈 enLabel
- [x] 脚本持久化生产菜单英文到配置表
- [x] 建立 common 公共词库命名空间
- [x] 逐模块国际化页面(并行子代理)
- [x] 合并 key 并本地构建验证
- [x] 确认部署114与推送GitHub
- [x] Internationalize courses & teaching-classes pages
- [x] Internationalize schedule pages (list/new/precheck/edit)
- [x] Internationalize grades pages (list/columns/detail)
- [x] Internationalize practice-activities pages
- [x] Internationalize stage-evaluations pages
- [x] Write sidecar JSON
- [x] Internationalize teachers/page.tsx
- [x] Internationalize attendance/page.tsx
- [x] Internationalize partnerships/page.tsx
- [x] Internationalize billing/page.tsx
- [x] Internationalize settlements/page.tsx
- [x] Internationalize adjustments/page.tsx
- [x] Internationalize venues/page.tsx
- [x] Write i18n keys sidecar JSON
- [x] Internationalize students new/edit/detail pages
- [x] Internationalize students/page.tsx
- [x] Internationalize student-attendances (page, columns, detail)
- [x] Internationalize student-login + parent pages
- [x] Internationalize alumni-followups (page, columns, detail)
- [x] Internationalize student-360/page.tsx
- [x] Write sidecar JSON
- [x] Internationalize portal/page.tsx
- [x] Internationalize StudentForm.tsx
- [x] Internationalize student-users/page.tsx
- [x] Audit target files for i18n status
- [x] Replace hardcoded strings with t() calls
- [x] Write sidecar i18n_keys_students.json
- [x] Internationalize role-management, permissions, users pages
- [x] Internationalize menu-settings and menu-groups-settings
- [x] Internationalize dictionaries and notifications pages
- [x] Internationalize settings, audit-logs, export, wechat-bindings, attendance-zones
- [x] Internationalize homepage-management and homepage-settings
- [x] Write sidecar i18n_keys_admin.json
- [x] 自动转换9个自定义页的中文UI串为tl()
- [x] 人工核对diff并补齐labels字典新词
- [x] 类型检查+构建+部署+推送
- [x] 加 tl 防坏串回退保护
- [x] 部署 114 生产环境
- [x] 确认 layout force-dynamic 改动现状
- [x] 全量补全 labels 命名空间
- [x] 本地 tsc + next build 验证
- [x] 修正英文 label 误用 tl
- [x] 部署 114 + 推送 GitHub
- [x] 本地重建并验证
- [x] 打磨英文文案占位值
- [x] 加构建期 lint 防回归

## 2026-08-27（41 条，完成 41）

- [x] 调研登录授权 scope 与飞书应用云盘权限
- [x] feishu client 新增云盘 list/move API
- [x] 新增 feishuDrive 工具并注册到 agent
- [x] 登录流程持久化 user_access_token + 请求 drive scope
- [x] 构建部署验证 Drive 工具
- [x] 类型检查 @acms/api 和 @acms/web
- [x] 构建 monorepo
- [x] 打包产物
- [x] 部署到生产服务器
- [x] 验证部署
- [x] 构建部署并验证
- [x] 新增学生档案查询 AI 工具 (B)
- [x] 调研并列出飞书工具清单与推荐
- [x] 激活飞书云盘 scope 并重启生产服务
- [x] 扩展飞书 scope 覆盖日历/任务
- [x] 新增飞书扩展 AI 工具（消息/通讯录/日历/多维表格/任务）
- [x] 构建部署并验证飞书扩展工具
- [x] 类型检查 @acms/api 与 @acms/web
- [x] 构建 monorepo
- [x] 打包 tars
- [x] 部署到生产
- [x] 部署后验证
- [x] 本地构建 pnpm build
- [x] 打包构建产物 build_tars.sh
- [x] 部署到生产服务器
- [x] 推送代码到 GitHub
- [x] routeChat 校验与降级
- [x] build_tars 排除数据目录
- [x] 生产环境数据目录迁移
- [x] 构建部署并推送
- [x] 修复 copyDriveFile 缺少 name 参数
- [x] 对话消息添加修改和复制功能
- [x] 进行中会话加终止按钮 + 添加本地文件参考功能
- [x] 构建部署并推送到 GitHub
- [x] 诊断飞书复制接口缺 name 原因
- [x] Add MD/Preview tabs + MD Import to skill edit form
- [x] Enrich agent create/edit form with tabbed sections
- [x] Optimize agent list page with table layout and actions
- [x] Add chat history search + sidebar collapse toggle
- [x] Rewrite agent form with clean layout, defaults, and proper structure
- [x] Redesign AgentForm UI to match reference style

## 2026-08-26（13 条，完成 13）

- [x] base.provider 增加 TABLE_ID_MAP 运行时表ID映射
- [x] 构建部署 API 并配置 TABLE_ID_MAP
- [x] 验证生产登录链路
- [x] Sanitize deploy_prod.sh (remove hardcoded password)
- [x] Convert next.config.ts to next.config.mjs in repo
- [x] Commit and push to GitHub main
- [x] Sync production server to GitHub code and redeploy
- [x] 构建/部署/验证/提交
- [x] Web: 角色管理页面 + API 客户端 + 菜单
- [x] Domain: 让角色权限矩阵可被配置覆盖
- [x] API: RoleManagement 模块
- [x] Contracts: 角色与权限类型 + 标签
- [x] Fix phase1 role not visible in Feishu options + login logo not displaying

## 2026-08-25（4 条，完成 4）

- [x] 更新记忆文件（生产环境信息+中文沟通偏好）
- [x] 安装依赖并构建项目
- [x] 探查生产服务器环境
- [x] 部署到生产服务器

