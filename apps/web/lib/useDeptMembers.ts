'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface DeptMembersData {
  /** 我所属的部门 id（「指定部门可见」新建时的默认选中值；查不到就是空数组） */
  myDeptIds: string[];
  /** 部门 id → 该部门**含下级**的成员姓名 */
  deptMembers: Record<string, string[]>;
  /** 被手动从「参会人员」删掉的人：再改部门时不自动加回（跨渲染保留，故用 ref） */
  manuallyRemoved: React.RefObject<Set<string>>;
}

/**
 * 会议纪要的「部门 → 成员」联动数据。
 *
 * 从「会议纪要」列表页原样抽出来的（2026-09-28），因为「我的笔记 → 转换」的就地转换表单
 * 也要用**同一份**数据与同一份 columns —— 两处各拉一次、各写一份树遍历，
 * 迟早会漂移（症状：「列表页选部门能带出人、笔记转换里带不出」）。
 *
 * 数据来自三个现成接口，一次拼好（都在本地快照里，不打上游）：
 *   `/departments`（层级，用来展开子树）
 * + `/departments/member-index`（部门 → openId）
 * + `/users/directory`（openId → 姓名）
 *
 * ⚠️ 成员快照里虽然也有姓名，但 `member-index` 只给 openId（它是给「算人数」用的轻量索引），
 *    所以必须 join 一次目录才能拿到姓名 —— 而「参会人员」存的正是**姓名数组**。
 */
export function useDeptMembers(enabled = true): DeptMembersData {
  // 「指定部门可见」新建时的默认选中值 = **我所属的部门**。
  // 放在这里查、再喂给列定义，这样通用组件不必知道「当前用户属于哪个部门」这件事
  // （别的模块也不需要这个语义）。
  const [myDeptIds, setMyDeptIds] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    api
      .myDepartments()
      .then((r) => setMyDeptIds(Array.isArray(r?.ids) ? r.ids : []))
      .catch(() => {});
  }, [enabled]);

  const [deptMembers, setDeptMembers] = useState<Record<string, string[]>>({});
  useEffect(() => {
    // 只有真正要用它的页面才去拉：这套数据要打 3 个接口（部门树 + 成员索引 + 用户目录）
    if (!enabled) return;
    let alive = true;
    Promise.all([api.listDepartments(), api.departmentMemberIndex(), api.listUserDirectory()])
      .then(([depts, index, dir]) => {
        if (!alive) return;
        const nodes = (depts?.items ?? []).filter((d) => d.status !== 'invalid');
        const children = new Map<string, string[]>();
        for (const d of nodes) {
          const p = String(d.parent_department_id ?? '');
          if (!p) continue;
          const cur = children.get(p) ?? [];
          cur.push(String(d.open_department_id));
          children.set(p, cur);
        }
        const nameOfOpenId = new Map(dir.map((u) => [String(u.openId), String(u.name)]));
        /** 部门 → 直属成员姓名 */
        const direct = new Map<string, string[]>();
        for (const r of index ?? []) {
          const n = nameOfOpenId.get(String(r.openId));
          if (!n) continue;
          const cur = direct.get(String(r.departmentId)) ?? [];
          if (!cur.includes(n)) cur.push(n);
          direct.set(String(r.departmentId), cur);
        }
        /** 部门 → 自身 + 全部下级的成员姓名（带环保护：部门树理论上无环，但不赌） */
        const out: Record<string, string[]> = {};
        const collect = (id: string, seen: Set<string>): string[] => {
          if (out[id]) return out[id];
          if (seen.has(id)) return [];
          seen.add(id);
          const names = [...(direct.get(id) ?? [])];
          for (const c of children.get(id) ?? []) {
            for (const n of collect(c, seen)) if (!names.includes(n)) names.push(n);
          }
          out[id] = names;
          return names;
        };
        for (const d of nodes) collect(String(d.open_department_id), new Set());
        setDeptMembers(out);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);

  const manuallyRemoved = useRef<Set<string>>(new Set());

  return { myDeptIds, deptMembers, manuallyRemoved };
}
