# apps/api/vendor

## pdfkit-deps.tgz 是什么

成绩单 PDF 生成所需的 **pdfkit 依赖闭包**（77 个包，压缩后约 2.3 MB）。

### 为什么不用 pnpm 装

部署形态是 **tar 包 + systemd 蓝绿**，服务器 `/opt/acms/repo` 不是 git 仓库、也没有随部署同步
`package.json` / `pnpm-lock.yaml`。在生产上直接跑 `pnpm install` 时 pnpm 判定需要**重建整个
node_modules**（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR`）—— 两个 slot 共用同一份 node_modules，
重建期间一旦失败就是全站不可用。为加一个 PDF 库承担这个风险不划算。

所以改成：**把依赖闭包直接打进 api 的 tar**，解压后落在 `<slot>/node_modules/`。

### 为什么这样是安全的

- Node 解析 `dist-3001/exam-grade/exam-grade.pdf.js` 里的 `require('pdfkit')` 时，
  依次找 `exam-grade/node_modules` → `dist-3001/node_modules` → …，命中的就是这份。
- 它**只属于这个 slot**，优先级最高、不覆盖 `apps/api/node_modules` 或仓库根 node_modules，
  因此对其他代码零影响（这也是没有直接塞进 `apps/api/node_modules` 的原因）。
- 与 `pnpm install` 的结果等价：本地开发走正常 pnpm 解析，生产走这一份，两边都是 pdfkit@0.15.1。

### 怎么重新生成

```bash
mkdir -p /tmp/vendor/node_modules && cd /tmp/vendor
npm install pdfkit@0.15.1 --no-package-lock      # 拉平安装，得到闭包
# 递归收集 pdfkit 的 dependencies 闭包 → 拷进 node_modules/
tar czf pdfkit-deps.tgz node_modules
```

升级 pdfkit 时记得同步 `apps/api/package.json` 的版本号并重做这个包。

### 消费方

`scripts/build_tars.sh` 会把它解压到 `apps/api/dist/node_modules/`，随 tar 一起上线。
