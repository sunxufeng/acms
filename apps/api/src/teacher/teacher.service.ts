import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, toWriteSingle, toWriteMulti, toStringArray, toText, type FilterGroup } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { DictService } from '../dictionary/dict.service.js';
import type { CreateTeacherDto, UpdateTeacherDto, TeacherFilterDto } from './teacher.dto.js';

const TABLE = TABLES.teacherProfile.tableId;

/** 只读/系统字段（编辑时跳过，避免写入自动编号/关联/附件/用户字段） */
const READONLY_FIELDS = new Set([
  '教师编号', '证件号码（脱敏）', '档案负责人', '创建时间', '更新时间',
  '师资寻访记录', '聘用与合作关系', '主讲教学班', '授课课次', '出勤记录', '外聘计费明细',
  '月度结算', '数据范围授权', '人员档案附件',
]);

type TeacherRecord = { id: string } & Record<string, unknown>;

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class TeacherService {
  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly dict: DictService,
  ) {}

  private toWriteFields(dto: CreateTeacherDto | UpdateTeacherDto): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (READONLY_FIELDS.has(k)) continue;
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) fields[k] = toWriteMulti(v);
      else if (typeof v === 'string') fields[k] = toWriteSingle(v);
      else fields[k] = v;
    }
    return fields;
  }

  /** 写入前，把各字典字段里用户新增的候选项同步进飞书字段枚举，避免「选项不在枚举内」写入失败 */
  private async ensureTeacherOptions(dto: CreateTeacherDto | UpdateTeacherDto): Promise<void> {
    const singleKeys = ['教师类别', '性别', '学历/学位', '授课学段', '授课科目类型', '合作开始时间', '收款主体', '数据密级', '教师合作等级'];
    const multiKeys = ['授课科目', '主要学科'];
    const tasks: Promise<void>[] = [];
    for (const key of singleKeys) {
      const val = (dto as Record<string, unknown>)[key];
      if (typeof val === 'string' && val.trim()) {
        tasks.push(this.dict.ensureOptions(TABLE, key, [val.trim()]));
      }
    }
    for (const key of multiKeys) {
      const val = (dto as Record<string, unknown>)[key];
      if (Array.isArray(val) && val.length) {
        tasks.push(this.dict.ensureOptions(TABLE, key, val as string[]));
      }
    }
    await Promise.all(tasks);
  }

  private buildFilter(query: TeacherFilterDto): {
    conjunction: 'and';
    conditions: ({ field: string; op?: string; value: string[] } | FilterGroup)[];
  } {
    const conditions: ({ field: string; op?: string; value: string[] } | FilterGroup)[] = [];
    // 关键字搜索：教师姓名 或 英文名 任意匹配（OR）
    if (query.q) {
      conditions.push({
        conjunction: 'or',
        conditions: [
          { field: '教师姓名', op: 'contains', value: [query.q] },
          { field: '英文名', op: 'contains', value: [query.q] },
        ],
      });
    }
    if (query.教师类别) conditions.push({ field: '教师类别', value: [query.教师类别] });
    if (query.主要学科) conditions.push({ field: '主要学科', value: [query.主要学科] });
    if (query.在职合作状态) conditions.push({ field: '在职合作状态', value: [query.在职合作状态] });
    if (query.所属部门) conditions.push({ field: '所属部门', value: [query.所属部门] });
    if (query.数据密级) conditions.push({ field: '数据密级', value: [query.数据密级] });
    return { conjunction: 'and', conditions };
  }

  async list(user: SessionUser, query: TeacherFilterDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'teacher:read').allowed) throw new ForbiddenException('FORBIDDEN:teacher:read');
    const filter = this.buildFilter(query);
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '更新时间', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter, sort });
    const items = res.items.map((r) => this.toTeacher(r));
    return { items, total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'teacher:read').allowed) throw new ForbiddenException('FORBIDDEN:teacher:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return this.toTeacher(rec);
  }

  async create(user: SessionUser, dto: CreateTeacherDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'teacher:write').allowed) throw new ForbiddenException('FORBIDDEN:teacher:write');
    if (!dto.教师姓名?.trim()) throw new BadRequestException('VALIDATION:教师姓名必填');
    const fields = this.toWriteFields(dto);
    if (!fields['数据密级']) fields['数据密级'] = '内部';
    if (!fields['在职合作状态']) fields['在职合作状态'] = '候选';
    await this.ensureTeacherOptions(dto);
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateTeacherDto) {
    const principal = toPrincipal(user);
    await this.detail(user, id);
    if (!authorize(principal, 'teacher:write').allowed) throw new ForbiddenException('FORBIDDEN:teacher:write');
    const fields = this.toWriteFields(dto);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.ensureTeacherOptions(dto);
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'teacher:archive').allowed) throw new ForbiddenException('FORBIDDEN:teacher:archive');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  private toTeacher(rec: { recordId: string; fields: Record<string, unknown> }): TeacherRecord {
    const f = rec.fields;
    const obj: TeacherRecord = { id: rec.recordId };
    for (const [k, v] of Object.entries(f)) {
      if (k === '授课科目' || k === '主要学科') obj[k] = toStringArray(v);
      else if (READONLY_FIELDS.has(k)) obj[k] = v;
      else obj[k] = toText(v);
    }
    return obj;
  }
}
