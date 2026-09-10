import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TABLES } from '@acms/contracts';
import { toText, toStringArray } from '../src/convert.js';

describe('字段转换（飞书坑位规则）', () => {
  it('list-of-dicts 提取 text', () => {
    expect(toText([{ text: 'ou_xxx', type: 'text' }])).toBe('ou_xxx');
  });

  it('多选字段取字符串数组', () => {
    expect(toStringArray(['系统管理员', '教师'])).toEqual(['系统管理员', '教师']);
    expect(toStringArray([{ text: '系统管理员' }])).toEqual(['系统管理员']);
    expect(toStringArray(undefined)).toEqual([]);
  });

  it('普通字符串原样返回', () => {
    expect(toText('启用')).toBe('启用');
  });
});

describe('表注册表自检', () => {
  const entries = Object.entries(TABLES) as Array<[string, { tableId: string; name: string }]>;

  it('每张表的 tableId / name 均非空且 tableId 以 tbl 开头', () => {
    for (const [key, t] of entries) {
      expect(t.tableId, `${key} 缺 tableId`).toMatch(/^tbl[A-Za-z0-9]+$/);
      expect(t.name?.length ?? 0, `${key} 缺中文表名`).toBeGreaterThan(0);
    }
  });

  it('tableId 不重复（重复会导致不同模块串表）', () => {
    const ids = entries.map(([, t]) => t.tableId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * 数据源漂移检测：以 PostgreSQL 为事实来源（2026-09 起业务数据已切 PG，飞书 Base 仅作历史结构）。
 * 生产通过环境变量 TABLE_ID_MAP 把代码里的 DEV 表 ID 重映射为生产表 ID，
 * 因此只有配置了该映射时才具备比对条件，本地/CI 未配置则跳过。
 */
describe('数据源漂移检测（需 TABLE_ID_MAP）', () => {
  const pg = JSON.parse(
    readFileSync(new URL('../../../docs/pg-tables.json', import.meta.url), 'utf-8'),
  ) as { generated_at: string; count: number; tables: string[] };
  const hasMap = !!process.env.TABLE_ID_MAP;

  it.runIf(hasMap)('代码注册的每张表在 PostgreSQL 中都存在', () => {
    const pgSet = new Set(pg.tables);
    const map = JSON.parse(process.env.TABLE_ID_MAP ?? '{}') as Record<string, string>;
    const missing = (Object.entries(TABLES) as Array<[string, { tableId: string }]>)
      .map(([key, t]) => {
        const resolved = map[t.tableId] ?? t.tableId;
        return pgSet.has(`t_${resolved.toLowerCase()}`) ? null : `${key}(${resolved})`;
      })
      .filter((x): x is string => x !== null);
    expect(
      missing,
      `以下表在 PG 中不存在（快照 ${pg.generated_at}，共 ${pg.count} 表）：${missing.join('、')}`,
    ).toEqual([]);
  });

  it('PG 快照非空且格式合法', () => {
    expect(pg.count).toBeGreaterThan(0);
    expect(pg.tables.length).toBe(pg.count);
    for (const t of pg.tables) expect(t).toMatch(/^t_tbl[a-z0-9]+$/);
  });
});
