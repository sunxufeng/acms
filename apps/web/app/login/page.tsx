import { DEFAULT_HOMEPAGE_CONFIG, type HomepageConfig } from '@acms/contracts';
import LoginShell from './LoginShell';

/** 服务端组件：在 SSR 阶段直接读取首页配置，避免客户端二次渲染导致闪屏（FOUC）。
 *  认证状态检查保留在 LoginShell 内部用 useEffect 执行（依赖 cookie，必须客户端跑）。
 *  注意：服务端 fetch 必须用绝对地址；API_ORIGIN 与 next.config.mjs 的 rewrites 同源
 *  （默认 http://localhost:3000，api 与 web 同机部署），不能用相对路径（Node 下会抛异常）。 */
const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3000';

export default async function LoginPage() {
  let config: HomepageConfig = DEFAULT_HOMEPAGE_CONFIG;

  try {
    const res = await fetch(`${API_ORIGIN}/api/v1/homepage-config`, {
      cache: 'no-store',
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
