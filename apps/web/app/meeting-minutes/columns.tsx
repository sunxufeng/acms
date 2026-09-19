import type { CrudColumn } from '../../components/CrudPage';
import { enrichFromNotes, type NoteAutoFillSpec } from '../../lib/noteAutoFill';
// 「可见范围」的取值与字段名来自 contracts —— 后端判据用的是**同一份**定义
// （apps/api/src/meeting-minutes/meeting-visibility.ts），两边各写一份必然漂移。
import {
  MEETING_VISIBILITY_FIELD,
  MEETING_VISIBILITY_SCOPES,
  MEETING_VISIBLE_DEPTS_FIELD,
  MEETING_VISIBLE_USERS_FIELD,
} from '@acms/contracts';

/**
 * 日期显示：SQL 自建表没有飞书字段元数据，日期字段读出来是毫秒时间戳（number），
 * 直接渲染会显示成一串数字，这里统一格式化。
 */
function fmtTime(v: unknown, withTime: boolean): string {
  if (v == null || v === '') return '—';
  const raw = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(v) : new Date(String(v)).getTime();
  if (!raw || Number.isNaN(raw)) return String(v);
  const d = new Date(raw);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

/**
 * 表单分区（`CrudColumn.section`）—— 与「学生记录」同一套分区模型。
 *
 * 为什么分区（2026-09-19）：改版前 19 个字段平铺在三列网格里，「会前要定的」和
 * 「会后补的」混在一起，参会名单与可见性这类语义差别很大的字段也只能靠字段名去认。
 */
const SEC_BASE = '基本信息';
const SEC_TIME = '会议时间';
const SEC_ATTEND = '参会人员';
const SEC_CONTENT = '内容与留痕';
const SEC_SCOPE = '可见性';

/** 表单联动所需的运行期数据（由页面层喂进来，列定义自己不去拉数据） */
export interface MeetingColumnCtx {
  /**
   * 部门 id → 该部门**含下级**的成员姓名。
   *
   * 「选了部门 → 参会人员默认选中部门下的人」靠它。含下级是刻意的：
   * 选「学术轨」时就该叫上三个中心的人（学术轨直系只有 1 人、含子树约 11 人）。
   */
  deptMembers: Record<string, string[]>;
  /**
   * 被**手动**从「参会人员」里删掉的人 —— 再改部门时不自动加回。
   *
   * 用 ref 而不是 state：它只在事件回调里读写，不需要触发重渲染；
   * 每次用户改「参会人员」时按「当前部门本应带出的人 − 现有名单」重算。
   */
  manuallyRemoved: { current: Set<string> };
  /**
   * 当前用户**所属**的部门 id —— 「指定部门可见」时的默认选中值。
   * 放在这里而不是 `createDefaults`：那个是**打开表单时**写一次的初值，
   * 而用户中途把可见范围改成「指定部门可见」时也需要这个兜底。
   */
  myDeptIds: string[];
}

const EMPTY_CTX: MeetingColumnCtx = { deptMembers: {}, manuallyRemoved: { current: new Set() }, myDeptIds: [] };

/**
 * 会议纪要列定义。
 *
 * 结构照搬「日常跟进」，但主体从「学生」换成「部门」：
 *  - 沟通方式 → 会议类型（字典：周会 / 月度会议 / 年中会 / 临时会议 …）
 *  - 沟通主题 → 会议议题
 *  - 沟通时间 → 会议时间（列表排序与范围筛选字段，另有开始/结束时间存具体时刻）
 *  - 沟通明细 / 沟通总结 → 会议明细 / 会议总结（详情页只读展示）
 *  - 待办事项 → 待办事宜
 * 飞书字段名即 key，与后端 lifecycle.meta.ts 的 dateFields / timeRange / rangeField 严格对齐。
 *
 * 做成函数（而不是常量）是为了把**联动所需的数据**注入进来：详情页只读、不需要联动，
 * 直接 `buildMeetingColumns()` 即可（用空配置）。
 */
export function buildMeetingColumns(ctx: MeetingColumnCtx = EMPTY_CTX): CrudColumn[] {
  const { deptMembers, manuallyRemoved, myDeptIds } = ctx;

  /** 所选部门（含下级）应带出的全部成员姓名 */
  const autoNames = (depts: unknown): string[] => {
    const ids = (Array.isArray(depts) ? depts : depts ? [depts] : []).map((d) => String(d ?? ''));
    const out: string[] = [];
    for (const id of ids) for (const n of deptMembers[id] ?? []) if (!out.includes(n)) out.push(n);
    return out;
  };

  return [
    {
      key: '部门',
      label: '部门',
      width: '170px',
      form: true,
      /**
       * 「部门」自 2026-09-19 起改为**多选部门树**（原来是个单行输入框，且只能选一个）。
       *
       * 为什么用 `link` + `linkSource: 'departments'` 这套现成口径，而不是自造字段类型：
       *  · 后端 `linkFields` 机制现成 —— 写入存 **id 数组**、读取注入 `部门__link`（原始 id）
       *    并把展示值解析成部门名。零后端改动。
       *  · `linkSource: 'departments'` 的候选值就是**部门 open_department_id**，
       *    与可见性判据用的是同一种值形态（id），改名、重名都不会串台。
       *
       * ⚠️ 配套改动（漏一个就出问题）：
       *  ① `lifecycle.meta.ts` 的 `multi` 与 `linkFields` 都要登记「部门」——
       *     漏了 multi 会被当**字符串**写库；漏了 linkFields 则 `__link` 不注入、编辑时回显为空。
       *  ② 可见性判据必须同批改（见 meeting-visibility.ts 的 ③）：原来「部门内可见」是拿
       *     **部门名做等值匹配**，字段改成数组后那个条件**永远不命中** ⇒ 记录对同事全部隐身，
       *     且不报任何错（创建者靠另一条分支还能看到，所以只有同事说「看不到」才会暴露）。
       *  ③ 历史数据要回填（部门名 → id 数组）。
       */
      type: 'link',
      linkSource: 'departments',
      linkMulti: true,
      deptTree: true,
      required: true,
      filter: true,
      listOrder: 1,
      section: SEC_BASE,
      hint: '勾选部门后，该部门（含下级部门）的成员会自动加入「参会人员」，可见范围也会默认为「部门内可见」',
      /**
       * 选部门后的联动（峰哥明确要求的三条）：
       *  ① 该部门（含下级）的成员**自动加入参会人员**（已手动删掉的不加回）
       *  ② 可见范围置为「部门内可见」—— 但**用户自己改过就不覆盖**（判断方式见下）
       *  ③ 可见部门 = 所选部门（判据只认「可见部门」，这一步不做的话记录会隐身）
       *
       * 为什么用「可见范围当前值」判是否被改过，而不是记一个 touched 标志：
       * 表单初值就是「部门内可见」（defaultFirstOption），所以「值仍是它」≈「用户没动过」；
       * 一旦用户改成公开/指定用户/仅自己可见，就不再自动覆盖他的选择。规则可解释、无需额外状态。
       */
      onChangePatch: (next, form) => {
        const depts = Array.isArray(next) ? next.map(String) : [];
        const patch: Record<string, unknown> = {};

        const scope = String(form[MEETING_VISIBILITY_FIELD] ?? '');
        if (!scope || scope === '部门内可见') {
          patch[MEETING_VISIBILITY_FIELD] = '部门内可见';
          // 「可见部门」跟随「部门」—— 用户不用再选一遍；判据拿的就是它
          patch[MEETING_VISIBLE_DEPTS_FIELD] = depts;
        } else if (scope === '指定部门可见') {
          // 用户要「指定部门可见」但还没挑可见部门 ⇒ 顺手填上所选部门（已挑过就不动）
          const cur = form[MEETING_VISIBLE_DEPTS_FIELD];
          if (!(Array.isArray(cur) && cur.length > 0)) patch[MEETING_VISIBLE_DEPTS_FIELD] = depts;
        }

        // 参会人员：并入部门成员（尊重手工删除）
        if (depts.length) {
          const curA = Array.isArray(form['参会人员'])
            ? (form['参会人员'] as unknown[]).map(String)
            : String(form['参会人员'] ?? '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
          const add = autoNames(depts).filter((n) => !curA.includes(n) && !manuallyRemoved.current.has(n));
          if (add.length) patch['参会人员'] = [...curA, ...add];
        }
        return patch;
      },
      render: (_v, row) => {
        const name = deptName(row);
        if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        return <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{name}</span>;
      },
    },
    { key: '会议类型', label: '会议类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '会议类型', required: true, listOrder: 2, section: SEC_BASE },
    // 筛选区去掉「会议议题」（自由文本，逐字筛命中率低、把筛选区撑得很长）；
    // 列表列与表单字段都保留，仍可用顶部搜索框按关键字检索（q 走 searchFields）
    { key: '会议议题', label: '会议议题', width: '180px', form: true, required: true, listOrder: 3, section: SEC_BASE },
    // 筛选区去掉「会议地点」
    { key: '会议地点', label: '会议地点', width: '120px', form: true, listOrder: 7, section: SEC_BASE },
    {
      key: '会议时间',
      label: '会议时间',
      width: '120px',
      form: true,
      type: 'date',
      required: true,
      listOrder: 4,
      section: SEC_TIME,
      render: (v) => fmtTime(v, false),
    },
    {
      key: '开始时间',
      label: '开始时间',
      width: '150px',
      form: true,
      type: 'datetime',
      listOrder: 5,
      section: SEC_TIME,
      render: (v) => fmtTime(v, true),
    },
    {
      key: '结束时间',
      label: '结束时间',
      width: '150px',
      form: true,
      type: 'datetime',
      listOrder: 6,
      section: SEC_TIME,
      // 结束时间必须晚于开始时间（后端 meta.timeRange 也会校验，这里只是给录入提示）
      hint: '结束时间须晚于开始时间',
      render: (v) => fmtTime(v, true),
    },
    { key: '主持人', label: '主持人', width: '100px', form: true, type: 'person', listOrder: 8, section: SEC_TIME },
    { key: '记录人', label: '记录人', width: '100px', list: false, form: true, type: 'person', section: SEC_TIME },
    // 参会 / 缺席 / 列席：**多选人员**（候选来自 `/users/names`，**存姓名数组** ——
    // 与单选的「主持人 / 记录人」同口径，便于互相对照；外部人员暂不支持，见 issue 说明）
    // 三者都改用「可搜索多选」控件：原先是把 28 个候选**全部铺成一堆复选框**，
    // 三列合计 84 个，表单被撑到三屏以上，选人只能一个个找。
    { key: '参会人员', label: '参会人员', width: '160px', list: false, form: true, type: 'person', linkMulti: true, section: SEC_ATTEND, hint: '选择部门后会自动带出该部门（含下级）的成员，可再逐个取消',
      /**
       * 记录「被手动删掉的人」—— 再改部门时不把他自动加回。
       * 算法：当前部门**本应**带出的人 − 现在名单里有的人 = 用户手工移除的。
       * 每次改动都整体重算（而不是累加），所以把某人手动加回来也能立刻纠正。
       */
      onChangePatch: (next, form) => {
        const cur = Array.isArray(next) ? next.map(String) : [];
        const should = autoNames(form['部门']);
        manuallyRemoved.current = new Set(should.filter((n) => !cur.includes(n)));
        return {};
      },
    },
    { key: '缺席人员', label: '缺席人员', width: '160px', list: false, form: true, type: 'person', linkMulti: true, section: SEC_ATTEND },
    { key: '列席人员', label: '列席人员', width: '160px', list: false, form: true, type: 'person', linkMulti: true, section: SEC_ATTEND },
    // 会议总结放在会议明细之前：先看清结论，再看原始记录
    { key: '会议总结', label: '会议总结（纪要）', list: false, form: true, type: 'markdown', section: SEC_CONTENT },
    {
      key: '会议明细',
      label: '会议明细（MD 会议记录）',
      list: false,
      form: true,
      type: 'markdown',
      // 原始记录属正式留痕，用**专项权限**控制（比模块读写权限更严格）：
      // 无 md:edit 只能浏览，无 md:import 不显示「MD导入」按钮
      mdEditPerm: 'md:edit',
      mdImportPerm: 'md:import',
      section: SEC_CONTENT,
    },
    { key: '待办事宜', label: '待办事宜', list: false, form: true, type: 'textarea', section: SEC_CONTENT },
    /**
     * 会议附件（2026-09-18 新增）。
     *
     * 用途：从「我的笔记」转出会议纪要时，笔记的**原始录音**一并写进这个字段，
     * 于是会议纪要页里能直接播放当时那段录音。会议纪要是笔记转换最热门的目标
     * （历史 5 条转换记录里有 3 条转到会议纪要），而原表没有任何附件字段 ⇒ 录音无处可放。
     *
     * 存储结构照搬其它沟通模块的「沟通附件清单」：文本列存 `[{file_token,name,size,type}]` 的 JSON，
     * 前端按 `type: 'attachment'` 渲染（音频会自动出内联播放器，见 CrudPage 的 isAudioFile）。
     */
    { key: '会议附件', label: '会议附件', width: '220px', list: false, form: true, type: 'attachment', section: SEC_CONTENT },
    {
      key: '状态',
      label: '状态',
      width: '100px',
      filter: true,
      form: true,
      type: 'select',
      dictKey: '会议状态',
      listOrder: 9,
      section: SEC_SCOPE,
    },
    {
      key: MEETING_VISIBILITY_FIELD,
      label: '可见范围',
      width: '120px',
      form: true,
      required: true,
      type: 'select',
      listOrder: 10,
      section: SEC_SCOPE,
      /**
       * 🔴 这里用**静态 options**，不要改成字典。
       *
       * 四个取值与后端判据的分支是**字面量硬绑定**的（`meeting-visibility.ts` 里按 '公开' /
       * '部门内可见' / '指定用户可见' / '仅自己可见' 分别匹配）。而字典的真源是生产
       * `data/dictionaries.json`、运行时可改 —— 一旦有人改了选项文案，后端判据就全部落空，
       * 结果是**所有记录对所有人隐身**（含创建者自己），且不报任何错。
       * 凡是与代码逻辑耦合的枚举，一律固化在代码里（定义在 contracts/src/meeting.ts）。
       */
      options: [...MEETING_VISIBILITY_SCOPES],
      /**
       * 默认选中第一项（=「部门内可见」）。
       *
       * 为什么必须给默认值：可见范围留空的记录，后端判据**一支都不命中** ⇒ 对所有人隐身。
       * 这个后果比「选错范围」严重得多（选错至少自己还能看见），所以用 `defaultFirstOption`
       * 保证新建时一定有值。
       */
      defaultFirstOption: true,
      filter: true,
      /**
       * 用户把范围改回「部门内可见」时，可见部门跟着「部门」字段走 ——
       * 否则会留下上一个范围选的部门 id，判据按旧值放行（看起来「范围改了却没生效」）。
       */
      onChangePatch: (next, form) => {
        const v = String(next ?? '');
        if (v === '部门内可见') {
          const depts = form['部门'];
          return { [MEETING_VISIBLE_DEPTS_FIELD]: Array.isArray(depts) ? depts : [] };
        }
        if (v === '指定部门可见') {
          // 默认选中「我所属的部门」（与改版前的 createDefaults 行为一致），用户可改
          const cur = form[MEETING_VISIBLE_DEPTS_FIELD];
          if (!(Array.isArray(cur) && cur.length > 0)) return { [MEETING_VISIBLE_DEPTS_FIELD]: myDeptIds };
        }
        return {};
      },
    },
    {
      key: MEETING_VISIBLE_USERS_FIELD,
      label: '可见用户',
      width: '150px',
      list: false,
      form: true,
      // 多选用户：value = 用户表 record id，label = 姓名（与「邮件账户 / 知识库配置」的关联用户同款控件）
      type: 'link',
      linkMulti: true,
      linkSource: 'users',
      // 只在「可见范围 = 指定用户可见」时出现（CrudPage 的 showIf = 表单条件显隐）
      showIf: (f) => String(f[MEETING_VISIBILITY_FIELD] ?? '') === '指定用户可见',
      hint: '不选人的话，这条纪要只有你自己和系统管理员能看到',
      section: SEC_SCOPE,
    },
    {
      key: MEETING_VISIBLE_DEPTS_FIELD,
      label: '可见部门',
      width: '150px',
      list: false,
      form: true,
      // 多选部门：value = 部门的 open_department_id（**不是部门名** —— 判据要免疫重名与改名），
      // label = 部门名。存储与判据口径见 contracts/src/meeting.ts 的说明。
      type: 'link',
      linkMulti: true,
      linkSource: 'departments',
      deptTree: true,
      /**
       * 只在「指定部门可见」时**手选**。
       *
       * ⚠️ 「部门内可见」时这一栏不显示 —— 但**不代表它没值**：可见部门会由上面的「部门」字段
       * 自动派生（前端联动 + 后端 `meetingDefaults` 兜底），因为判据只认「可见部门」。
       * 让用户再选一遍是多余动作（他已经在「部门」里选过了），所以这里直接隐藏。
       */
      showIf: (f) => String(f[MEETING_VISIBILITY_FIELD] ?? '') === '指定部门可见',
      hint: '默认选中你自己所属的部门；被选中部门（含其下级部门）里的人都能看到',
      section: SEC_SCOPE,
    },
    {
      key: '敏感级别',
      label: '敏感级别',
      width: '100px',
      list: false,
      filter: true,
      form: true,
      type: 'select',
      dictKey: '信息敏感级别',
      section: SEC_SCOPE,
    },
    ];
}

/**
 * 只读 / 无需联动的场景（详情页、列表页的默认导出）用的列定义。
 * 页面要联动时用 `buildMeetingColumns({ deptMembers, manuallyRemoved })`。
 */
export const COLUMNS = buildMeetingColumns();

/**
 * 从「会议总结 / 会议明细」文本里抽取结构化字段，供**笔记转换预填**使用。
 *
 * 解析实现统一在 `lib/noteAutoFill.ts`（与日常跟进 / 家校沟通 / 学生观察共用一套工具），
 * 这里只声明会议纪要特有的字段规则。
 *
 * 为什么用规则而不是调 AI：
 *  - 转换是高频动作，每次都打一次模型既慢又费额度，还依赖用户自己的 AI 配置；
 *  - Get笔记 的总结有稳定套路（「会议主题：」「参会人员：」这类标题行），规则命中率足够；
 *  - 规则零依赖、可预测，抽错了用户一眼能看出来并在表单里改。
 *
 * ⚠️ 只填**表单里真实存在且当前为空**的字段，已有值（笔记映射写进来的）不覆盖。
 */
const MEETING_SPEC: NoteAutoFillSpec = {
  sourceKeys: ['会议总结', '会议明细'],
  patterns: [
    { key: '会议议题', patterns: [/会议议题\s*[:：]\s*(.+)/, /会议主题\s*[:：]\s*(.+)/, /议题\s*[:：]\s*(.+)/, /主题\s*[:：]\s*(.+)/] },
    { key: '会议地点', patterns: [/会议地点\s*[:：]\s*(.+)/, /地点\s*[:：]\s*(.+)/] },
    { key: '主持人', patterns: [/主持人\s*[:：]\s*(.+)/, /主持\s*[:：]\s*(.+)/] },
    { key: '记录人', patterns: [/记录人\s*[:：]\s*(.+)/, /纪要员\s*[:：]\s*(.+)/] },
    { key: '参会人员', patterns: [/参会人员\s*[:：]\s*(.+)/, /出席人员\s*[:：]\s*(.+)/, /参会\s*[:：]\s*(.+)/, /出席\s*[:：]\s*(.+)/] },
    { key: '缺席人员', patterns: [/缺席人员\s*[:：]\s*(.+)/, /缺席\s*[:：]\s*(.+)/, /请假\s*[:：]\s*(.+)/] },
    { key: '列席人员', patterns: [/列席人员\s*[:：]\s*(.+)/, /列席\s*[:：]\s*(.+)/] },
  ],
  // 「会议时间」在表单里是 type='date'，只填 YYYY-MM-DD（带时刻会渲染成空框）
  dateKeys: [{ key: '会议时间', keywords: ['会议时间', '会议日期', '时间', '日期'] }],
  // 起止时刻是 type='datetime'，拼成 YYYY-MM-DDTHH:mm
  ranges: [
    { key: '开始时间', timeKeywords: ['开始时间', '会议开始', '开始'] },
    { key: '结束时间', timeKeywords: ['结束时间', '会议结束', '结束'] },
  ],
};

export function parseMeetingFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string; noteOwner?: string },
): Record<string, unknown> {
  // 「主持人 / 记录人」默认取**源笔记归属人**（会议纪要通常就是主持人或记录人自己录的），
  // 拿不到才回退登录用户 —— 管理员代转别人的笔记时，用登录用户会把这两个字段写成自己。
  // ⚠️ 只默认这两个**单人**字段：「参会 / 缺席 / 列席」是多人名单，默认塞一个人反而错。
  const owner = ctx?.noteOwner || ctx?.userName || '';
  return enrichFromNotes(values, MEETING_SPEC, { 主持人: owner, 记录人: owner });
}

export function deptName(row: Record<string, unknown>): string {
  const v = row['部门'];
  // 走 link 字段后，读取时已被后端 `resolveLinks` 解析成部门名拼接串（多个用「、」连接）
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (first && typeof first === 'object') return String((first as { text?: string }).text ?? '');
    return String(first ?? '');
  }
  if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v ?? '');
}
