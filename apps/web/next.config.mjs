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
