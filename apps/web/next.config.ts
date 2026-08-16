import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
