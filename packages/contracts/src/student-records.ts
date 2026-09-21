/**
 * 「学生记录」——把 日常跟进 / 家校沟通 / 学生观察 三个模块合并后的类型定义。
 *
 * 背景（2026-09-18）：这三个模块本来就是「同一张表的三个视图」——
 * 三者的 RecordMeta 里 numbers / dateFields / statusField / defaultStatus /
 * searchField / sortField 逐字相同，共用同一批字典（沟通方式 / 家校闭环状态 /
 * 信息敏感级别），笔记转出的字段映射也完全一致。合并后：
 *
 *   一张表（沿用「日常跟进表」）+ 一个「记录类型」单选字段区分三类记录。
 *
 * 🔴 为什么权限要「任一类型权限即可」而不是新造一个 `module:studentRecords:read`：
 *    合并前每个模块各有自己的权限点，角色配置里存的就是那三个。
 *    若主入口只认新权限点，则合并后**没有任何角色能进入**（生产实测：24 人的主力角色
 *    Phase1 只有 `module:studentObservations:*`，没有 dailyFollowups/homeSchoolComms），
 *    等于把「看得见」降级成「看不见」。所以：
 *      - 接口侧：`typeScope` 存在时，读权限按「任一类型模块的 read」判定，命中即放行；
 *      - 菜单侧：同理由 `anyStudentRecordPerm` 判定；
 *      - 内容侧：具体能看到哪些**类型**，仍由各自的 module 权限逐类型过滤（不放大范围）。
 *    这样**一个角色的配置都不用改**，权限语义也不降级。
 */

import { modulePermission, type ModuleAction } from './module-permissions.js';

/** 类型字段名（与数据库字段名严格一致） */
export const STUDENT_RECORD_TYPE_FIELD = '记录类型';

export interface StudentRecordTypeDef {
  /** 「记录类型」单选的取值 */
  value: string;
  /** 承载该类型的模块 key（用于拼 `module:<key>:<action>` 权限点） */
  moduleKey: string;
  /** 合并前的独立页面路径（保留 301 重定向，书签不失效） */
  legacyPath: string;
  /** 该类型的专属字段（表单按类型显隐；公共字段不在其中） */
  ownFields: readonly string[];
}

/**
 * 记录类型的定义。**顺序即「记录类型」下拉与顶部 Tab 的展示顺序**。
 *
 * 当前 5 个类型：日常跟进 · IDP沟通 · 学生沟通 · 家校沟通 · 学生观察
 * （IDP沟通 / 学生沟通 于 2026-09-21 新增，前三个共用「日常跟进」的权限点）。
 *
 * `ownFields` 只列**该类型独有**的字段 —— 公共字段（沟通人/沟通主题/沟通时间/沟通总结/
 * 沟通明细/沟通人备注/待办事项/责任人/跟进截止日期/闭环状态/闭环日期/信息敏感级别/
 * 沟通附件清单/沟通时长）所有类型共用，不重复登记。
 */
export const STUDENT_RECORD_TYPES: readonly StudentRecordTypeDef[] = [
  {
    value: '日常跟进',
    moduleKey: 'dailyFollowups',
    legacyPath: '/daily-followups',
    ownFields: [],
  },
  {
    /**
     * IDP沟通（2026-09-21 新增）。峰哥要的：「内容与日常跟进完全相同」。
     *
     * 🔴 `moduleKey` **故意复用 `dailyFollowups`**（不新造 `idpComms` 权限点）：
     *    内容与敏感度都与日常跟进一致 ⇒ 没必要多造一个权限点。新造权限点的代价是
     *    **上线后除管理员外没有任何角色持有它** ⇒ 所有人都看不到这个类型（功能等于不可用），
     *    而且还要额外做：加权限行 + 用 `subOf` 挂到菜单下（不挂的话权限矩阵里**没有这一行可勾**）
     *    + `ROLE_PERMISSION_VERSION + 1` 迁移。
     *    技术依据：`typeAllowedValues()` 是「遍历 `typeModules` 的
     *    `[value, key]` 再判该 key 的权限」⇒ **多个类型值共用同一个 moduleKey 是被支持的**，
     *    持有日常跟进权限的人会同时拿到这两个类型。
     *    将来若真要单独授权（如「IDP 导师能看 IDP沟通、但看不到日常跟进」），再单独加权限点也不迟。
     *
     * `ownFields: []` —— 与日常跟进完全相同，不加专属字段。
     * ⚠️ 注意 `ownFields` 目前**没有任何消费点**（字段显隐由前端 `columns.tsx` 的 `showIf` 决定），
     *    所以这里留空是对的；若哪天 IDP沟通 要加专属字段，改的是前端 `showIf`，不是这里。
     */
    value: 'IDP沟通',
    moduleKey: 'dailyFollowups',
    // 没有独立旧页面（新类型），置空；`legacyPath` 目前也没有消费点（保留 301 重定向用的是各页硬编码的 redirect）
    legacyPath: '',
    ownFields: [],
  },
  {
    /**
     * 学生沟通（2026-09-21 新增，与 IDP沟通 同批）。峰哥要的：「与刚开发的 IDP沟通 一致」。
     *
     * 语义：与学生**本人**的沟通（区别于「家校沟通」= 与家长的沟通）。
     * 字段与日常跟进 / IDP沟通 完全相同（`ownFields: []`），表头词表也共用同一份。
     *
     * 🔴 `moduleKey` 同样**复用 `dailyFollowups`**（理由见上面 IDP沟通 的注释）：
     *    内容与敏感度都与日常跟进一致 ⇒ 不新造权限点。现在 日常跟进 / IDP沟通 / 学生沟通
     *    三个类型共用一个权限点 —— `typeAllowedValues()` 遍历「类型 → moduleKey」判权限，
     *    这三个会一起被放行，这正是我们要的（持有日常跟进权限的人三个都能用）。
     *
     * ⚠️ 与「家校沟通」的区别要清楚：家校沟通 = 家长（`moduleKey: homeSchoolComms`，且是
     *    **家长端/学生端门户唯一会读到**的类型）；学生沟通**不外流**到门户。
     */
    value: '学生沟通',
    moduleKey: 'dailyFollowups',
    legacyPath: '',
    ownFields: [],
  },
  {
    value: '家校沟通',
    moduleKey: 'homeSchoolComms',
    legacyPath: '/home-school-comms',
    ownFields: ['家长', '家长反馈态度', '家长反馈'],
  },
  {
    value: '学生观察',
    moduleKey: 'studentObservations',
    legacyPath: '/student-observations',
    ownFields: ['观察类型'],
  },
];

/** 类型取值 → 模块 key */
export const STUDENT_RECORD_TYPE_TO_MODULE: Record<string, string> = Object.fromEntries(
  STUDENT_RECORD_TYPES.map((t) => [t.value, t.moduleKey]),
);

/**
 * 类型取值数组（顺序同 `STUDENT_RECORD_TYPES`）。
 *
 * 用途有两个，都是为了避免「手抄第二份」：
 *  - 前端文案（页面副标题、AI 上下文提示语）由它生成 ⇒ 以后再加类型不必改文案；
 *  - 单测断言它与**字典取值**逐项相等（那两份是手抄同步的，漏改一处就会出现
 *    「Tab 里有、下拉里没有」这类静默不一致）。
 */
export const STUDENT_RECORD_TYPE_VALUES: readonly string[] = STUDENT_RECORD_TYPES.map((t) => t.value);

/** 三个类型的模块 key（供白名单/遍历用） */
export const STUDENT_RECORD_MODULE_KEYS: readonly string[] = STUDENT_RECORD_TYPES.map((t) => t.moduleKey);

/**
 * 是否持有「任一类型」的指定动作权限。
 *
 * 用途：合并后的主入口（菜单 / 接口）需要一个「能进吗」的判据，而它不应对应
 * 任何单一模块 —— 见文件头关于「为什么要任一即可」的说明。
 */
export function anyStudentRecordPerm(perms: readonly string[] | undefined | null, action: ModuleAction): boolean {
  const list = perms ?? [];
  return STUDENT_RECORD_MODULE_KEYS.some((k) => list.includes(modulePermission(k, action)));
}

/** 取某类型值对应的模块 key；未知类型返回 undefined */
export function moduleKeyOfRecordType(value: unknown): string | undefined {
  return STUDENT_RECORD_TYPE_TO_MODULE[String(value ?? '')];
}
