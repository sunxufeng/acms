import { Inject, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { moduleByPath, modulePermission } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, toText } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { StudentService } from '../student/student.service.js';
import { LIFECYCLE_METAS } from '../shared/lifecycle.meta.js';
import { FieldMaskService } from '../shared/field-mask.service.js';
import { IDP_PLAN_META } from '../idp/idp.meta.js';
import type { RecordMeta } from '../shared/generic-crud.module.js';
// 学生记录（三合一）的类型域判据 —— 与通用 CRUD 共用同一份，避免「列表看不到、全景看得到」
import { buildTypeScopeFilter, matchFilter, typeAllowedValues } from '../shared/generic-crud.module.js';
import { linkIds } from '../shared/record.util.js';

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/** 把飞书字段原始值解析为毫秒时间戳（支持 number / 'YYYY-MM-DD' / [{text}] 等） */
function parseRecordDate(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (Array.isArray(raw)) {
    const first = raw
      .map((it) => (typeof it === 'string' ? it : (it as { text?: string })?.text ?? ''))
      .find((s) => s.trim());
    return first ? parseRecordDate(first) : undefined;
  }
  if (typeof raw === 'object') {
    return parseRecordDate((raw as { text?: string }).text);
  }
  return undefined;
}

const SECTION_LABELS: Record<string, string> = {
  'source-followups': '招生跟进',
  'student-attendances': '学生考勤',
  grades: '学业成绩',
  'practice-activities': '实践活动',
  // 学生记录（2026-09-18）：日常跟进 / 家校沟通 / 学生观察 三合一后的分区名。
  // 三个旧 path 的条目已删除 —— 它们与主表指向同一张表，遍历时被 tableId 去重掉，
  // 留在这里只会让人误以为还有三个独立分区。
  'student-records': '学生记录',
  'stage-evaluations': '阶段评价',
  'alumni-followups': '校友跟进',
  'idp-plans': 'IDP方案',
  // 考试与成绩（2026-09-16 Phase 2）：不是 RecordMeta 驱动的表，见 examSections()
  termGrades: '期末总评',
  reportCards: '成绩单',
};

export interface Student360Section {
  key: string;
  label: string;
  items: Record<string, unknown>[];
}

/**
 * 学生 360 视图：以单个学生为中心，聚合其全生命周期 7 张表的记录。
 * 每张表按「关联学生编号」过滤出该学生的记录，并把其中的关联字段（学年/班级/课程/监护人等）
 * 跨表解析为可读名，便于前端一屏汇总展示。
 */
@Injectable()
export class Student360Service {
  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly studentSvc: StudentService,
    @Inject(FieldMaskService) private readonly mask: FieldMaskService,
  ) {}

  async getByStudent(
    user: SessionUser,
    studentId: string,
    range?: { from?: string; to?: string },
    sections?: string[],
  ): Promise<{
    student: Record<string, unknown>;
    sections: Student360Section[];
  }> {
    if (!authorize(toPrincipal(user), 'module:student360:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:module:student360:read');
    }
    // 复用 StudentService.detail：自带存在性 + ABAC 行级校验
    const student = await this.studentSvc.detail(user, studentId);

    const resultSections: Student360Section[] = [];
    // 三合一的四个入口（student-records / daily-followups / home-school-comms / student-observations）
    // 指向**同一张表**：这里按 tableId 去重，只出一个分区。
    // 不去重会同时踩两个坑：① 学生会看到 4 个内容完全重复的分区；
    // ② 其中几个因权限被跳过，而剩下的那个又不过滤类型 ⇒ 反而泄漏了别的类型的记录。
    const seenTables = new Set<string>();
    for (const meta of [...LIFECYCLE_METAS, IDP_PLAN_META]) {
      if (seenTables.has(meta.tableId)) continue;
      seenTables.add(meta.tableId);
      // 维度过滤：若传入 sections（中文维度名），只返回命中维度；空数组/未传表示全部
      const label = SECTION_LABELS[meta.path] ?? meta.path;
      if (sections && sections.length && !sections.includes(label)) continue;
      // 区块级权限：无该模块 read 权限则不返回该区块（沿用已有权限点，零新增）
      // 类型域模块（学生记录）按「任一类型权限」判定 —— 只认新权限点的话，
      // 合并后没有任何角色持有它，整个分区会对所有人消失。
      const mod = moduleByPath('/' + meta.path);
      const readOk = mod
        ? meta.typeScope
          ? (() => {
              const allowed = typeAllowedValues(meta, user, 'read');
              return allowed === null || allowed.length > 0;
            })()
          : authorize(toPrincipal(user), modulePermission(mod.key, 'read')).allowed
        : true;
      if (!readOk) continue;
      const studentLink = (meta.linkFields ?? []).find((l) => l.table === TABLES.studentProfile.tableId);
      const rawItems = await this.fetchSection(meta, studentLink, studentId, String(student['学生姓名'] ?? ''), range);
      // 类型过滤：只保留用户有权查看的类型（与「学生记录」列表同一判据）
      const typeCond = buildTypeScopeFilter(meta, user);
      const items =
        typeCond && typeCond !== 'none' ? rawItems.filter((r) => matchFilter(r, typeCond)) : rawItems;
      const maskedItems = mod ? this.mask.maskMany(user, mod.key, items) : items;
      resultSections.push({ key: meta.path, label, items: maskedItems });
    }
    // ── 考试与成绩分区（Phase 2）────────────────────────────────
    // 这两块不是 LIFECYCLE_METAS 里的表（是 exam-grade 的自建表 + 自定义接口），
    // 所以单独处理，但**同样按区块权限与维度过滤**，行为与上面一致。
    resultSections.push(...(await this.examSections(user, studentId, sections)));

    return { student, sections: resultSections };
  }

  /**
   * 拉一张表的所有行（分页拉完）。
   * 与 fetchSection 里的循环同源，抽出来避免第三份拷贝。
   */
  private async fetchAllRows(tableId: string): Promise<{ id: string; f: Record<string, unknown> }[]> {
    const out: { id: string; f: Record<string, unknown> }[] = [];
    let tok: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(tableId, { pageSize: 100, pageToken: tok });
      for (const r of res.items) {
        out.push({
          id: String((r as { recordId?: string }).recordId ?? (r as { id?: string }).id ?? ''),
          f: r.fields as Record<string, unknown>,
        });
      }
      tok = res.hasMore ? res.pageToken : undefined;
    } while (tok && guard++ < 200);
    return out;
  }

  /**
   * 考试与成绩分区（2026-09-16 Phase 2）。
   *
   * 两块：
   *  - `termGrades` 期末总评明细（学生 × 批次 × 科目，含任课教师评语）
   *  - `reportCards` 成绩单（学生 × 批次，含班主任总评语与导出记录）
   *
   * 权限与别的分区一致：没有 `module:examGrades:read` 就整块不返回（而不是返回空表 ——
   * 空表会让老师以为自己没成绩，实际是没权限）。
   */
  private async examSections(
    user: SessionUser,
    studentId: string,
    wanted: string[] | undefined,
  ): Promise<Student360Section[]> {
    const mod = moduleByPath('/exam-grades');
    if (mod && !authorize(toPrincipal(user), modulePermission(mod.key, 'read')).allowed) return [];

    const want = (label: string) => !wanted?.length || wanted.includes(label);
    const needTerms = want('期末总评');
    const needCards = want('成绩单');
    if (!needTerms && !needCards) return [];

    const [terms, cards, batches] = await Promise.all([
      needTerms ? this.fetchAllRows(TABLES.termGrade.tableId) : Promise.resolve([]),
      needCards ? this.fetchAllRows(TABLES.reportCard.tableId) : Promise.resolve([]),
      this.fetchAllRows(TABLES.gradeBatch.tableId),
    ]);
    const batchName = new Map(batches.map((b) => [b.id, toText(b.f['批次名称'])]));
    const batchMeta = new Map(
      batches.map((b) => [
        b.id,
        `${toText(b.f['学年'])} ${toText(b.f['学期'])}`.trim(),
      ]),
    );
    const mine = (f: Record<string, unknown>) => linkIds(f['学生']).includes(studentId);
    const out: Student360Section[] = [];

    if (needTerms) {
      const items = terms
        .filter((r) => mine(r.f))
        .map((r) => {
          const bid = String(linkIds(r.f['批次'])[0] ?? '');
          const obj: Record<string, unknown> = { id: r.id, 批次: batchName.get(bid) ?? '' };
          for (const k of [
            '科目',
            '总评',
            '等级',
            '是否达标',
            '参与项数',
            '班级排名',
            '教师评语',
            '状态',
            '结转人',
          ]) {
            obj[k] = toText(r.f[k]);
          }
          const at = parseRecordDate(r.f['结转时间']);
          obj['结转时间'] = at ? new Date(at).toISOString() : '';
          return obj;
        })
        // 新批次在前（批次名里带学年，倒序即最新在前）
        .sort((a, b) => String(b['批次']).localeCompare(String(a['批次']), 'zh'));
      out.push({ key: 'termGrades', label: '期末总评', items });
    }

    if (needCards) {
      const items = cards
        .filter((r) => mine(r.f))
        .map((r) => {
          const bid = String(linkIds(r.f['批次'])[0] ?? '');
          const obj: Record<string, unknown> = {
            id: r.id,
            批次: batchName.get(bid) ?? '',
            学年学期: batchMeta.get(bid) ?? '',
          };
          for (const k of ['班主任总评语', '评语状态', '生成人', '导出次数']) {
            obj[k] = toText(r.f[k]);
          }
          const at = parseRecordDate(r.f['生成时间']);
          obj['生成时间'] = at ? new Date(at).toISOString() : '';
          return obj;
        })
        .sort((a, b) => String(b['批次']).localeCompare(String(a['批次']), 'zh'));
      out.push({ key: 'reportCards', label: '成绩单', items });
    }
    return out;
  }

  private async fetchSection(
    meta: RecordMeta,
    studentLink: { field: string; table: string; nameField: string } | undefined,
    studentId: string,
    studentName: string,
    range?: { from?: string; to?: string },
  ): Promise<Record<string, unknown>[]> {
    // 拉全表
    const all: { recordId: string; fields: Record<string, unknown> }[] = [];
    let tok: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(meta.tableId, { pageSize: 100, pageToken: tok });
      all.push(...res.items);
      tok = res.hasMore ? res.pageToken : undefined;
    } while (tok && guard++ < 200);

    // 按该学生过滤：优先 studentMatch（可能按姓名匹配，如招生/家校/日常跟进），
    // 否则回退到关联学生编号 link（record id 匹配）
    const match = meta.studentMatch;
    let matched = all.filter((r) => {
      if (match) {
        const v = toText(r.fields[match.field]);
        return match.by === 'id' ? linkIds(r.fields[match.field]).includes(studentId) : v === studentName;
      }
      return studentLink ? linkIds(r.fields[studentLink.field]).includes(studentId) : false;
    });

    // 按时间段筛选（以 sortField/rangeField 为日期基准）
    const rangeField = meta.rangeField ?? meta.sortField;
    if (rangeField && (range?.from || range?.to)) {
      const fromMs = range.from ? new Date(`${range.from}T00:00:00`).getTime() : -Infinity;
      const toMs = range.to ? new Date(`${range.to}T23:59:59.999`).getTime() : Infinity;
      matched = matched.filter((r) => {
        const t = parseRecordDate(r.fields[rangeField]);
        if (t == null) return true; // 无日期字段的记录保守保留，避免误删
        return t >= fromMs && t <= toMs;
      });
    }

    if (!matched.length) return [];

    // 收集需解析的关联 id
    const links = meta.linkFields ?? [];
    const need: Record<string, { nameField: string; ids: Set<string> }> = {};
    for (const l of links) {
      for (const r of matched) {
        for (const id of linkIds(r.fields[l.field])) {
          const entry = need[l.table] ?? (need[l.table] = { nameField: l.nameField, ids: new Set() });
          entry.ids.add(id);
        }
      }
    }
    // 并行取可读名
    const nameMap = new Map<string, string>();
    await Promise.all(
      Object.entries(need).map(async ([table, info]) => {
        await Promise.all(
          [...info.ids].map(async (id) => {
            const rec = await this.base.get(table, id);
            const name = rec ? toText(rec.fields[info.nameField]) : '';
            nameMap.set(`${table}|${id}`, name || id);
          }),
        );
      }),
    );

    const items = matched.map((r) => {
      const obj: Record<string, unknown> = { id: r.recordId };
      for (const [k, v] of Object.entries(r.fields)) obj[k] = toText(v);
      for (const l of links) {
        const ids = linkIds(r.fields[l.field]);
        obj[l.field] = ids.map((id) => nameMap.get(`${l.table}|${id}`) || id).join('、');
      }
      return obj;
    });

    // 按默认排序字段倒序（日期为毫秒时间戳字符串，等长可字典序比较）
    const sf = meta.sortField;
    if (sf) {
      items.sort((a, b) => String(b[sf] ?? '').localeCompare(String(a[sf] ?? ''), 'zh'));
    }
    return items;
  }
}
