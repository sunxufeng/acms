# ACMS CLI / MCP

让 **Codex、终端、CI、脚本、WorkBuddy** 以「一个有权限的账号」的身份读写 ACMS ——
而不是把浏览器 Cookie 抠出来塞进脚本。

设计文档见 `outputs/ACMS-CLI-设计方案.md`（仓库外的工作目录）。

## 为什么是**零依赖、零构建**

这两个限制决定了整个形态：

1. **生产不能跑 `pnpm install`** —— 它会判定需要重建整个 `node_modules`
   （`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR`），而两个 slot 共用同一份，失败即全站不可用。
   （pdfkit 已经为此走过 `apps/api/vendor` 的内联方案。）
2. **Codex / 脚本宿主机不一定有依赖树**，也不一定允许联网装包。

所以这里**没有 `package.json`、没有构建步骤**，只有 3 个 `.mjs` 文件，
拷过去就能跑（要求 Node 22+，仓库 `engines` 本来就是这个要求）。

```
acms-client.mjs   共用的 HTTP 客户端（鉴权 / 分页 / 错误映射 / 退出码）
acms.mjs          CLI
acms-mcp.mjs      MCP server（stdio）
install.sh        安装脚本
```

## 安装

```bash
curl -fsSL https://acms.areteailab.com/cli/install.sh | sh
```

装完做三件事：

```bash
acms login --token acms-sk-…   # 令牌在 ACMS「后台管理 → 令牌管理」签发
acms doctor                    # 逐项自检（会把「为什么查不到数据」定位到具体环节）
acms schema                    # 看有哪些模块与字段
```

也可以完全不落盘（CI 场景）：

```bash
export ACMS_TOKEN=acms-sk-…
export ACMS_BASE_URL=https://acms.areteailab.com
acms whoami
```

环境变量**优先于** `~/.acms/config.json`。

## WorkBuddy / MCP 配置

```json
{
  "mcpServers": {
    "acms": {
      "command": "acms-mcp",
      "env": {
        "ACMS_BASE_URL": "https://acms.areteailab.com",
        "ACMS_TOKEN": "acms-sk-…"
      }
    }
  }
}
```

不写 `ACMS_TOKEN` 也行 —— 它会去读 `~/.acms/config.json`（先跑一次 `acms login`）。

暴露的工具：`acms_whoami` / `acms_schema` / `acms_list` / `acms_get` / `acms_report` / `acms_api`。
令牌为只读时，`acms_api` 只允许 GET。

## 命令

```
接入        login / logout / whoami / doctor
能力发现    schema [模块]
学生        student list|get|360
教学        markbook classes|grid · exam batches|term-grades|dist|report-card
其他        report <key> · api <METHOD> <路径>
通用选项    --json（机器可读）· --base <url> · --all（自动翻页）
```

`acms api` 是兜底：全站 300+ 端点，策展命令只覆盖高频的那部分。

## 退出码（脚本与 agent 靠它分支）

| 码 | 含义 | 该怎么办 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 业务错误（校验失败、找不到记录） | 看 message |
| 2 | 用法错误 | 修命令 |
| **3** | **认证失败**（令牌无效/过期/已吊销） | **换令牌** |
| **4** | **权限不足**（认证没问题，是没授权或被限制） | **换令牌没用，找管理员** |
| 5 | 网络 / 服务端错误 | 可重试 |

3 与 4 分开是刻意的：混在一起，使用者就会拿过期令牌去问管理员，
或者反过来拿一个权限不足的令牌反复重试。

## 更新分发文件

`scripts/build_tars.sh` 会把本目录的 `.mjs` 与 `install.sh`
复制到 `apps/web/public/cli/`，随 web 一起上线（不需要改 nginx）。

改了本目录的文件后，正常走一遍构建 + 部署即可。

## 注意

- 令牌是**长期凭证**：默认只读，有效期最长一年，可随时吊销。
- 「查到的数据比预期少」通常是**数据范围限制**（校区/年级），不是故障 ——
  `acms doctor` 会把范围说明打出来。
- Windows 下用 `node %USERPROFILE%\.local\share\acms\acms.mjs`，
  或直接在 Git Bash / WSL 里按上面的方式安装。
