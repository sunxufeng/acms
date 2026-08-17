import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, toWriteSingle, toWriteMulti, toStringArray, toText, type FilterGroup } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';

import type { CreateStudentDto, UpdateStudentDto, StudentFilterDto, ExportQueryDto } from './student.dto.js';

const TABLE = TABLES.studentProfile.tableId;

/** 关联类字段（DuplexLink/SingleLink/Attachment），M1 只读，编辑时跳过 */
const READONLY_FIELDS = new Set([
  '学生编号', '监护人与家庭', '学籍与班级历史', '健康与安全档案', '授权与同意',
  '证件与文件', '当前学年', '当前班级', '接送授权人员', '服务分配', '数据变更审计',
  '定制课程方案', '课程修读关系', '数据范围授权', '创建时间', '创建人', '更新时间', '最后修改人',
]);

/** 附件字段（学生照片）：上传接口专用，值已是飞书附件对象数组，须原样透传，不可走 toWriteMulti */
const ATTACHMENT_FIELDS = new Set(['学生照片']);

/** 证件与文件关联表（type=21 关联字段指向此表），附件实体存于此表的「文件附件」字段 */
const DOC_TABLE = 'tblJDhpAEOVhCwE2';

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
      if (ATTACHMENT_FIELDS.has(k)) {
        // 附件字段：飞书附件对象数组原样透传（{ file_token } / { file_token, name }）
        fields[k] = v;
        continue;
      }
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
  private buildFilter(query: StudentFilterDto): FilterGroup {
    const conditions: FilterGroup['conditions'] = [];
    // 多字段文本搜索：仅对文本类型字段用 contains（飞书 search 的 contains 不支持单选/关联/数字等字段）
    // 学生编号/学生姓名/英文名 是文本字段；班级 可能是单选或关联字段，不含在 OR 里
    if (query.q) {
      const searchTextFields = ['学生编号', '学生姓名', '英文名'];
      conditions.push({
        conjunction: 'or' as const,
        conditions: searchTextFields.map((f) => ({ field: f, op: 'contains' as const, value: [query.q!] })),
      });
    }
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
    if (query.入学级) conditions.push({ field: '入学级', value: [query.入学级] });
    if (query.毕业届) conditions.push({ field: '毕业届', value: [query.毕业届] });
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
    // 解析「证件与文件」关联字段为可读附件列表（[{file_token,name}]）
    student['证件与文件'] = await this.resolveDocFiles(student['证件与文件']);
    return student;
  }

  /**
   * 把学生记录的「证件与文件」关联字段（[{record_ids:[...],...}]）解析为附件列表。
   * 关联表(tblJDhpAEOVhCwE2)的「文件附件」存实际 file_token，「文件名称」存文件名。
   */
  private async resolveDocFiles(link: unknown): Promise<Array<{ file_token: string; name?: string }>> {
    const arr = Array.isArray(link) ? (link as Array<{ record_ids?: string[] }>) : [];
    const recordIds = arr[0]?.record_ids ?? [];
    if (recordIds.length === 0) return [];
    const docs = await Promise.all(
      recordIds.map((rid) => this.base.get(DOC_TABLE, rid).catch(() => null)),
    );
    const out: Array<{ file_token: string; name?: string }> = [];
    for (const d of docs) {
      if (!d) continue;
      const att = Array.isArray(d.fields['文件附件']) ? (d.fields['文件附件'] as Array<{ file_token?: string }>)[0] : undefined;
      const ft = att?.file_token;
      if (!ft) continue;
      out.push({ file_token: ft, name: (d.fields['文件名称'] as string) || undefined });
    }
    return out;
  }

  /**
   * 上传「证件与文件」：飞书实体存于关联表(tblJDhpAEOVhCwE2)的「文件附件」字段，
   * 并通过「关联学生」反向链接到学生（双向关联自动回填学生的「证件与文件」）。
   */
  async attachDoc(user: SessionUser, studentId: string, fileToken: string, name: string): Promise<string> {
    // 先校验学生存在 + read ABAC
    await this.detail(user, studentId);
    return this.base.create(DOC_TABLE, {
      文件附件: [{ file_token: fileToken }],
      文件名称: name,
      关联学生: [studentId],
    } as Record<string, unknown>);
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
   * 删除（硬删除）：直接从飞书 Base 移除记录。
   * 权限要求 student:archive（系统管理员/校区管理员具备）。
   */
  async archive(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'student:archive').allowed) {
      throw new ForbiddenException('FORBIDDEN:student:archive');
    }
    await this.detail(user, id); // 存在性 + read ABAC
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  /** 恢复（保留兼容接口，当前删除为硬删除不再提供恢复） */
  async restore(user: SessionUser, id: string) {
    throw new BadRequestException('该记录已被删除，无法恢复');
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
