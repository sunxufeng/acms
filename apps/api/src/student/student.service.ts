import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, toWriteSingle, toWriteMulti, toStringArray, toText, toUserIds, type FilterGroup, type BaseRecord } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { DictService } from '../dictionary/dict.service.js';

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
  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly fileUpload: FileUploadService,
    private readonly dict: DictService,
  ) {}

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
      if (k === '招生负责老师' || k === '班主任' || k === '数据负责人' || k === '升学导师') {
        // 这些字段已从飞书 User 类型(11) 转为 Text 类型(1)，直接存 open_id 文本即可。
        // （飞书 User 字段无法校验本租户 open_id，会报 UserFieldConvFail）
        const ids = toUserIds(v);
        if (ids.length) fields[k] = ids[0];
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

  /** 可被 q 模糊搜索覆盖的文本字段（均为 Text 类型，支持 contains） */
  private readonly textSearchFields = ['学生姓名', '英文名', '学籍号（脱敏）'];

  /**
   * 构建列表过滤条件。
   * 注意：飞书 Base 的 filter 不支持嵌套分组（实测 99992402: field validation failed），
   * 只能使用「单一 conjunction + 平铺条件」。
   * - 无 q：返回平铺 AND（各等值筛选），飞书侧直接执行。
   * - 有 q：返回顶层 OR（仅覆盖文本字段）；其余筛选改为在内存中执行（见 list）。
   */
  private buildFilter(query: StudentFilterDto): FilterGroup {
    if (query.q) {
      // q 单独用顶层 OR，避免嵌套导致飞书 500
      return {
        conjunction: 'or',
        conditions: this.textSearchFields.map((f) => ({ field: f, op: 'contains' as const, value: [query.q!] })),
      };
    }
    const conditions: FilterGroup['conditions'] = [];
    if (query.当前状态) conditions.push({ field: '当前状态', value: [query.当前状态] });
    if (query.入学年级) conditions.push({ field: '入学年级', value: [query.入学年级] });
    if (query.入学年份) conditions.push({ field: '入学年份', value: [query.入学年份] });
    if (query.实际学制) conditions.push({ field: '实际学制', value: [query.实际学制] });
    if (query.班级) conditions.push({ field: '班级', value: [query.班级] });
    if (query.班主任) conditions.push({ field: '班主任', value: [query.班主任] });
    if (query.招生负责老师) conditions.push({ field: '招生负责老师', value: [query.招生负责老师] });
    if (query.校区) conditions.push({ field: '校区', value: [query.校区] });
    if (query.数据密级) conditions.push({ field: '数据密级', value: [query.数据密级] });
    if (query.性别) conditions.push({ field: '性别', value: [query.性别] });
    if (query.来源渠道) conditions.push({ field: '来源渠道', value: [query.来源渠道] });
    if (query.生源跟进状态) conditions.push({ field: '生源跟进状态', value: [query.生源跟进状态] });
    if (query.原学校类型) conditions.push({ field: '原学校类型', value: [query.原学校类型] });
    if (query.合同状态) conditions.push({ field: '合同状态', value: [query.合同状态] });
    if (query.付款状态) conditions.push({ field: '付款状态', value: [query.付款状态] });
    if (query.家庭关键决策点) conditions.push({ field: '家庭关键决策点', value: [query.家庭关键决策点] });
    if (query.综合评定等级) conditions.push({ field: '综合评定等级', value: [query.综合评定等级] });
    if (query.签证情况) conditions.push({ field: '签证情况', value: [query.签证情况] });
    if (query.是否企业家庭) conditions.push({ field: '是否企业家庭', value: [query.是否企业家庭] });
    if (query.是否工坊企业) conditions.push({ field: '是否工坊企业', value: [query.是否工坊企业] });
    if (query.是否多胎家庭) conditions.push({ field: '是否多胎家庭', value: [query.是否多胎家庭] });
    if (query.入学级) conditions.push({ field: '入学级', value: [query.入学级] });
    if (query.毕业届) conditions.push({ field: '毕业届', value: [query.毕业届] });
    // 注：当前状态真实选项仅为「在校/毕业/离校」，Base 中无「已归档」选项，
    // 故不再做 is_not 已归档 的服务端过滤（否则飞书报错 500）。列表默认展示全部，
    // 归档通过 archive() 将状态置为「离校」实现。
    return { conjunction: 'and', conditions };
  }

  /** 内存中执行非 q 的等值筛选（仅在 q 路径需要，因飞书不支持嵌套过滤组） */
  private matchesNonQ(s: StudentRecord, query: StudentFilterDto): boolean {
    const eq: Array<keyof StudentFilterDto> = [
      '当前状态', '入学年级', '班级', '班主任', '招生负责老师', '校区',
      '数据密级', '性别', '来源渠道', '生源跟进状态', '入学级', '毕业届',
      '入学年份', '实际学制', '现居住省', '城市', '学生标签', '特长标签',
      '原学校类型', '合同状态', '付款状态', '家庭关键决策点',
      '综合评定等级', '签证情况',
      '是否企业家庭', '是否工坊企业', '是否多胎家庭',
    ];
    for (const k of eq) {
      const want = query[k];
      if (want == null || want === '' || (Array.isArray(want) && !want.length)) continue;
      const rec = (s as Record<string, unknown>)[k as string];
      // 前端可能把多选以逗号拼接成字符串传入，统一拆开
      const wants = (Array.isArray(want) ? want.map(String) : String(want).split(',')).filter(Boolean);
      const matchOne = (w: string) => {
        if (Array.isArray(rec)) return rec.map(String).includes(w);
        return String(rec ?? '') === w;
      };
      if (!wants.some(matchOne)) return false;
    }
    return true;
  }

  /** 分页拉取满足 filter 的全部记录（用于 q 路径：需先在内存中再筛选/分页） */
  private async fetchAll(tableId: string, opts: { filter?: FilterGroup; sort?: { field: string; desc: boolean }[] }): Promise<BaseRecord[]> {
    const out: BaseRecord[] = [];
    let token: string | undefined;
    do {
      const res = await this.base.search(tableId, { pageSize: 100, pageToken: token, filter: opts.filter, sort: opts.sort });
      out.push(...res.items);
      token = res.hasMore ? res.pageToken : undefined;
    } while (token);
    return out;
  }

  /** 列表（过滤 + 排序 + 分页 + ABAC 行级过滤） */
  async list(user: SessionUser, query: StudentFilterDto) {
    const principal = toPrincipal(user);
    const allowed = authorize(principal, 'student:read');
    if (!allowed.allowed) throw new ForbiddenException('FORBIDDEN:student:read');

    const hasQ = !!query.q;
    const filter = this.buildFilter(query);
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '更新时间', desc: true }];
    const psRaw = query.pageSize;
    const pageSize = (typeof psRaw === 'number' ? psRaw : Number(psRaw)) || 50;

    // q 搜索：飞书不支持嵌套过滤组，故 q 用顶层 OR 在飞书侧执行，
    // 其余筛选与分页在内存中执行；无 q 时维持原有服务端分页。
    const abacPass = (s: StudentRecord) =>
      authorize(principal, 'student:read', {
        campus: s.校区 as string | undefined,
        dataLevel: s.数据密级 as string | undefined,
      }).allowed;
    const enrichAll = (arr: StudentRecord[]) =>
      Promise.all(arr.map((s) => this.enrichAttachmentViewUrls(s).catch(() => undefined)));

    if (hasQ) {
      const all = await this.fetchAll(TABLE, { filter, sort });
      let students = all.map((r) => this.toStudent(r)).filter(abacPass);
      students = students.filter((s) => this.matchesNonQ(s, query));
      await enrichAll(students);
      // 内存分页（pageToken 为偏移量字符串）
      const start = query.pageToken ? Number(query.pageToken) || 0 : 0;
      const slice = students.slice(start, start + pageSize);
      const next = students.length > start + pageSize ? String(start + pageSize) : undefined;
      return { items: slice, total: students.length, hasMore: !!next, pageToken: next };
    }

    const res = await this.base.search(TABLE, {
      pageSize,
      pageToken: query.pageToken,
      filter,
      sort,
    });
    let items = res.items.map((r) => this.toStudent(r)).filter(abacPass);
    await enrichAll(items);

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
    // 为学生照片/证件文件生成浏览器可直接访问的临时下载链接
    await this.enrichAttachmentViewUrls(student);
    return student;
  }

  /**
   * 把学生记录的「证件与文件」关联字段（[{record_ids:[...],...}]）解析为附件列表。
   * 关联表(tblJDhpAEOVhCwE2)的「文件附件」存实际 file_token，「文件名称」存文件名。
   */
  private async resolveDocFiles(link: unknown): Promise<Array<{ file_token: string; name?: string; url?: string }>> {
    const arr = Array.isArray(link) ? (link as Array<{ record_ids?: string[] }>) : [];
    const recordIds = arr[0]?.record_ids ?? [];
    if (recordIds.length === 0) return [];
    const docs = await Promise.all(
      recordIds.map((rid) => this.base.get(DOC_TABLE, rid).catch(() => null)),
    );
    const out: Array<{ file_token: string; name?: string; url?: string }> = [];
    for (const d of docs) {
      if (!d) continue;
      const att = Array.isArray(d.fields['文件附件']) ? (d.fields['文件附件'] as Array<{ file_token?: string; url?: string }>)[0] : undefined;
      const ft = att?.file_token;
      if (!ft) continue;
      out.push({ file_token: ft, name: (d.fields['文件名称'] as string) || undefined, url: att?.url });
    }
    return out;
  }

  /**
   * 为学生记录的附件字段（学生照片、证件与文件）生成浏览器可直接访问的临时下载链接。
   * 飞书附件对象里的 url/tmp_url 都需要 Authorization，浏览器 <img>/<a> 无法携带，
   * 因此调用 batch_get_tmp_download_url 换取免 token 的临时链接并注入 viewUrl。
   */
  private async enrichAttachmentViewUrls(student: StudentRecord): Promise<void> {
    const fields = ['学生照片', '证件与文件'] as const;
    for (const field of fields) {
      const raw = student[field];
      const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      if (list.length === 0) continue;
      const extra = this.extractExtraFromAttachment(list[0]!);
      if (!extra) continue;
      const tokens = list.map((a) => String(a.file_token ?? '')).filter(Boolean);
      if (tokens.length === 0) continue;
      try {
        const map = await this.fileUpload.getBatchTmpDownloadUrls(tokens, extra);
        for (const att of list) {
          const ft = String(att.file_token ?? '');
          if (map[ft]) att.viewUrl = map[ft];
        }
      } catch {
        /* 临时链接失败不影响主记录展示，前端仍可按原对象降级 */
      }
    }
  }

  /** 从飞书附件对象的 url 字段解析 extra 查询参数 */
  private extractExtraFromAttachment(att: Record<string, unknown>): string | undefined {
    const url = String(att.url ?? '');
    if (!url) return undefined;
    try {
      const u = new URL(url);
      return u.searchParams.get('extra') ?? undefined;
    } catch {
      return undefined;
    }
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
    await this.ensureTagOptions(dto);
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
    await this.ensureTagOptions(dto);
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  /** 写入前，把标签字段里用户新增的候选项同步进飞书字段枚举，避免「选项不在枚举内」写入失败 */
  private async ensureTagOptions(dto: CreateStudentDto | UpdateStudentDto): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const key of ['学生标签', '特长标签'] as const) {
      const val = (dto as Record<string, unknown>)[key];
      if (Array.isArray(val) && val.length) {
        tasks.push(this.dict.ensureOptions(TABLE, key, val as string[]));
      }
    }
    await Promise.all(tasks);
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
      if (k === '招生负责老师' || k === '班主任' || k === '数据负责人' || k === '升学导师') {
        obj[k] = toUserIds(v);
      } else if (k === '特殊支持摘要') {
        obj[k] = toStringArray(v);
      } else if (k === '学生照片' || k === '监护人与家庭' || k === '学籍与班级历史' || k === '健康与安全档案' || k === '证件与文件' || k === '授权与同意' || k === '当前学年' || k === '当前班级' || k === '接送授权人员' || k === '服务分配' || k === '数据变更审计' || k === '定制课程方案' || k === '课程修读关系' || k === '数据范围授权') {
        // 关联/附件字段：保留原始引用
        obj[k] = v;
      } else if (Array.isArray(v)) {
        // 多选字段（学生标签 / 特长标签 等）以字符串数组返回，供前端多选控件正确回填
        obj[k] = toStringArray(v);
      } else {
        obj[k] = toText(v);
      }
    }
    // 向后兼容：旧版分字段（英语标化类型/成绩、GPA成绩类型/成绩、学术标化类型/成绩）
    // 合并为结构化字段（英语标化成绩 / GPA成绩 / 学术标化成绩 的 JSON 数组 [{type,score}]）。
    // 新写入已统一走结构化字段，这里仅在结构化字段为空、且旧字段有值时做一次性合并，避免旧数据丢失。
    const migrateTypeScore = (newKey: string, typeKey: string, scoreKey: string) => {
      const nv = obj[newKey];
      const hasNew = (typeof nv === 'string' && nv.trim().length > 0) || (Array.isArray(nv) && nv.length > 0);
      if (hasNew) return;
      const types = toStringArray(obj[typeKey]);
      const scores = String(obj[scoreKey] ?? '')
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const n = Math.max(types.length, scores.length);
      if (n === 0) return;
      const arr: { type: string; score: string }[] = [];
      for (let i = 0; i < n; i++) arr.push({ type: types[i] ?? '', score: scores[i] ?? '' });
      obj[newKey] = JSON.stringify(arr);
    };
    migrateTypeScore('英语标化成绩', '英语标化类型', '英语标化成绩');
    migrateTypeScore('GPA成绩', 'GPA成绩类型', 'GPA成绩');
    migrateTypeScore('学术标化成绩', '学术标化类型', '学术标化成绩');
    migrateTypeScore('语言标化成绩', '语言标化类型', '语言标化成绩');

    return obj;
  }
}
