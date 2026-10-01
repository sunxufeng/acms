import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  CODE_CONFLICT_STRATEGIES,
  CODE_DATE_FORMATS,
  CODE_FIELD_TRANSFORMS,
  CODE_MAP_MATCHES,
  CODE_RESET_CYCLES,
  CODE_RESET_SCOPES,
  CODE_RESET_CYCLE_LABEL,
  CODE_RESET_SCOPE_LABEL,
  CODE_SEGMENT_KINDS,
  CODE_SEGMENT_LABEL,
  CODE_CONFLICT_LABEL,
  CODE_DATE_FORMAT_LABEL,
  CODE_FIELD_TRANSFORM_LABEL,
  CODE_MAP_MATCH_LABEL,
  CODE_RULE_TARGETS,
  DEFAULT_CODE_RULE_CONFIG,
  TABLES,
  codeRuleConflicts,
  generateCode,
  normalizeCodeRuleConfig,
  type CodeRule,
  type CodeRuleConfig,
  type CodeFillPreview,
  type CodeFillRow,
  type CodeRulesView,
  type CodeSample,
  type SessionUser,
} from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { requireModule } from '../shared/require-module.js';

/**
 * 「代码规则」——编号的生成规则可配（v14，2026-10-01 峰哥）。
 *
 * ── 存法（照「卫瓴映射」/「信号规则」，**不新造表**）────────────────
 * 系统配置表一行 + 固定 id 的 `createWithId`（整体替换 ⇒ 天然 upsert，不会写出重复行）。
 * 🔴 为什么不新建 `code_rules` 表：设计稿里写的是新建表，但这套系统里"单行 JSON 配置"
 *    已经有三个先例（homepage_config / student_support_config / weiling_mapping_config），
 *    它们的共同点是**只有一行、整体替换、读多写少**。再开一张表要多一次 tableId 登记、
 *    多一套建表脚本、多一次"生产有没有这张表"的核对，收益为零。
 *    ⚠️ 哪天要"按规则逐条增删 + 查历史版本"再升级成表。
 *
 * ── 三条硬约束 ──────────────────────────────────────────────────
 * ① 读配置**逐项回落默认、绝不抛错**（配置读坏了也得能建学生，否则新建记录整条链路挂）
 * ② 存进去的必须是**归一化后**那份（界面显示的和判据用的是同一份）
 * ③ 「新建时留空才自动生成」= K1；**绝不覆盖已有值**（学籍号是登录凭证，
 *    追溯改号 = 有人登不上系统）
 */
@Injectable()
export class CodeRulesService {
  private readonly logger = new Logger(CodeRulesService.name);

  /** 系统配置表里的配置键（与 homepage_config / weiling_mapping_config 同族） */
  private static readonly CONFIG_KEY = 'code_rules_config';
  /** 配置行的固定 id（`createWithId` 整体替换 ⇒ 天然 upsert） */
  private static readonly CONFIG_ID = 'cfg_code_rules';

  /**
   * ⚠️ **不注入 DictService** —— 与设计稿写的不一样，这是有意的。
   *
   * 设计稿说「字段映射段的候选必须从字典读」。但真去对数据会发现对不上：
   * 映射的**键**必须与**记录里实际存的值**逐字一致，而存量学籍号里那个键是
   * `26秋季` / `25春季` —— **任何字典里都没有这种值**（它是"年份+季节"的拼串）。
   * 从字典拿候选 ⇒ 列出一堆选项、配完一个都命中不了，而且**不报错**（生成出来的号少一截）。
   *
   * ⇒ 候选改为来自**真实取值分布**（`fieldValues`，见下），并且每项带出现次数：
   *    老师能看到"这个值在 43 条数据里出现过"，配起来一眼就知道该不该配。
   *    （对真正的字典字段如「校区」，真实取值分布同样是对的候选 —— 字典里有的值，
   *      记录里也一定有；反之记录里可能还有字典外的历史值 D，那更需要被看到。）
   */
  constructor() {}

  // ══════════════════════════════════════════════════════════════
  // 配置读写
  // ══════════════════════════════════════════════════════════════

  async loadConfig(): Promise<CodeRuleConfig> {
    try {
      const sql = getSqlStore();
      if (!sql) return DEFAULT_CODE_RULE_CONFIG;
      const rec = (await sql.get(TABLES.systemConfig.tableId, CodeRulesService.CONFIG_ID)) as
        | { fields?: Record<string, unknown> }
        | null;
      const raw = rec?.fields?.['配置值'];
      if (!raw) return DEFAULT_CODE_RULE_CONFIG;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (!text.trim()) return DEFAULT_CODE_RULE_CONFIG;
      return normalizeCodeRuleConfig(JSON.parse(text));
    } catch (e) {
      this.logger.warn(`代码规则配置读取失败，回落默认：${(e as Error).message}`);
      return DEFAULT_CODE_RULE_CONFIG;
    }
  }

  /**
   * 保存配置（整体替换）。
   *
   * 🔴 变更前后都打日志：改一次影响**以后所有新记录的编号**，
   *    而出问题时（"新学生的学籍号怎么长这样"）要能查到是谁、什么时候改的。
   */
  async save(user: SessionUser, body: unknown): Promise<CodeRulesView> {
    requireModule(user, 'codeRules', 'update');
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    const before = await this.loadConfig();
    const config = normalizeCodeRuleConfig(body);
    await sql.createWithId(TABLES.systemConfig.tableId, CodeRulesService.CONFIG_ID, {
      配置键: CodeRulesService.CONFIG_KEY,
      配置值: JSON.stringify(config),
      分组: '系统配置',
      说明: '代码规则：学籍号等自动编号的段式规则（JSON）',
      状态: '启用',
      更新人: String(user.name ?? '').trim() || '系统',
      更新时间: Date.now(),
    });
    const changed = config.rules
      .filter((r) => JSON.stringify(before.rules.find((x) => x.key === r.key) ?? null) !== JSON.stringify(r))
      .map((r) => `${r.name}(${r.enabled ? '启用' : '停用'})`);
    this.logger.log(`代码规则已更新：${changed.join('、') || '无实质变化'}；操作人 ${user.name ?? ''}`);
    return this.view(config);
  }

  // ══════════════════════════════════════════════════════════════
  // 页面视图（读 / 试算 / 保存后 共用同一份，保证三处看到的一致）
  // ══════════════════════════════════════════════════════════════

  async get(user: SessionUser): Promise<CodeRulesView> {
    requireModule(user, 'codeRules', 'read');
    return this.view(await this.loadConfig());
  }

  /** 用提交的规则试算（**不保存**）—— 与 `save` 走同一个 normalize ⇒ 预览即所得 */
  async preview(user: SessionUser, body: unknown): Promise<CodeRulesView> {
    requireModule(user, 'codeRules', 'read');
    const incoming = (body ?? {}) as Record<string, unknown>;
    const base = await this.loadConfig();
    // 只替换 body 里带的规则，其余保持当前配置 —— 否则"只想试一下学籍号"会把别的规则也重置
    const merged = Array.isArray(incoming.rules)
      ? normalizeCodeRuleConfig({ rules: [...base.rules.filter((r) => !isPresent(incoming.rules, r.key)), ...(incoming.rules as unknown[])] })
      : base;
    return this.view(merged);
  }

  private async view(config: CodeRuleConfig): Promise<CodeRulesView> {
    const ctx = await this.dataset();
    const rules = config.rules.map((rule) => {
      const preview = this.previewOf(rule, ctx, rule.targetField, 6);
      return {
        ...rule,
        preview,
        existingCount: ctx.valuesByField[rule.targetField]?.length ?? 0,
        /** 该字段当前的取值分布（前 8 个）——配规则时要照着现有格式配 */
        existingSamples: (ctx.valuesByField[rule.targetField] ?? []).slice(0, 8),
      };
    });
    /**
     * 「取自记录字段」段用到的那些字段的**真实取值分布**。
     *
     * 🔴 候选来自真实数据而不是字典（理由见构造函数上的注释），每项带出现次数 ——
     *    配映射时最需要知道的就是"这个值在库里出现过多少次、要不要给它配个码"。
     */
    const usedFields = new Set<string>();
    for (const r of config.rules) {
      for (const s of r.segments) if (s.kind === 'field' && s.field) usedFields.add(s.field);
    }
    const fieldValues: Record<string, { value: string; count: number }[]> = {};
    for (const f of usedFields) fieldValues[f] = topValues(ctx.records, f);
    return {
      rules,
      conflicts: codeRuleConflicts(config),
      fieldValues,
      meta: {
        segmentKinds: CODE_SEGMENT_KINDS.map((k) => ({ value: k, label: CODE_SEGMENT_LABEL[k].zh })),
        dateFormats: CODE_DATE_FORMATS.map((v) => ({ value: v, label: CODE_DATE_FORMAT_LABEL[v] })),
        fieldTransforms: CODE_FIELD_TRANSFORMS.map((v) => ({ value: v, label: CODE_FIELD_TRANSFORM_LABEL[v] })),
        mapMatches: CODE_MAP_MATCHES.map((v) => ({ value: v, label: CODE_MAP_MATCH_LABEL[v] })),
        resetCycles: CODE_RESET_CYCLES.map((v) => ({ value: v, label: CODE_RESET_CYCLE_LABEL[v] })),
        resetScopes: CODE_RESET_SCOPES.map((v) => ({ value: v, label: CODE_RESET_SCOPE_LABEL[v] })),
        conflicts: CODE_CONFLICT_STRATEGIES.map((v) => ({ value: v, label: CODE_CONFLICT_LABEL[v] })),
        targets: CODE_RULE_TARGETS,
        /**
         * 「取自记录字段」段可选的字段名。
         *
         * 🔴 必须是**运行期真实字段名**（带全角括号那种也要原样给），
         *    不能在前端写死一份 —— 写死的必然和档案里的字段名漂移，
         *    而漂移的表现是"字段段渲染成空、号里少一截"，**不报错**。
         */
        fields: ctx.fieldNames,
      },
    };
  }

  /**
   * 批量补号**预检**（不写库）：列出该字段为空、且按规则能生成号的记录。
   *
   * 🔴 为什么必须两步（预检 → 确认）：这是一次**写多条**的操作，
   *    而学籍号是登录凭证。先让人看到"将生成的每一个号"再确认，是唯一负责任的做法。
   */
  async fillPreview(user: SessionUser, body: unknown): Promise<CodeFillPreview> {
    requireModule(user, 'codeRules', 'read');
    const key = String(((body ?? {}) as Record<string, unknown>).ruleKey ?? '');
    const config = await this.loadConfig();
    const rule = config.rules.find((r) => r.key === key);
    if (!rule) throw new BadRequestException(`RULE_NOT_FOUND:${key}`);
    if (!rule.enabled) throw new BadRequestException('RULE_DISABLED');
    return this.buildFill(rule);
  }

  /**
   * 批量补号（**写库**，二次确认后调用）。
   *
   * 🔴 只补**空值**，绝不动已有值 —— 追溯改号 = 有人登不上系统（设计 K2）。
   * 🔴 逐条串行写 + 每条都把生成结果累加进 `existing`，否则同一批里的多条会拿到同一个号。
   */
  async fill(user: SessionUser, body: unknown): Promise<{ ok: boolean; filled: number; skipped: number; rows: CodeFillRow[] }> {
    requireModule(user, 'codeRules', 'update');
    const key = String(((body ?? {}) as Record<string, unknown>).ruleKey ?? '');
    const config = await this.loadConfig();
    const rule = config.rules.find((r) => r.key === key);
    if (!rule) throw new BadRequestException(`RULE_NOT_FOUND:${key}`);
    if (!rule.enabled) throw new BadRequestException('RULE_DISABLED');

    const plan = await this.buildFill(rule);
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('NO_DATABASE');
    const tableId = tableIdOf(rule.targetTable);
    let filled = 0;
    for (const row of plan.rows) {
      if (!row.code) continue;
      try {
        await sql.update(tableId, row.id, { [rule.targetField]: row.code });
        filled += 1;
      } catch (e) {
        this.logger.warn(`补号失败 ${row.id}：${(e as Error).message.slice(0, 120)}`);
      }
    }
    this.logger.log(
      `批量补号：${rule.targetField} 补 ${filled} 条（可补 ${plan.fillable}，跳过已有值 ${plan.skipped}，缺输入 ${plan.blocked}）；操作人 ${user.name ?? ''}`,
    );
    return { ok: true, filled, skipped: plan.skipped, rows: plan.rows };
  }

  /** 拼一份补号计划（预检与真正补号**用同一个函数** ⇒ 看到的就是会写的） */
  private async buildFill(rule: CodeRule): Promise<CodeFillPreview> {
    const tableId = tableIdOf(rule.targetTable);
    const records = await this.recordsOf(tableId);
    const existing = records.map((r) => String(r[rule.targetField] ?? '').trim()).filter(Boolean);
    const acc = [...existing];
    const rows: CodeFillRow[] = [];
    let skipped = 0;
    for (const rec of records) {
      const cur = String(rec[rule.targetField] ?? '').trim();
      if (cur) {
        skipped += 1; // 已有值 ⇒ 不动
        continue;
      }
      const name = String(rec['学生姓名'] ?? rec['姓名'] ?? rec.id ?? '');
      const r = generateCode(rule, { nowMs: Date.now(), fields: rec, existing: acc });
      rows.push({ id: String(rec.id ?? ''), name, code: r.code, reason: r.reason });
      // 🔴 只有真生成出来的号才累加进 `acc`：生成不出来的行（缺必需输入）如果也占位，
      //    后面那些**能生成**的记录会被空号"顶掉"一个流水位（表现为跳号，且原因看不出来）
      if (r.code) acc.push(r.code);
    }
    // 🔴 「能补几条」必须和「写库循环里真正会写的条数」同源（`fill()` 里也是 `if (!row.code) continue`）
    const fillable = rows.filter((x) => x.code).length;
    return {
      field: rule.targetField,
      existingCount: existing.length,
      skipped,
      fillable,
      blocked: rows.length - fillable,
      rows,
      samples: rows.slice(0, 200),
    };
  }

  // ══════════════════════════════════════════════════════════════
  // 供其他模块调用（学生建档时自动填）
  // ══════════════════════════════════════════════════════════════

  /**
   * 给一条**即将写入**的记录生成编号（K1：字段留空才生成；已有值原样返回）。
   *
   * 🔴 调用方（`StudentService.create`）必须只用它的返回值补**空字段**，
   *    并且在生成失败时**继续建记录**（不能让"编号生成不了"把建学生整条链路弄挂）。
   */
  async generateFor(
    table: string,
    field: string,
    fields: Record<string, unknown>,
  ): Promise<{ code: string; reason?: string }> {
    try {
      if (String(fields?.[field] ?? '').trim()) return { code: '' }; // 已有值 ⇒ 尊重人工值
      const config = await this.loadConfig();
      const rule = config.rules.find((r) => r.enabled && r.targetTable === table && r.targetField === field);
      if (!rule) return { code: '', reason: '没有启用的规则' };
      const tableId = tableIdOf(table);
      const records = await this.recordsOf(tableId);
      const existing = records.map((r) => String(r[field] ?? '').trim()).filter(Boolean);
      const r = generateCode(rule, { nowMs: Date.now(), fields: fields ?? {}, existing });
      if (!r.code) this.logger.warn(`编号生成失败（${field}）：${r.reason ?? '未知'}`);
      return { code: r.code, reason: r.reason };
    } catch (e) {
      // 🔴 绝不能抛：生成编号失败不应该让"新建学生"失败
      this.logger.warn(`编号生成异常（${field}）：${(e as Error).message}`);
      return { code: '', reason: (e as Error).message };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 数据面
  // ══════════════════════════════════════════════════════════════

  /** 目标表的全部记录 + 各目标字段的现有取值 + 可用于 `field` 段的字段名清单 */
  private async dataset(): Promise<{
    records: Record<string, unknown>[];
    valuesByField: Record<string, string[]>;
    fieldNames: string[];
  }> {
    // ⚠️ `CODE_RULE_TARGETS[0]` 在 noUncheckedIndexedAccess 下是 `T | undefined`，
    //    直接 `.table` 过不了类型检查。用 `?? ''` 兜住（配错也是抛 BadRequest，与旧行为一致）
    const tableId = tableIdOf(CODE_RULE_TARGETS[0]?.table ?? '');
    const records = await this.recordsOf(tableId);
    const valuesByField: Record<string, string[]> = {};
    for (const t of CODE_RULE_TARGETS) {
      valuesByField[t.field] = records.map((r) => String(r[t.field] ?? '').trim()).filter(Boolean);
    }
    const names = new Set<string>();
    for (const r of records) for (const k of Object.keys(r)) names.add(k);
    return { records, valuesByField, fieldNames: [...names].sort() };
  }

  /**
   * 读一张表的记录。
   *
   * ⚠️ `SqlStore.search` 返回的记录里 id 挂在 **`recordId`** 上（不是 `id`）——
   *    只认 `.id` 会静默拿到空串（2026-09-13 踩过：关联 id 永远写不进去）。
   */
  private async recordsOf(tableId: string): Promise<Record<string, unknown>[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const out: Record<string, unknown>[] = [];
    let token: string | undefined;
    for (let page = 0; page < 40; page += 1) {
      const res = await sql.search(tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) });
      for (const r of res.items ?? []) {
        const rec = r as { id?: string; recordId?: string; fields?: Record<string, unknown> };
        const f = ((rec.fields ?? r) ?? {}) as Record<string, unknown>;
        out.push({ ...f, id: String(rec.recordId ?? rec.id ?? f['id'] ?? '') });
      }
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
    return out;
  }

  /** 用真实记录做样例试算（编号是"照着现有格式配"出来的，所以样例必须是真实数据） */
  private previewOf(
    rule: CodeRule,
    ctx: { records: Record<string, unknown>[]; valuesByField: Record<string, string[]> },
    field: string,
    limit: number,
  ): { label: string; code: string; reason?: string; conflict: boolean }[] {
    const rows = ctx.records.slice(0, limit);
    const existing = ctx.valuesByField[field] ?? [];
    const acc = [...existing];
    const samples: CodeSample[] = rows.map((r, i) => ({
      label: String(r['学生姓名'] ?? `记录 ${i + 1}`),
      fields: r,
    }));
    if (!samples.length) {
      // 表里没数据时给两条人造样例，让页面至少能看出规则长什么样
      samples.push({ label: '样例（2026 秋 · Pre-1）', fields: { 入学年份: '2026', 入学年月: '26秋季', 入学年级: 'Pre-1' } });
      samples.push({ label: '样例（2026 春 · 大一）', fields: { 入学年份: '2026', 入学年月: '26春季', 入学年级: '大一' } });
    }
    return samples.map((s) => {
      const r = generateCode(rule, { nowMs: Date.now(), fields: s.fields, existing: acc, randomSeed: s.label });
      if (r.code) acc.push(r.code);
      return { label: s.label, code: r.code, reason: r.reason, conflict: !!r.code && existing.includes(r.code) };
    });
  }
}

// ── 小工具 ────────────────────────────────────────────────────

/** 某字段的真实取值分布（按出现次数降序，最多 40 项） */
function topValues(records: Record<string, unknown>[], field: string): { value: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of records) {
    const v = String(r?.[field] ?? '').trim();
    if (!v) continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 40);
}

function isPresent(list: unknown, key: string): boolean {
  return (Array.isArray(list) ? list : []).some((x) => String((x as Record<string, unknown>)?.key ?? '') === key);
}

/** 表 key → PG 表 id（只支持已登记的目标表） */
function tableIdOf(table: string): string {
  if (table === 'studentProfile') return TABLES.studentProfile.tableId;
  throw new BadRequestException(`UNKNOWN_TABLE:${table}`);
}

