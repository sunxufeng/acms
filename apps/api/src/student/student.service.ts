import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, toWriteSingle, toWriteMulti, toStringArray, toText } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';

import type { CreateStudentDto, UpdateStudentDto, StudentFilterDto, ExportQueryDto } from './student.dto.js';

const TABLE = TABLES.studentProfile.tableId;

/** 关联类字段（DuplexLink/SingleLink/Attachment），M1 只读，编辑时跳过 */
const READONLY_FIELDS = new Set([
  '学生编号', '监护人与家庭', '学籍与班级历史', '健康与安全档案', '证件与文件', '授权与同意',
  '学生照片', '当前学年', '当前班级', '接送授权人员', '服务分配', '数据变更审计',
  '定制课程方案', '课程修读关系', '数据范围授权', '创建时间', '创建人', '更新时间', '最后修改人',
]);

/** L3/L4 脱敏字段（导出时掩码或隐藏） */
const SENSITIVE_FIELDS: { L3: string[]; L4: string[] } = {
  L3: ['证件号码（脱敏）', '学籍号（脱敏）'],
  L4: [],
};

/** 简化学生对象（id + 原始字段） */
type StudentRecord = { id: string } & Record<string, unknown>;

function toPrincipal(user: SessionUser): Principal {
  return {
    roles: user.roles,
    campuses: user.campuses,
    maxDataLevel: user.maxDataLevel,
  };
}

@Injectable()
export class StudentService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /** DTO → Base 写入字段（跳过只读字段，单选纯串、多选数组） */
  private toWriteFields(dto: CreateStudentDto | UpdateStudentDto): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (READONLY_FIELDS.has(k)) continue;
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        fields[k] = toWriteMulti(v);
      } else if (typeof v === 'string') {
        fields[k] = toWriteSingle(v);
      } else {
        fields[k] = v;
      }
    }
    return fields;
  }

  /** 构建列表过滤条件 */
  private buildFilter(query: StudentFilterDto): {
    conjunction: 'and';
    conditions: { field: string; op?: string; value: string[] }[];
  } {
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '学生姓名', op: 'contains', value: [query.q] });
    if (query.当前状态) conditions.push({ field: '当前状态', value: [query.当前状态] });
    if (query.当前年级) conditions.push({ field: '当前年级', value: [query.当前年级] });
    if (query.班级) conditions.push({ field: '班级', value: [query.班级] });
    if (query.班主任) conditions.push({ field: '班主任', value: [query.班主任] });
    if (query.招生负责老师) conditions.push({ field: '招生负责老师', value: [query.招生负责老师] });
    if (query.校区) conditions.push({ field: '校区', value: [query.校区] });
    if (query.数据密级) conditions.push({ field: '数据密级', value: [query.数据密级] });
    if (query.性别) conditions.push({ field: '性别', value: [query.性别] });
    if (query.来源渠道) conditions.push({ field: '来源渠道', value: [query.来源渠道] });
    if (query.生源跟进状态) conditions.push({ field: '生源跟进状态', value: [query.生源跟进状态] });
    // 注：当前状态真实选项仅为「在校/毕业/离校」，Base 中无「已归档」选项，
    // 故不再做 is_not 已归档 的服务端过滤（否则飞书报错 500）。列表默认展示全部，
    // 归档通过 archive() 将状态置为「离校」实现。
    return { conjunction: 'and', conditions };
  }

  /** 列表（过滤 + 排序 + 分页 + ABAC 行级过滤） */
  async list(user: SessionUser, query: StudentFilterDto) {
    const principal = toPrincipal(user);
    const allowed = authorize(principal, 'student:read');
    if (!allowed.allowed) throw new ForbiddenException('FORBIDDEN:student:read');

    const filter = this.buildFilter(query);
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '更新时间', desc: true }];

    const res = await this.base.search(TABLE, {
      pageSize: 50,
      pageToken: query.pageToken,
      filter,
      sort,
    });

    // 行级 ABAC：过滤无权查看的记录
    const items = res.items
      .map((r) => this.toStudent(r))
      .filter((s) => {
        const decision = authorize(principal, 'student:read', {
          campus: s.校区 as string | undefined,
          dataLevel: s.数据密级 as string | undefined,
        });
        return decision.allowed;
      });

    return {
      items,
      total: res.total,
      hasMore: res.hasMore,
      pageToken: res.pageToken,
    };
  }

  /** 详情（ABAC 校验） */
  async detail(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'student:read').allowed) {
      throw new ForbiddenException('FORBIDDEN:student:read');
    }
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    const student = this.toStudent(rec);
    const decision = authorize(principal, 'student:read', {
      campus: student.校区 as string | undefined,
      dataLevel: student.数据密级 as string | undefined,
    });
    if (!decision.allowed) throw new ForbiddenException('FORBIDDEN:campus/data-level');
    return student;
  }

  /** 新建（ABAC write 校验） */
  async create(user: SessionUser, dto: CreateStudentDto) {
    const principal = toPrincipal(user);
    const decision = authorize(principal, 'student:write', {
      campus: dto.校区,
      dataLevel: dto.数据密级 ?? 'L1',
    });
    if (!decision.allowed) {
      throw new ForbiddenException(`FORBIDDEN:student:write:${decision.reason}`);
    }
    if (!dto.学生姓名?.trim()) {
      throw new BadRequestException('VALIDATION:学生姓名必填');
    }
    const fields = this.toWriteFields(dto);
    if (!fields['数据密级']) fields['数据密级'] = 'L1';
    if (!fields['当前状态']) fields['当前状态'] = '潜在学生';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  /** 编辑（ABAC write 校验原记录） */
  async update(user: SessionUser, id: string, dto: UpdateStudentDto) {
    const principal = toPrincipal(user);
    const existing = await this.detail(user, id); // 复用 read + ABAC
    const decision = authorize(principal, 'student:write', {
      campus: (dto.校区 ?? (existing.校区 as string | undefined)) as string | undefined,
      dataLevel: (dto.数据密级 ?? (existing.数据密级 as string | undefined)) as string | undefined,
    });
    if (!decision.allowed) {
      throw new ForbiddenException(`FORBIDDEN:student:write:${decision.reason}`);
    }
    const fields = this.toWriteFields(dto);
    if (Object.keys(fields).length === 0) {
      throw new BadRequestException('VALIDATION:无可更新字段');
    }
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  /**
   * 归档（软删除）：当前状态真实选项仅为 在校/毕业/离校，Base 无「已归档」选项，
   * 故将状态置为「离校」作为非活跃标记。如需独立归档态，需在飞书字段新增「已归档」选项。
   */
  async archive(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'student:archive').allowed) {
      throw new ForbiddenException('FORBIDDEN:student:archive');
    }
    await this.detail(user, id); // 存在性 + read ABAC
    await this.base.update(TABLE, id, { 当前状态: '离校' });
    return { ok: true };
  }

  /** 恢复（当前状态=在校在读） */
  async restore(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'student:archive').allowed) {
      throw new ForbiddenException('FORBIDDEN:student:archive');
    }
    await this.detail(user, id);
    await this.base.update(TABLE, id, { 当前状态: '在校在读' });
    return { ok: true };
  }

  /** 导出（CSV 脱敏 + ABAC export 校验） */
  async exportCsv(user: SessionUser, query: ExportQueryDto): Promise<{ csv: string; count: number }> {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'export:run').allowed) {
      throw new ForbiddenException('FORBIDDEN:export:run');
    }
    // 导出最多 500 条
    const res = await this.base.search(TABLE, {
      pageSize: 500,
      filter: this.buildFilter({ ...query, includeArchived: 'true' }),
    });
    const students = res.items.map((r) => this.toStudent(r));

    const cols = ['学生编号', '学生姓名', '性别', '班级', '校区', '当前状态', '数据密级', '证件号码（脱敏）', '学籍号（脱敏）', '学生手机号', '学生邮箱'];
    const mask = (s: ReturnType<StudentService['toStudent']>, f: string): string => {
      const lvl = s.数据密级 as keyof typeof SENSITIVE_FIELDS;
      if (lvl === 'L4' && (SENSITIVE_FIELDS.L3.includes(f) || SENSITIVE_FIELDS.L4.includes(f))) return '***';
      if (lvl === 'L3' && SENSITIVE_FIELDS.L3.includes(f)) {
        const v = (s as Record<string, unknown>)[f];
        return typeof v === 'string' && v.length > 2 ? v.slice(0, 2) + '****' : '****';
      }
      return String((s as Record<string, unknown>)[f] ?? '');
    };
    const escape = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = cols.map(escape).join(',');
    const rows = students.map((s) => cols.map((c) => escape(mask(s, c))).join(','));
    return { csv: [header, ...rows].join('\n'), count: students.length };
  }

  /** Base record → 简化学生对象（关联字段以原文返回，前端只读展示） */
  private toStudent(rec: { recordId: string; fields: Record<string, unknown> }): StudentRecord {
    const f = rec.fields;
    const obj: StudentRecord = { id: rec.recordId };
    for (const [k, v] of Object.entries(f)) {
      if (k === '招生负责老师' || k === '班主任' || k === '数据负责人') {
        obj[k] = toStringArray(v);
      } else if (k === '特殊支持摘要') {
        obj[k] = toStringArray(v);
      } else if (k === '学生照片' || k === '监护人与家庭' || k === '学籍与班级历史' || k === '健康与安全档案' || k === '证件与文件' || k === '授权与同意' || k === '当前学年' || k === '当前班级' || k === '接送授权人员' || k === '服务分配' || k === '数据变更审计' || k === '定制课程方案' || k === '课程修读关系' || k === '数据范围授权') {
        // 关联/附件字段：保留原始引用
        obj[k] = v;
      } else {
        obj[k] = toText(v);
      }
    }
    return obj;
  }
}
