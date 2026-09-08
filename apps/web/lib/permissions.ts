'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * 全局权限缓存（单例）：登录后只拉一次 /auth/permissions，全站组件共享，
 * 用于按钮级门控。CrudPage、AppShell 等都从这里读，避免每页重复请求。
 */
let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

export async function loadPermissions(): Promise<string[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = api
    .getPermissions()
    .then((p) => {
      cache = p.myPermissions || [];
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function resetPermissions(): void {
  cache = null;
  inflight = null;
}

export function hasPerm(p: string): boolean {
  return !!cache && cache.includes(p);
}

/** 模块级便捷判断：module:<key>:<action> 是否在当前用户权限内。 */
export function hasModulePerm(key: string, action: string): boolean {
  if (!cache) return false;
  const mod = cache.find((x) => x === `module:${key}:${action}`);
  return !!mod;
}

export function usePermissions(): string[] {
  const [perms, setPerms] = useState<string[]>(cache ?? []);
  useEffect(() => {
    if (cache) {
      setPerms(cache);
      return;
    }
    loadPermissions()
      .then(setPerms)
      .catch(() => setPerms([]));
  }, []);
  return perms;
}
