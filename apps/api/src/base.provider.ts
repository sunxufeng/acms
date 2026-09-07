import { Provider } from '@nestjs/common';
import { BaseClient, type DataStore } from '@acms/base-adapter';
import { SqlStore } from './sql-store/sql-store.js';
import { RoutingStore } from './sql-store/routing-store.js';

export const BASE_CLIENT = Symbol('BASE_CLIENT');

/**
 * 表 ID 运行时映射：代码内注册的表 ID（如 DEV Base）与目标 Base 实际表 ID 不同时，
 * 通过环境变量 TABLE_ID_MAP（JSON：代码表ID → 实际表ID）透明转换。
 * 未配置时原样返回，DEV 环境零影响。
 */
/**
 * 泛型化：飞书与 SQL 两条链路都要经过同一张映射表，
 * 否则 SQL 侧拿到的是代码内登记的 ID，与迁移脚本写入的生产 ID 对不上。
 */
function withTableMap<T extends DataStore>(client: T): T {
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

/** 进程内共享的 SQL 实例（供迁移脚本 / 校验脚本取用） */
let sqlStore: SqlStore | null = null;
export function getSqlStore(): SqlStore | null {
  return sqlStore;
}

/**
 * 数据访问入口。
 *
 * - 未配置 `DATABASE_URL` → 纯飞书，行为与改造前完全一致
 * - 配置了 `DATABASE_URL` → 按 `SQL_TABLES` 逐表路由到 PostgreSQL
 *   （`SQL_TABLES='*'` 全量；`'tblA,tblB'` 逐表灰度；留空则仍全走飞书）
 */
export const baseClientProvider: Provider = {
  provide: BASE_CLIENT,
  useFactory: (): DataStore => {
    const feishu = withTableMap(
      new BaseClient(
        {
          appId: process.env.FEISHU_APP_ID ?? '',
          appSecret: process.env.FEISHU_APP_SECRET ?? '',
        },
        process.env.FEISHU_BASE_TOKEN ?? '',
      ),
    );
    const url = process.env.DATABASE_URL?.trim();
    if (!url) return feishu;
    const tables = new Set(
      (process.env.SQL_TABLES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    sqlStore ??= withTableMap(new SqlStore(url));
    const shadowWrite = (process.env.SQL_SHADOW_WRITE ?? '').trim() === '1';
    return new RoutingStore(feishu, sqlStore, tables, shadowWrite);
  },
};
