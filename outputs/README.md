# outputs/ —— ACMS 设计稿与上线前后证据

这个目录放 ACMS 的设计方案、原型、改版说明与上线前后的截图（交付时产出的附件）。
**产品代码不在这里**（在 `apps/`、`packages/`）。

## 🔴 入库政策：只收「不含真实数据」的文件

⚠️ **本仓库是 public。** 而 ACMS 的真实学生是**未成年人** —— 学生姓名 / 家长手机号 /
联系人昵称一旦推上去就是公开可检索的合规事故，而且 **git 历史删不干净**（`git rm` 只是不再出现在
最新树里，历史里那份还在，只能 rewrite history + force push，代价很大）。

所以本目录的收录口径是：

1. 设计稿里的示例数据必须是**编的**（`学生甲` / `示例学生` / `138****0000`），不是从生产库抄的；
2. 截图**不能出现**真实姓名、学号、手机号、联系人昵称、组织架构实名；
3. 提交前跑一次自检：

```bash
# ① 结构性特征（邮箱 / 手机号 / openId / 学籍号值 / token / 内网 IP）
node scripts/outputs_pii_lint.mjs

# ② 连真实姓名一起查（姓名清单本身是 PII ⇒ 不进仓库，放本地）
ACMS_NAME_LIST=~/.acms-names.txt node scripts/outputs_pii_lint.mjs
```

`scripts/outputs_pii_lint.mjs` 扫的是**已被 git 跟踪**的文件 ——
本地留着的"待脱敏 / 待确认"文件不会误报，只有真要提交时才会拦你。

> 名字清单怎么拉（生产库，只读）：
> ```bash
> psql -A -t -c "SELECT coalesce(data->>'学生姓名','') FROM t_tbl2pevecjhnm8la WHERE coalesce(data->>'学生姓名','')<>''" > ~/.acms-names.txt
> psql -A -t -c "SELECT coalesce(data->>'姓名','')     FROM t_tbltv6vao5x2967y WHERE coalesce(data->>'姓名','')<>''"     >> ~/.acms-names.txt
> ```

## 已收录（2026-10-03，已过自检）

| 文件 | 说明 |
|---|---|
| `acms-会议纪要表单改版方案.md` | 会议纪要表单改版方案 |
| `acms-学生记录合并设计方案.md` | 学生记录三合一的合并设计 |
| `teaching-dictionary-map.html` | 教学域字典映射图 |
| `teaching-gradebook-guide.html` | 成绩册使用说明 |
| `weight-batch-ui-2026-09-20.html` | 成绩权重批次 UI |
| `student-records-idp-shipped.html` | 学生记录 · IDP 类型（上线版） |
| `student-records-idp-type-design.html` | 学生记录 · IDP 类型（设计稿） |
| `acms-records-v2-list.png` | 登录页截图（⚠️ 文件名与内容不符，实际是登录页） |

## 待处理（**未入库**，含真实数据）

统一先按「**脱敏成占位值**」处理（示例数据本来就该是编的），再走上面第 3 步自检。

**文本（14 个）**

| 文件 | 含什么 |
|---|---|
| `student-info-sync-2026-09-21.html` | 17 个真实学生姓名 + **3 个真实家长手机号**（最需要先处理） |
| `acms-IDP重构原型.html` | 7 个真实学生姓名 + 3 位教职工姓名 |
| `student-photos-import-2026-09-21.html` | 9 个真实学生姓名 |
| `acms-笔记录音可播性清单.md` | 7 位教职工姓名 |
| `acms-IDP重构设计方案.md` | 2 位教职工姓名 |
| `acms-学生记录与招生跟进改版方案.md` | 2 个真实学生姓名 |
| `markbook-*.html`（7 个）+ `exam-type-groups-2026-09-20.html` + `multisubject-column-design.html` | 示例表格里用的是真实学生姓名 |

**截图（22 张，未逐张核验）** —— 抽查 3 张的结果：

| 文件 | 结果 |
|---|---|
| `acms-dedup-caliber-hint.png` | ✗ 含真实联系人昵称 + 登录人姓名 |
| `acms-parent-portal-children.png` | ✗ 含真实学生姓名 + 学号 + 校区 |
| `acms-records-v2-list.png` | ✅ 登录页，已收录 |

⚠️ 截图**没法自动脱敏**（要改图）。下面的页面类型**默认视为含真实数据**，
要收录得先重新截一张用假数据的，或者就别收：

> 家长 / 学生门户、学生记录（列表/详情/表单）、联系人去重与下钻、
> 笔记列表与详情、会议纪要（参会人 / 部门树 / 表单）、成绩册与成绩目标、
> 招生跟进（生源跟进）、组织架构（部门树）
