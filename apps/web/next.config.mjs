// ⚠️ 本文件是「构建期」配置（含 next-intl 插件）。
// 服务器只部署构建产物、不部署源码，而 next.config.mjs 也是 next start 的运行时配置，
// 因此另有一份「运行时」副本：scripts/deploy/next.config.prod.mjs（无 next-intl 依赖），
// 由 scripts/deploy_prod.sh 推送到服务器。改动本文件的 rewrites / headers / distDir 时，
// 请同步修改那份，否则会出现「构建用新配置、运行时用旧配置」的漂移。
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig = withNextIntl({
  // 平滑部署（Blue-Green）需要每个 web 实例独立的构建产物目录，避免两个实例的 .next 互相覆盖。
  // 默认 .next；部署时由 systemd 模板注入 NEXT_DIST_DIR=.next-<端口> 指向对应 slot 的目录。
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  async rewrites() {
    const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
});

export default nextConfig;
