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
 * 🔴 为什么权限要「任一类型权限即可」：
 *    合并前每个模块各有自己的权限点，角色配置里存的就是那三个。
 *    若主入口只认新权限点，则合并后**没有任何角色能进入**（生产实测：24 人的主力角色
 *    Phase1 只有 `module:studentObservations:*`，没有 dailyFollowups/homeSchoolComms），
 *    等于把「看得见」降级成「看不见」。所以：
 *      - 接口侧：`typeScope` 存在时，读权限按「任一类型模块的 read」判定，命中即放行；
 *      - 菜单侧：同理由 `anyStudentRecordPerm` 判定；
 *      - 内容侧：具体能看到哪些**类型**，仍由各自的 module 权限逐类型过滤（不放大范围）。
 *    这样**一个角色的配置都不用改**，权限语义也不降级。
 *
 * 🔴 反向的一半（2026-09-21 修）：矩阵里「学生记录」这一行是**可真勾的**，
 *    角色管理里勾它会写入 `module:studentRecords:<action>`。而运行时原先完全忽略它 ——
 *    被这样授权的角色（生产实测 Phase3~Phase8 六个班主任角色，对应 3 位老师）
 *    列表 403 / 新建 403 / 菜单也不显示，**勾了等于没勾，还不报错**。
 *    现在两个来源都认：三个类型模块的点（老配置）**或**合并入口的点（矩阵里勾的那一行，
 *    语义 = 全部类型）。这也是「容器行 → 明细行」两级配置的既有做法。
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
 * 当前 6 个类型：日常跟进 · IDP沟通 · 学生沟通 · 学生实践 · 家校沟通 · 学生观察
 * （IDP沟通 / 学生沟通 于 2026-09-21 新增，学生实践 于 2026-09-26 新增；
 *  这四个与日常跟进**共用它的权限点**，字段也完全相同，只靠「记录类型」区分。）
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
    /**
     * 学生实践（2026-09-26 新增）。峰哥要的：「和学生沟通都一样，只是类型是学生实践」。
     *
     * 语义：学生在**实践类安排**（项目/实习/社会活动等）上的沟通与记录。
     * 字段与 日常跟进 / IDP沟通 / 学生沟通 完全相同（`ownFields: []`，共用同一份表头词表）——
     * 它记的是"围绕实践这件事的沟通记录"，**不是**「实践活动」模块：
     * 后者是独立表（`TABLES.practiceActivity` / `/practice-activities`），字段骨架完全不同
     * （活动名称/活动类型/活动地点/学生角色/服务或参与时长/安全确认状态…，且学生关联走
     * 「关联学生编号」按 ID）。2026-09-18 的合并设计明确把它留在独立表，本次不动它。
     * ⚠️ 两者的中文名只差一个字，排查时先看清是在哪个模块（菜单分组也不同）。
     *
     * 🔴 `moduleKey` 同样**复用 `dailyFollowups`**（理由同 IDP沟通 / 学生沟通）：
     *    内容与敏感度一致 ⇒ 不新造权限点。新造一个的代价是**上线后除管理员外没有任何角色持有**
     *    ⇒ 所有人 Tab 里看不到这个类型、下拉里也选不到（功能等于没上线），还要额外加权限行 +
     *    `subOf` 挂菜单（不挂则矩阵里没有这一行可勾）+ `ROLE_PERMISSION_VERSION + 1` 迁移。
     *    技术依据：`typeAllowedValues()` 遍历「类型 → moduleKey」再判该 key 的权限，
     *    **多个类型值共用一个 moduleKey 是被支持的**，持有日常跟进权限的人会一起拿到。
     *    将来若要单独授权（如"实践导师能看学生实践、看不到日常跟进"），再单独加权限点也不迟。
     *
     * ⚠️ 「学生实践」**不外流到门户**：家长端/学生端按类型字面量只放 `家校沟通`
     *    （见 `portal-visibility.ts`），所以这个类型家长与学生都看不到。符合预期。
     */
    value: '学生实践',
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
 * 合并入口本身的模块 key —— 权限矩阵里「学生记录」那一行、菜单 key 也是它。
 *
 * 🔴 它的动作权限**必须是有效的**（2026-09-21 修）：矩阵给这一行画了可勾的格子，
 *    管理员勾了它才算授权；但运行时判据原先只看三个**类型**模块的点，
 *    于是「勾了学生记录、没勾三个类型」的角色（生产实测 Phase3~Phase8 六个班主任角色）
 *    列表 403、新建 403、菜单也不显示 —— 授权是空的，而且不报错。
 *    现在 `typeAllowedValues()` 把它当「全类型」授权处理（见 `allTypesModuleKey`）。
 */
export const STUDENT_RECORD_ENTRY_KEY = 'studentRecords';

/**
 * 合并**前**的三个菜单 key（与三个类型模块同名）。
 *
 * 用途：角色「菜单白名单」里存的是合并前的老 key，而菜单配置里已经没有它们了
 * （`studentObservations` 等），若严格按新 key 判，合并前能看到这些记录的角色的主入口
 * 会**永久消失**（2026-09-21 实测 Phase1 招生老师 14 人）。见 `studentRecordMenuVisible`。
 */
export const STUDENT_RECORD_LEGACY_MENU_KEYS: readonly string[] = [...new Set(STUDENT_RECORD_MODULE_KEYS)];

/**
 * 是否持有「任一类型」的指定动作权限。
 *
 * 用途：合并后的主入口（菜单 / 接口）需要一个「能进吗」的判据，而它不应对应
 * 任何单一模块 —— 见文件头关于「为什么要任一即可」的说明。
 *
 * 两个来源，命中任一即算：
 *   ① 三个**类型**模块的点（合并前的老配置，如 `module:studentObservations:read`）；
 *   ② 合并入口自己的点（矩阵里「学生记录」那一行的格子）。
 */
export function anyStudentRecordPerm(perms: readonly string[] | undefined | null, action: ModuleAction): boolean {
  const list = perms ?? [];
  if (list.includes(modulePermission(STUDENT_RECORD_ENTRY_KEY, action))) return true;
  return STUDENT_RECORD_MODULE_KEYS.some((k) => list.includes(modulePermission(k, action)));
}

/** 取某类型值对应的模块 key；未知类型返回 undefined */
export function moduleKeyOfRecordType(value: unknown): string | undefined {
  return STUDENT_RECORD_TYPE_TO_MODULE[String(value ?? '')];
}

/**
 * 三合一记录表的**导出键**（`TABLES` 的键，= 那张唯一物理表）。
 *
 * 为什么要有这个常量：导出页的「三合一」条目不再是「一个表键 = 一类记录」，
 * 而是**同一个表键 + 一个「记录类型」参数**（`/export/dailyFollowup?记录类型=家校沟通`）。
 * 前端拼 URL、后端解析都用这一份，别各写一个字面量。
 * 兼容：`/export/homeSchoolComm`、`/export/studentObservation` 这两个**合并前的**键
 * 仍被识别（后端映射到本表 + 各自的默认类型）——它们原先指向的旧表生产实测已 0 行。
 */
export const STUDENT_RECORD_EXPORT_KEY = 'dailyFollowup';

/** 「记录类型」查询参数里表示「全部类型」的取值（仍受该用户的类型权限约束） */
export const STUDENT_RECORD_EXPORT_ALL = '全部';

/**
 * 「学生记录」菜单项是否对当前用户可见 —— **唯一判据**（AppShell 调它，别在页面里再写一份）。
 *
 * 三层，缺一层就有一类人看不到菜单：
 *   ① 权限：任一类型 read **或** 合并入口 read（`anyStudentRecordPerm`）；
 *   ② 角色菜单白名单（仅收敛，不放大权限）；
 *   ③ 白名单**兼容合并前的旧 key** —— 老白名单里存的是 `studentObservations` /
 *      `dailyFollowups` / `homeSchoolComms`，菜单里已经没这几项了；严格按新 key 判
 *      等于「合并前看得到这三个菜单的角色，合并后主入口永久隐藏」。
 *      这不是猜测：2026-09-21 实测 Phase1（招生老师-基础，14 人）白名单里正是
 *      `studentObservations`，而权限齐全 —— 他们能看到记录却找不到入口。
 */
export function studentRecordMenuVisible(input: {
  perms?: readonly string[] | null;
  /** 角色菜单白名单；空 / 缺省 = 不额外限制 */
  menus?: readonly string[] | null;
}): boolean {
  if (!anyStudentRecordPerm(input?.perms, 'read')) return false;
  const menus = input?.menus;
  if (!menus?.length) return true;
  if (menus.includes(STUDENT_RECORD_ENTRY_KEY)) return true;
  return STUDENT_RECORD_LEGACY_MENU_KEYS.some((k) => menus.includes(k));
}
