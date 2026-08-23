import { Inject, Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { BaseClient, toText, type BaseRecord } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { REDIS } from '../redis.provider.js';
import { BASE_CLIENT } from '../base.provider.js';
import { SessionService } from '../auth/session.service.js';
import { buildFilter, toFlatRecord } from '../shared/record.util.js';
import type { SessionUser } from '@acms/contracts';

const STUDENT_TABLE = TABLES.studentProfile.tableId;
const ATTENDANCE_TABLE = TABLES.attendance.tableId;
const COMM_TABLE = TABLES.homeSchoolComm.tableId;

const READONLY = new Set<string>(['创建时间', '更新时间']);
const NUMBERS = new Set<string>(['签到距离(米)']);

/**
 * 家长 H5 端服务（P3）：
 *  - bind：用学号 + 姓名绑定家长到学生，签发 cookie 会话（角色 parent）。
 *  - listAttendances：仅可读所绑定子女的考勤记录（按关联学生编号过滤）。
 *  - submitFeedback：向家校沟通表写入一条家长反馈（仅自由文本 + link 字段，避免单选枚举校验失败）。
 */
@Injectable()
export class ParentService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly sessions: SessionService,
  ) {}

  /** 学号 + 姓名 → 学生 record_id（与小程序绑定逻辑一致，但不写 Redis 绑定键） */
  private async findStudent(studentNo: string, name: string): Promise<BaseRecord | null> {
    const res = await this.base.search(STUDENT_TABLE, {
      pageSize: 50,
      filter: buildFilter([{ field: '学生姓名', value: [name] }]),
    });
    const no = String(studentNo).trim();
    return (
      res.items.find((r) => {
        const f = r.fields;
        if (toText(f['学生姓名']) !== name.trim()) return false;
        return (
          String(toText(f['学生编号']) ?? '').trim() === no ||
          String(toText(f['学籍号（脱敏）']) ?? '').trim() === no
        );
      }) || null
    );
  }

  async bind(studentNo: string, name: string): Promise<SessionUser> {
    if (!studentNo || !name) throw new BadRequestException('VALIDATION:需学号与姓名');
    const stu = await this.findStudent(studentNo, name);
    if (!stu) throw new UnauthorizedException('STUDENT_NOT_FOUND:学号或姓名不匹配');
    const campus = toText(stu.fields['校区']) ?? '';
    const displayName = toText(stu.fields['学生姓名']) ?? name;
    return this.sessions.create({
      openId: `parent_${stu.recordId}`,
      name: displayName,
      roles: ['parent'],
      campuses: campus ? [campus] : [],
      maxDataLevel: 'L1',
      studentId: stu.recordId,
    });
  }

  /** 家长只读所绑定学生的考勤记录 */
  async listAttendances(studentId: string): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const res = await this.base.search(ATTENDANCE_TABLE, {
      pageSize: 200,
      filter: buildFilter([{ field: '关联学生编号', value: [studentId] }]),
    });
    const items = res.items.map((r) => toFlatRecord(r, READONLY, NUMBERS));
    return { items, total: items.length };
  }

  /** 家长提交反馈（写入家校沟通表） */
  async submitFeedback(studentId: string, content: string, contact?: string): Promise<{ ok: boolean }> {
    if (!content || !content.trim()) throw new BadRequestException('VALIDATION:反馈内容不能为空');
    const fields: Record<string, unknown> = {
      关联学生编号: [studentId],
      沟通内容: content,
      家长反馈: contact ? `【${contact}】${content}` : content,
    };
    try {
      fields['沟通时间'] = new Date().toISOString();
    } catch {
      /* datetime 可选，失败不影响主记录 */
    }
    await this.base.create(COMM_TABLE, fields);
    return { ok: true };
  }
}
