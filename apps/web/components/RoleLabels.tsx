'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * 角色 key → 展示名（label）映射。
 * 存储层只存稳定的 key（改名不影响 key），展示层统一在这里把 key 解析成可读名称，
 * 这样「角色管理里改名」对所有已授权用户立即生效，且无需数据迁移。
 *
 * 数据源：GET /auth/permissions（roleLabels 字段）。该端点仅要求登录，
 * 非管理员（如教师）也能调用 —— 故前端各处显示角色名都走这里，而非 admin 专属的 /role-management。
 * 模块级缓存，多个组件并发调用只发一次请求。
 */
let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;

function loadLabels(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (async () => {
    const map: Record<string, string> = {};
    try {
      const d = await api.getPermissions();
      if (d?.roleLabels) Object.assign(map, d.roleLabels);
    } catch {
      /* 加载失败时回退到 key 本身 */
    } finally {
      inflight = null;
    }
    cache = map;
    return map;
  })();
  return inflight;
}

export function useRoleLabels() {
  const [map, setMap] = useState<Record<string, string>>(cache ?? {});
  useEffect(() => {
    let alive = true;
    loadLabels().then((m) => {
      if (alive) setMap(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  const labelOf = (key: string): string => (key ? map[key] ?? key : key);
  const joinLabels = (v: unknown): string =>
    (Array.isArray(v) ? v.map((k) => labelOf(String(k ?? ''))) : [String(v ?? '')]).join('、');
  return { map, labelOf, joinLabels };
}

/** 列表单元格：把存储的「系统角色」（key 数组）解析成可读名称并用顿号连接 */
export function RoleLabelsCell({ value }: { value: unknown }) {
  const { joinLabels } = useRoleLabels();
  return <>{joinLabels(value)}</>;
}
