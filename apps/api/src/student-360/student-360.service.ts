import { Inject, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, toText } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { StudentService } from '../student/student.service.js';
import { LIFECYCLE_METAS } from '../shared/lifecycle.meta.js';
import type { RecordMeta } from '../shared/generic-crud.module.js';
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
  'home-school-comms': '家校沟通',
  'daily-followups': '日常跟进',
  'stage-evaluations': '阶段评价',
  'alumni-followups': '校友跟进',
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
  ) {}

  async getByStudent(
    user: SessionUser,
    studentId: string,
    range?: { from?: string; to?: string },
  ): Promise<{
    student: Record<string, unknown>;
    sections: Student360Section[];
  }> {
    if (!authorize(toPrincipal(user), 'student:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:student:read');
    }
    // 复用 StudentService.detail：自带存在性 + ABAC 行级校验
    const student = await this.studentSvc.detail(user, studentId);

    const sections: Student360Section[] = [];
    for (const meta of LIFECYCLE_METAS) {
      const studentLink = (meta.linkFields ?? []).find((l) => l.table === TABLES.studentProfile.tableId);
      const items = await this.fetchSection(meta, studentLink, studentId, String(student['学生姓名'] ?? ''), range);
      sections.push({ key: meta.path, label: SECTION_LABELS[meta.path] ?? meta.path, items });
    }
    return { student, sections };
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
