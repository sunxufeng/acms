// ============================================================================
// 生产运行时 next.config（部署到服务器 /opt/acms/repo/apps/web/next.config.mjs）
// ----------------------------------------------------------------------------
// ⚠️ 为什么不能直接用 apps/web/next.config.mjs？
//   部署流水线**只推构建产物（.next 的 tar），不推源码**；但 next.config.mjs 是
//   `next start` 运行时要读的文件，属于必须单独同步的「运行时源码」。
//   本地版 import 了 `next-intl/plugin`，而服务器 node_modules **没装 next-intl**
//   （它只在构建期需要）。照搬本地版会让 `next start` 直接启不来。
//   ⇒ 这里维护一份「零新增运行时依赖」的等价配置。
//
// ⚠️ 为什么必须有 distDir？
//   Blue-Green 部署把构建解压到 .next-3101 / .next-3102，由 systemd 模板注入
//   NEXT_DIST_DIR=.next-<端口>。若配置里没有 distDir，next start 会永远走默认
//   .next（陈旧构建）⇒ 新页面 404、老页面正常、日志无任何报错。
//   2026-09-10 就踩了这个坑，生产整整跑了一天的陈旧构建。
//
// 修改本文件时，请同步比对 apps/web/next.config.mjs 的 rewrites / headers，
// 保证构建期与运行期行为一致。
// ============================================================================

const nextConfig = {
  // 每个 web 实例独立构建目录，避免两个 slot 的 .next 互相覆盖。
  // 由 systemd 模板 ExecStart 内联注入 NEXT_DIST_DIR=.next-<端口>；缺省回退 .next。
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  async rewrites() {
    const api = process.env.API_ORIGIN ?? "http://localhost:3000";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
