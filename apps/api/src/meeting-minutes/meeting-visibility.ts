import {
  TABLES,
  USER_TABLE,
  // 「可见范围」的字段名与取值定义在 contracts（前后端共享，前端表单用的是同一份）
  MEETING_CREATOR_FIELD as CREATOR_FIELD,
  MEETING_DEFAULT_VISIBILITY as DEFAULT_VISIBILITY,
  MEETING_DEPT_FIELD as DEPT_FIELD,
  MEETING_VISIBILITY_FIELD as VISIBILITY_FIELD,
  MEETING_VISIBLE_DEPTS_FIELD as VISIBLE_DEPTS_FIELD,
  MEETING_VISIBLE_USERS_FIELD as VISIBLE_USERS_FIELD,
  type SessionUser,
} from '@acms/contracts';
import type { RowScopeContext, RowScopeFilter } from '../shared/generic-crud.module.js';

/**
 * 会议纪要的「可见范围」判据 —— **刻意做成无 Nest 依赖的纯函数模块**。
 *
 * 为什么不写在 `lifecycle.meta.ts` 里：
 *   那里是静态配置对象，几百行的部门树遍历 + 两张表的读取逻辑塞进去会淹没掉别的一百多个 meta；
 *   更重要的是它需要**可独立测试**（喂真实的部门/成员数据，断言算出来的集合），
 *   放在一个只有纯函数的文件里就能直接被契约测试 import。
 *
 * 为什么不写成 Nest Service：
 *   本模块只被 `RecordMeta.rowScope` / `defaults` 调用，而 meta 是模块级常量、拿不到依赖注入。
 *   引擎已经通过 `RowScopeContext.search()` 把「读别的表」的能力传进来了，不需要 Service。
 *   （同款范式见 `getnote/source-cred.ts`。）
 *
 * 🔴 判据只写这一处：列表 / 详情 / 编辑 / 删除 / 导出全部由引擎的 `rowScopeFor()` 消费同一份条件。
 *    任何 controller 里都不许再判一遍 —— 两处判据必然漂移（一处放行、一处拦截）。
 */

// ── 字段名与取值 ───────────────────────────────────────────────────
// 全部来自 `@acms/contracts` 的 `meeting.ts`（前端 `columns.tsx` 用的是**同一份**定义）。
// 🔴 不要在本文件里再写一份字符串字面量：两处改字（「部门内」vs「部门内可见」）会静默失配，
//    症状是「前端能选、后端判不到」⇒ 记录对所有人隐身，且不报任何错。
//
//   VISIBILITY_FIELD    「可见范围」—— 唯一的分支判据字段
//   VISIBLE_USERS_FIELD 「可见用户」—— 多选，存**用户表 record id 数组**（与邮件账户/知识库配置的关联用户同款）
//   CREATOR_FIELD       「创建人ID」—— 冗余存 openId，仅判据使用，界面不展示
//   DEPT_FIELD          「部门」—— 会议纪要既有字段，存**部门名**
//   DEFAULT_VISIBILITY  = '部门内可见'（= MEETING_VISIBILITY_SCOPES[0]，与前端 defaultFirstOption 一致）

/**
 * 行级范围的豁免角色（`RecordMeta.rowScopeBypassRoles`）—— 即需求里的「系统管理员 + 公司最高领导人」。
 *
 * - `系统管理员`：引擎默认豁免，这里显式列出以免默认值变化时行为漂移
 * - `院级管理`：院级管理层
 *
 * 🔴 **为什么「公司最高领导人」不用「根节点部门的负责人」来判**：
 *   飞书组织架构**界面上**「公司」那一行确实有负责人（宋琼｜Sally），但那个位置是**企业本身**
 *   （部门名就是企业全称），它显示的是「企业负责人」属性，**不在通讯录部门的 open API 里**。
 *   实测（2026-09-17，生产 tenant_access_token）：
 *     `GET /contact/v3/departments/0?department_id_type=open_department_id|department_id`
 *     → 返回体**只有** department_id / name / member_count / open_department_id / primary_member_count，
 *       **连 `leader_user_id` / `leaders` 这两个键都不存在**，`name` 还是空串；
 *     而普通部门（如学术轨）同一接口会返回 `leader_user_id`、`leaders`、`chat_id`、`order`、`status`…
 *   ⇒ 根部门负责人**结构性地拿不到**，判据只能落在角色上。
 *
 * ✅ 生产中这两个角色的实际覆盖（2026-09-17 核对）：
 *   - `系统管理员` = 孙旭峰｜Richard、**宋琼｜Sally**（宋琼就是飞书界面上那个「公司」负责人）
 *   - `院级管理` = 孙旭峰｜Richard
 *   即「公司最高领导人看全部」这条需求**已经由 `系统管理员` 满足**。
 *
 * ⚠️ 若将来「院级管理」扩大到不该看全部纪要的人，应改为新增一个专用角色，而不是继续沿用。
 */
export const MEETING_SCOPE_BYPASS_ROLES = ['系统管理员', '院级管理'];

/** 部门表的原始行（只取判据用得到的字段） */
interface DeptRow {
  id: string;
  name: string;
  parent: string;
  status: string;
  leader: string;
}

/** 从 `ctx.search()` 的扁平记录里解出部门行 */
function toDeptRows(rows: readonly Record<string, unknown>[]): DeptRow[] {
  const out: DeptRow[] = [];
  for (const r of rows) {
    const id = String(r.open_department_id ?? '').trim();
    const status = String(r.status ?? 'active').trim();
    // 已删除部门不参与树遍历（前端也不展示），否则会把已解散部门的纪要一直挂在某个人头上
    if (!id || status === 'invalid') continue;
    out.push({
      id,
      name: String(r.name ?? '').trim(),
      parent: String(r.parent_department_id ?? '').trim(),
      status,
      leader: String(r.leader_user_id ?? '').trim(),
    });
  }
  return out;
}

/**
 * 某部门的**子树 id 集合（含自身）**。
 *
 * 与 `DepartmentService.subtreeIds()` 是同一套口径（父 id 建图 → 向下 BFS），
 * 这里重写一份是因为那个方法是 class 的私有成员、且依赖 Nest 注入，纯函数模块拿不到。
 * ⚠️ 两处若将来要支持「跨根/环」等异常结构，必须一起改。
 */
export function subtreeOf(depts: readonly DeptRow[], rootId: string): string[] {
  const root = String(rootId ?? '').trim();
  if (!root) return [];
  // 🔴 根必须**在表里真实存在**才算数。
  //    成员快照里可能残留一个已被删除部门的 id（部门表那边已经是 invalid、被 toDeptRows 滤掉了），
  //    不校验的话 `walk()` 会把这个不存在的 id 当成一个部门加进结果 ——
  //    下游按 id 换部门名时它自然落空（不会越权），但函数语义就错了，
  //    而且这种「静默多一个 id」的 bug 极难在别处发现。契约测试 cover 了这条。
  if (!depts.some((d) => d.id === root)) return [];

  const children = new Map<string, string[]>();
  for (const d of depts) {
    const arr = children.get(d.parent);
    if (arr) arr.push(d.id);
    else children.set(d.parent, [d.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (!id || seen.has(id)) return; // seen 兼作环保护
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) walk(c);
  };
  walk(root);
  return out;
}

/**
 * 部门的 open_department_id 正式形态。
 *
 * 🔴 **只有形如 `od-…` 的部门才参与「指定部门可见」的 `contains` 匹配。**
 *   多值字段只能用子串匹配（`data->>'可见部门'` 返回 `["od-a","od-b"]` 这段 JSON 文本），
 *   而**根部门「公司」的 open_department_id 就是字符串 `'0'`** —— 拿单字符 `'0'` 去子串匹配
 *   会命中一切（任何 `od-…` 里几乎都含 `0`）⇒ 等于全员可见。
 *   而「选公司」本身等价于「公开」，所以这里把非 `od-` 形态的一律排除。
 */
const OD_ID_RE = /^od-/;

/** 「我的部门范围」的三种形态（一次算好，避免各判据各算一遍而漂移） */
export interface DeptScope {
  /**
   * 我**直接**所属/负责的部门 id（**未展开下级**）。
   * 用途：「指定部门可见」新建时的默认选中值（= 「默认选中自己部门」，不吃下级）。
   */
  myIds: string[];
  /** 我所属/负责的部门及其**下级**的 id（只含 `od-…` 形态） */
  ownIds: string[];
  /** 同上，部门名 —— 「部门内可见」判据用（记录的「部门」字段存的是名字） */
  ownNames: string[];
  /**
   * 「指定部门可见」时**我能命中的部门 id 集合** = ownIds ∪ 这些部门的全部**上级**。
   *
   * 为什么要把上级并进来：判据要回答的是「**我是否属于被指定的那个部门（的子树）**」。
   * 某人把纪要指定给「学术轨」时，学术轨整棵子树里的人（含三个子中心）都该看到，
   * 而他们在「我的部门」视角下是**下级** ⇒ 必须沿 parent 链把上级补全。
   * （只用 ownIds 的话，子中心的人恰恰看不到指定给自己上级部门的纪要 —— 那就违背了
   * 「选对部门的所有人都可以看到」。）
   */
  assignableIds: string[];
}

/** 沿 parent 链向上收集某部门的全部上级（部门表的 parent 为空串表示到顶） */
function ancestorsOf(depts: readonly DeptRow[], id: string): string[] {
  const byId = new Map(depts.map((d) => [d.id, d]));
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id)?.parent ?? '';
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = byId.get(cur)?.parent ?? '';
  }
  return out;
}

/**
 * 「我的部门范围」—— 三种形态一次算好。
 *
 * 范围 = （我所属的部门 ∪ 我担任负责人的部门）各自展开子树后取并集：
 *  - 我所属部门：部门成员快照 `t_tbldeptmem000001` 里 `user_open_id == 我的 openId`
 *  - 我负责的部门：部门表里 `leader_user_id == 我的 openId` —— **这就是「部门领导看下属部门」的全部实现**，
 *    不需要单独一条判据分支：负责人只是拥有更大的部门集合，其余判据完全一致
 *
 * ⚠️ `ownNames` 之所以是**部门名**，是因为会议纪要的「部门」字段存的本来就是部门名（历史原因），
 *    且用**等值**匹配而非 `contains` —— 「教务」会误命中「教务中心」。当前 9 个部门名唯一。
 *    新加的 `assignableIds` 一律用 id，既不吃重名也不吃改名。
 */
export async function myDeptScopeOf(
  user: SessionUser | null | undefined,
  ctx: RowScopeContext,
): Promise<DeptScope> {
  const empty: DeptScope = { myIds: [], ownIds: [], ownNames: [], assignableIds: [] };
  const openId = String(user?.openId ?? '').trim();
  if (!openId) return empty;

  // 两张表都是小表（部门 9 条 / 成员 28 条），一次取回即可。
  // ⚠️ `ctx.search()` 内置 pageSize=500 且**不翻页** —— 若将来部门或成员数超过 500，
  //    这里会静默漏人（表现为「某人的部门范围变小」）。届时要改成显式翻页。
  const [deptRows, memberRows] = await Promise.all([
    ctx.search(TABLES.departments.tableId),
    ctx.search(TABLES.departmentMembers.tableId),
  ]);

  const depts = toDeptRows(deptRows);

  const ledIds = new Set<string>(); // 我担任负责人的部门
  for (const d of depts) if (d.leader && d.leader === openId) ledIds.add(d.id);
  const memberIds = new Set<string>(); // 我所属的部门（成员快照）
  for (const m of memberRows) {
    if (String(m.user_open_id ?? '').trim() !== openId) continue;
    const id = String(m.open_department_id ?? '').trim();
    if (id) memberIds.add(id);
  }
  const roots = new Set([...ledIds, ...memberIds]);
  if (!roots.size) return empty;

  const wanted = new Set<string>();
  for (const root of roots) for (const id of subtreeOf(depts, root)) wanted.add(id);

  // 「默认选中自己部门」= 我**所属**的那一个（不含下级、不含我负责的其它部门）——
  // 需求原话是「默认是选中自己部门」；只有我不属于任何部门时（纯负责人身份）才退回我负责的部门。
  const myIds = Array.from(memberIds.size ? memberIds : ledIds).filter((id) => OD_ID_RE.test(id));
  const ownIds = Array.from(wanted).filter((id) => OD_ID_RE.test(id));
  const ownNames = Array.from(
    new Set(depts.filter((d) => wanted.has(d.id)).map((d) => d.name).filter(Boolean)),
  );

  const assignable = new Set(ownIds);
  for (const id of ownIds) {
    for (const up of ancestorsOf(depts, id)) if (OD_ID_RE.test(up)) assignable.add(up);
  }

  return { myIds, ownIds, ownNames, assignableIds: Array.from(assignable) };
}

/**
 * 兼容包装：只要部门名集合（「部门内可见」判据用）。
 * ⚠️ 新代码优先直接用 `myDeptScopeOf()`，免得同一份逻辑被重复计算。
 */
export async function myDeptNamesOf(
  user: SessionUser | null | undefined,
  ctx: RowScopeContext,
): Promise<string[]> {
  return (await myDeptScopeOf(user, ctx)).ownNames;
}

/** 我在**用户表**里的 record id（「可见用户」字段存的是它，不是 openId） */
async function myUserIdOf(openId: string, ctx: RowScopeContext): Promise<string> {
  if (!openId) return '';
  const rows = await ctx.search(USER_TABLE.tableId);
  const hit = rows.find((r) => String(r['飞书 Open ID'] ?? '').trim() === openId);
  return hit?.id ? String(hit.id) : '';
}

/**
 * 会议纪要的行级范围判据（挂在 `RecordMeta.rowScope`）。
 *
 * 返回一个 **OR 四分支**：命中任意一支即可见。
 *
 * ⚠️ 豁免角色（`MEETING_SCOPE_BYPASS_ROLES`）由引擎在调用本函数**之前**判掉，
 *    所以这里不再重复判角色 —— 判据写两处必然漂移。
 *
 * 🔴🔴 **空集合必须整条分支跳过，绝不能把空数组塞进 `value`**：
 *    引擎两侧都把「空 value 数组」当成「没有条件」——
 *      · 内存路径 `matchFilter`：`if (!want.length) return true` ⇒ **判为可见**
 *      · SQL 路径 `buildCondition`：`if (!vals.length) return ''` ⇒ **不产生 WHERE 片段**
 *    也就是说，如果某人不在任何部门（新人未同步、外部账号…），
 *    而我们把 `value: []` 传下去，「部门内可见」就会**静默变成「全员可见」**（真实越权）。
 *    所以下面每一支都先判非空再加。
 *
 *    同理，**不要用 `isempty` / `isnot` 做「字段为空视为 XX」的兜底**：`matchFilter` 不认这两个 op，
 *    会把它们退化成等值判断，而 `buildCondition` 认 —— 又是两条路径不一致。
 *    「可见范围」为空 ⇒ 四支都不命中 ⇒ **对所有人隐身**（含创建者自己）。
 *    这是**安全方向**的失败，可接受；靠前端必填 + 存量数据迁移来避免。
 */
export async function meetingRowScope(
  user: SessionUser,
  ctx: RowScopeContext,
): Promise<RowScopeFilter | 'none' | null> {
  const openId = String(user?.openId ?? '').trim();
  const [deptScope, myUserId] = await Promise.all([
    myDeptScopeOf(user, ctx),
    myUserIdOf(openId, ctx),
  ]);
  const myDeptNames = deptScope.ownNames;

  const conditions: RowScopeFilter[] = [];

  // ① 公开：所有拥有本模块访问权的人都能看
  conditions.push({ field: VISIBILITY_FIELD, value: ['公开'] });

  // ② **我创建的一律可见**（与「可见范围」无关）。
  //
  // 🔴 这一条不是锦上添花，而是线上实测出来的真 bug 的修复：
  //    2026-09-17 部署后验证时，姜龙女建了一条「指定用户可见」（名单里只有钟慧婷、没有她自己），
  //    结果**她自己在列表里看不到这条**，而且 POST 的返回值是 **404 NOT_FOUND** ——
  //    因为 `BaseRecordService.create()` 在写入后会调 `detail()` 回读，而 detail 同样过行级范围，
  //    被自己的判据挡住 ⇒ 前端会显示「保存失败」，可数据其实已经写进去了（用户会重复提交）。
  //
  //    因此「创建人总能看到自己创建的记录」必须是一条**独立于可见范围**的分支。
  //
  //    顺带：它也覆盖了「仅自己可见」—— 那种记录不会命中 ③④⑤，只有创建人靠本分支命中，
  //    所以下面不再单列「仅自己可见」的分支（列了也是被本条覆盖的死分支）。
  //
  // ⚠️ 用**冗余的 jsonb 字段**「创建人ID」，不能用物理列 created_by：
  //    SQL 侧的条件只能落在 `data->>'X'` 上，物理列不参与 rowScope 过滤 ⇒ 那条路等于没限制（越权）。
  if (openId) {
    conditions.push({ field: CREATOR_FIELD, value: [openId] });
  }

  // ③ 部门内可见：记录的「部门」落在我（所在 + 所负责）的部门范围内
  if (myDeptNames.length) {
    conditions.push({
      conjunction: 'and',
      conditions: [
        { field: VISIBILITY_FIELD, value: ['部门内可见'] },
        { field: DEPT_FIELD, value: myDeptNames },
      ],
    });
  }

  // ④ 指定用户可见：「可见用户」里包含我。
  //    用 record id 比对（不用姓名 —— 重名必出事）；contains 命中 jsonb 数组里的元素文本。
  if (myUserId) {
    conditions.push({
      conjunction: 'and',
      conditions: [
        { field: VISIBILITY_FIELD, value: ['指定用户可见'] },
        { field: VISIBLE_USERS_FIELD, op: 'contains', value: [myUserId] },
      ],
    });
  }

  // ⑤ 指定部门可见：记录的「可见部门」里包含**我所在部门树的任意一层**。
  //
  //    用部门 id（`od-…`）而不是部门名 —— 多值字段只能靠 `contains` 子串匹配，
  //    而 id 唯一且互不为子串；部门名会串台（「教学」会命中「教学管理中心」）。
  //    `assignableIds` 里已经并进了我的**上级**部门，因此「指定给我上级部门」时我也能命中
  //    —— 也就是该部门的**整棵子树**都能看到，符合「选对部门的所有人都可以看到」。
  if (deptScope.assignableIds.length) {
    conditions.push({
      conjunction: 'and',
      conditions: [
        { field: VISIBILITY_FIELD, value: ['指定部门可见'] },
        { field: VISIBLE_DEPTS_FIELD, op: 'contains', value: deptScope.assignableIds },
      ],
    });
  }

  // 防御：正常至少有「公开」这一支，构不出来说明连公开都不该所见（理论上不可达）
  if (!conditions.length) return 'none';
  return { conjunction: 'or', conditions };
}

/**
 * 新建时的字段兜底（挂在 `RecordMeta.defaults`，**只在 create 生效**）。
 *
 * ⚠️ 引擎的写回逻辑是 `if (!(k in fields)) fields[k] = v` —— 只有**字段完全没传**时才会写入。
 *    若前端传了一个空字符串，这里**覆盖不了**。所以「可见范围必有值」这件事主要靠前端
 *    （`required: true` + `defaultFirstOption: true`），本函数只兜住「压根没传该字段」的情况。
 *
 * ⚠️ 前端也会预填「可见部门」= 我所属部门（让用户**看得见**默认值、可改）；
 *    这里再兜一层是为了挡住「API 直建 / 前端未预填」的路径 —— 判据只认落库的值。
 */
export async function meetingDefaults(
  fields: Record<string, unknown>,
  user?: SessionUser | null,
  ctx?: RowScopeContext,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { [CREATOR_FIELD]: user?.openId ?? '' };

  const scope = String(fields[VISIBILITY_FIELD] ?? '').trim();
  if (!scope) out[VISIBILITY_FIELD] = DEFAULT_VISIBILITY;

  // 「指定部门可见」却没选部门 ⇒ 兜底成「我直接所属/负责的部门」（不含下级，与默认选中一致）
  const picked = fields[VISIBLE_DEPTS_FIELD];
  const hasPicked = Array.isArray(picked) ? picked.length > 0 : Boolean(String(picked ?? '').trim());
  if (scope === '指定部门可见' && !hasPicked && ctx) {
    const myScope = await myDeptScopeOf(user, ctx);
    if (myScope.myIds.length) out[VISIBLE_DEPTS_FIELD] = myScope.myIds;
  }
  return out;
}
