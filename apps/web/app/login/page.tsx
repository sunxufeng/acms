import { DEFAULT_HOMEPAGE_CONFIG, type HomepageConfig } from '@acms/contracts';
import LoginShell from './LoginShell';

/** 服务端组件：在 SSR 阶段直接读取首页配置，避免客户端二次渲染导致闪屏（FOUC）。
 *  认证状态检查保留在 LoginShell 内部用 useEffect 执行（依赖 cookie，必须客户端跑）。 */
export default async function LoginPage() {
  let config: HomepageConfig = DEFAULT_HOMEPAGE_CONFIG;

  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL || ''}/api/v1/homepage-config`, {
      cache: 'no-store',
      headers: { cookie: '' }, // 服务端请求不携带用户 cookie
    });
    if (res.ok) {
      const data = await res.json();
      if (data) config = { ...DEFAULT_HOMEPAGE_CONFIG, ...data };
    }
  } catch {
    // 接口不可用时使用默认配置
  }

  return <LoginShell config={config} />;
}
