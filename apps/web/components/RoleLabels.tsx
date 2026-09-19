'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
/** 上次「自愈重取」时间 —— 见下方 useRoleLabels 的说明 */
let lastForceAt = 0;
const FORCE_COOLDOWN_MS = 10_000;

/**
 * 🔴 **只有成功才写 cache**（2026-09-19 修）。
 *
 * 原实现是无条件 `cache = map` —— 一旦首次调用失败（或后端尚未载入角色配置、
 * 返回空的 roleLabels），那个**空映射会被永久缓存**，于是整个会话里所有角色都退化成
 * 显示角色标识（「Phase5」这种），且**再也不会重试**。
 * 症状是「同一个人名，在用户管理页显示展示名、在别处显示标识」——
 * 看起来像「两个页面写法不同」，实际是这份缓存被一次失败污染了。
 *
 * `force=true` 时绕过 cache（供「查不到某个角色名」时的自愈重取用）。
 */
function loadLabels(force = false): Promise<Record<string, string>> {
  if (!force && cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  if (Date.now() - failedAt < RETRY_MS) return Promise.resolve(cache ?? {});
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

/**
 * 🔴 **自愈：渲染时发现「查不到展示名的角色 key」就强制重取一次**（2026-09-19 补）。
 *
 * 为什么需要：这份映射**每个页面加载只取一次**，而标签页常常开着很久。
 * 期间管理员新建/改名了角色（例如新增 `Phase9`），已经打开的页面拿着旧映射 ⇒
 * `labelOf()` 回退成原样显示 **角色标识**，于是「同一条数据里一个显示展示名、
 * 一个显示标识」看起来像渲染不一致，实际是**这份映射过期了**。
 * 用户当时反馈的正是这个：徐洁的角色显示成「后端老师-L4查看、Phase9」。
 *
 * 现在：只要渲染时发现某个 key 查不到，就无感重取一次（10 秒冷却，避免
 * 「角色已被删除」这种永远查不到的情况变成请求死循环）。
 * 判据仍然坚持「**宁可是标识，也不猜**」—— 重取失败时照旧回退成 key，绝不编造名称。
 */
export function useRoleLabels() {
  const [map, setMap] = useState<Record<string, string>>(cache ?? {});
  /** 本轮渲染里是否出现过「查不到」—— 用 ref 收集，避免把它写进 effect 依赖造成渲染死循环 */
  const missedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    loadLabels().then((m) => {
      if (alive) setMap(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  const labelOf = useCallback(
    (key: string): string => {
      if (!key) return '';
      const hit = map[key];
      if (hit) return hit;
      // 查不到 ⇒ 记一笔，交给下面的 effect 去重取（本轮仍按原样显示，不猜）
      missedRef.current = true;
      return key;
    },
    [map],
  );

  /** 依赖只有 `map`：`labelOf` 用 useCallback 保持了身份稳定，不会每轮触发本 effect */
  useEffect(() => {
    if (!missedRef.current) return;
    missedRef.current = false;
    if (Date.now() - lastForceAt < FORCE_COOLDOWN_MS) return;
    lastForceAt = Date.now();
    let alive = true;
    void loadLabels(true).then((m) => {
      if (alive && m && Object.keys(m).length) setMap({ ...m });
    });
    return () => {
      alive = false;
    };
  }, [map]);

  const joinLabels = useCallback(
    (v: unknown): string =>
      (Array.isArray(v) ? v.map((k) => labelOf(String(k ?? ''))) : [String(v ?? '')]).join('、'),
    [labelOf],
  );

  return { map, labelOf, joinLabels };
}

/** 列表单元格：把存储的「系统角色」（key 数组）解析成可读名称并用顿号连接 */
export function RoleLabelsCell({ value }: { value: unknown }) {
  const { joinLabels } = useRoleLabels();
  return <>{joinLabels(value)}</>;
}
