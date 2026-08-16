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

describe('Base 契约（Schema Drift 检测）', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../../../docs/base-schema-snapshot.json', import.meta.url), 'utf-8'),
  ) as { tables: Record<string, { table_id: string; fields: { name: string; type: number }[] }> };

  it('代码表注册与快照 table_id 完全一致', () => {
    const snapIds = new Set(Object.values(snapshot.tables).map((t) => t.table_id));
    for (const [key, t] of Object.entries(TABLES)) {
      expect(snapIds.has(t.tableId), `${key} 的 ${t.tableId} 不在快照中，Base 结构已漂移`).toBe(true);
    }
    expect(new Set(Object.values(TABLES).map((t) => t.tableId)).size).toBe(snapIds.size);
  });

  it('每张表字段数 ≥ 16（防误删字段）', () => {
    for (const [name, t] of Object.entries(snapshot.tables)) {
      expect(t.fields.length, `${name} 字段数异常`).toBeGreaterThanOrEqual(16);
    }
  });
});
