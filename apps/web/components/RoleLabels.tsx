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
/** 上次失败时间 —— 失败后短暂不再重试，避免每个用到角色的组件都重打一次接口 */
let failedAt = 0;
const RETRY_MS = 30_000;

/**
 * 🔴 **只有成功才写 cache**（2026-09-19 修）。
 *
 * 原实现是无条件 `cache = map` —— 一旦首次调用失败（或后端尚未载入角色配置、
 * 返回空的 roleLabels），那个**空映射会被永久缓存**，于是整个会话里所有角色都退化成
 * 显示角色标识（「Phase5」这种），且**再也不会重试**。
 * 症状是「同一个人名，在用户管理页显示展示名、在别处显示标识」——
 * 看起来像「两个页面写法不同」，实际是这份缓存被一次失败污染了。
 */
function loadLabels(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  if (Date.now() - failedAt < RETRY_MS) return Promise.resolve({});
  inflight = (async () => {
    const map: Record<string, string> = {};
    let ok = false;
    try {
      const d = await api.getPermissions();
      if (d?.roleLabels && Object.keys(d.roleLabels).length) {
        Object.assign(map, d.roleLabels);
        ok = true;
      }
    } catch {
      /* 保留未缓存状态，稍后重试 */
    } finally {
      inflight = null;
    }
    if (ok) cache = map;
    else failedAt = Date.now();
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
