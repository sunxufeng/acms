import { Provider } from '@nestjs/common';
import { BaseClient } from '@acms/base-adapter';

export const BASE_CLIENT = Symbol('BASE_CLIENT');

/**
 * 表 ID 运行时映射：代码内注册的表 ID（如 DEV Base）与目标 Base 实际表 ID 不同时，
 * 通过环境变量 TABLE_ID_MAP（JSON：代码表ID → 实际表ID）透明转换。
 * 未配置时原样返回，DEV 环境零影响。
 */
function withTableMap(client: BaseClient): BaseClient {
  const raw = process.env.TABLE_ID_MAP;
  if (!raw?.trim()) return client;
  let map: Record<string, string>;
  try {
    map = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error('TABLE_ID_MAP is not valid JSON');
  }
  if (Object.keys(map).length === 0) return client;
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      // 所有表级方法（search/get/create/update/delete/listFields...）第一参数均为 tableId
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0] in map) {
          args[0] = map[args[0]];
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export const baseClientProvider: Provider = {
  provide: BASE_CLIENT,
  useFactory: (): BaseClient =>
    withTableMap(
      new BaseClient(
        {
          appId: process.env.FEISHU_APP_ID ?? '',
          appSecret: process.env.FEISHU_APP_SECRET ?? '',
        },
        process.env.FEISHU_BASE_TOKEN ?? '',
      ),
    ),
};
