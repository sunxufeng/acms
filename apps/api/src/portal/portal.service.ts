import { Inject, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { BaseClient, toText } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { linkIds } from '../shared/record.util.js';
import { SignService } from '../attendance/sign.service.js';

/** 学生自助门户一键打卡请求体（studentId 由会话解析，不暴露给前端） */
export interface PortalSignDto {
  mode: 'gps' | 'wifi';
  gps?: string;
  ssid?: string;
  bssid?: string;
  at?: string;
  campus?: string;
}

/**
 * 学生自助门户（M5）：以登录用户的 openId 映射到「学生档案表.飞书 Open ID」，
 * 所有查询严格限定到该学生本人（ABAC 仅本人隔离）；打卡写复用 SignService。
 */
@Injectable()
export class PortalService {
  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly signService: SignService,
  ) {}

  /** 由 openId / studentId 解析当前学生档案（含 id）。
   *  微信小程序等外部会话走 user.studentId（record_id）；飞书会话走 飞书 Open ID。 */
  private async resolveStudent(user: SessionUser): Promise<{ id: string; fields: Record<string, unknown> } | null> {
    // 优先：会话已携带绑定的学生 record_id（微信/家长端）
    if (user.studentId) {
      try {
        const rec = await this.base.get(TABLES.studentProfile.tableId, user.studentId);
        if (rec) return { id: rec.recordId, fields: rec.fields };
      } catch {
        /* 失效的 studentId 回退到 openId 解析 */
      }
    }
    const res = await this.base.search(TABLES.studentProfile.tableId, {
      pageSize: 10,
      filter: { conjunction: 'and', conditions: [{ field: '飞书 Open ID', value: [user.openId] }] },
    });
    const rec = res.items[0];
    if (!rec) return null;
    return { id: rec.recordId, fields: rec.fields };
  }

  private async requireStudent(user: SessionUser) {
    const stu = await this.resolveStudent(user);
    if (!stu) throw new ForbiddenException('FORBIDDEN:未关联到学生档案，无法访问自助门户');
    return stu;
  }

  /** 本人档案（只读） */
  async me(user: SessionUser) {
    const stu = await this.requireStudent(user);
    const obj: Record<string, unknown> = { id: stu.id };
    for (const [k, v] of Object.entries(stu.fields)) {
      obj[k] = toText(v);
    }
    return obj;
  }

  /** 学业成绩（只读，按关联学生过滤） */
  async grades(user: SessionUser) {
    const stu = await this.requireStudent(user);
    const res = await this.base.search(TABLES.academicGrade.tableId, { pageSize: 200 });
    const items = res.items
      .filter((r) => linkIds(r.fields['关联学生编号']).includes(stu.id))
      .map((r) => this.flatGrade(r.fields));
    return { items, total: items.length };
  }

  private flatGrade(f: Record<string, unknown>) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) o[k] = toText(v);
    return o;
  }

  /** 周课表：录取关系 → 教学班 → 课次 */
  async schedule(user: SessionUser) {
    const stu = await this.requireStudent(user);
    // 1) 本人修读关系 → 教学班 id 集合
    const enr = await this.base.search(TABLES.enrollment.tableId, { pageSize: 200 });
    const myEnr = enr.items.filter((r) => linkIds(r.fields['关联学生']).includes(stu.id));
    const classIds = new Set<string>();
    for (const r of myEnr) for (const id of linkIds(r.fields['关联教学班'])) classIds.add(id);

    // 2) 教学班信息（名称 + 主讲教师）
    const classInfo = new Map<string, { name: string; teacher: string }>();
    if (classIds.size > 0) {
      const cls = await this.base.search(TABLES.teachingClass.tableId, { pageSize: 200 });
      for (const r of cls.items) {
        if (classIds.has(r.recordId)) {
          classInfo.set(r.recordId, {
            name: toText(r.fields['教学班名称']) ?? '',
            teacher: toText(r.fields['主讲教师文本']) ?? '',
          });
        }
      }
    }

    // 3) 课次（按教学班过滤）
    const ses = await this.base.search(TABLES.session.tableId, { pageSize: 200 });
    const items = ses.items
      .filter((r) => {
        const ids = linkIds(r.fields['关联教学班']);
        return ids.some((id) => classIds.has(id));
      })
      .map((r) => {
        const cid = linkIds(r.fields['关联教学班'])[0] ?? '';
        const info = classInfo.get(cid) ?? { name: '', teacher: '' };
        return {
          id: r.recordId,
          课次名称: toText(r.fields['课次名称']) ?? '',
          课次日期: toText(r.fields['课次日期']) ?? '',
          开始时间: toText(r.fields['开始时间']) ?? '',
          结束时间: toText(r.fields['结束时间']) ?? '',
          上课地点: toText(r.fields['上课地点']) ?? '',
          授课方式: toText(r.fields['授课方式']) ?? '',
          课次状态: toText(r.fields['课次状态']) ?? '',
          教学班: info.name,
          教学班Id: cid,
          主讲教师: info.teacher,
          教学班文本: toText(r.fields['教学班文本']) ?? '',
          授课教师文本: toText(r.fields['授课教师文本']) ?? '',
          场地文本: toText(r.fields['场地文本']) ?? '',
        };
      })
      .sort((a, b) => `${a.课次日期}${a.开始时间}`.localeCompare(`${b.课次日期}${b.开始时间}`));

    return { items, total: items.length, classes: [...classInfo.values()] };
  }

  /** 授课教师简介：汇总本人教学班的主讲教师，匹配教师档案 */
  async teachers(user: SessionUser) {
    const stu = await this.requireStudent(user);
    const enr = await this.base.search(TABLES.enrollment.tableId, { pageSize: 200 });
    const classIds = new Set<string>();
    for (const r of enr.items) {
      if (linkIds(r.fields['关联学生']).includes(stu.id)) {
        for (const id of linkIds(r.fields['关联教学班'])) classIds.add(id);
      }
    }
    const teacherNames = new Set<string>();
    if (classIds.size > 0) {
      const cls = await this.base.search(TABLES.teachingClass.tableId, { pageSize: 200 });
      for (const r of cls.items) {
        if (classIds.has(r.recordId)) {
          const t = toText(r.fields['主讲教师文本']) ?? '';
          if (t) teacherNames.add(t);
        }
      }
    }
    if (teacherNames.size === 0) return { items: [], total: 0 };
    const res = await this.base.search(TABLES.teacherProfile.tableId, {
      pageSize: 200,
      filter: { conjunction: 'or', conditions: [...teacherNames].map((n) => ({ field: '教师姓名', value: [n] })) },
    });
    const items = res.items.map((r) => {
      const f = r.fields;
      return {
        id: r.recordId,
        教师姓名: toText(f['教师姓名']) ?? '',
        教师类别: toText(f['教师类别']) ?? '',
        主要学科: toText(f['主要学科']) ?? '',
        所属部门: toText(f['所属部门']) ?? '',
        简介: toText(f['简介']) ?? toText(f['个人简介']) ?? '',
        在职合作状态: toText(f['在职合作状态']) ?? '',
      };
    });
    return { items, total: items.length };
  }

  /** 本人考勤记录（只读，按关联学生过滤，最近 100 条倒序） */
  async attendances(user: SessionUser) {
    const stu = await this.requireStudent(user);
    const res = await this.base.search(TABLES.attendance.tableId, {
      pageSize: 100,
      filter: { conjunction: 'and', conditions: [{ field: '关联学生编号', value: [stu.id] }] },
    });
    const items = res.items
      .map((r) => {
        const f = r.fields;
        const date = typeof f['考勤日期'] === 'string' ? (f['考勤日期'] as string).slice(0, 10) : '';
        return {
          id: r.recordId,
          考勤日期: date,
          方向: toText(f['方向']) ?? '',
          考勤状态: toText(f['考勤状态']) ?? '',
          签到方式: toText(f['签到方式']) ?? '',
          校区: toText(f['校区']) ?? '',
          到校时间: toText(f['到校时间']) ?? '',
          离校时间: toText(f['离校时间']) ?? '',
          签到距离: toText(f['签到距离(米)']) ?? '',
          考勤结果: toText(f['考勤结果']) ?? '',
        };
      })
      .sort((a, b) => `${b.考勤日期}${b.到校时间}`.localeCompare(`${a.考勤日期}${a.到校时间}`));
    return { items, total: items.length };
  }

  /** 一键打卡：复用 SignService 的围栏校验与去重逻辑，studentId 由会话解析（仅本人） */
  async sign(user: SessionUser, dto: PortalSignDto) {
    const stu = await this.requireStudent(user);
    return this.signService.sign(user, {
      studentId: stu.id,
      mode: dto.mode,
      gps: dto.gps,
      ssid: dto.ssid,
      bssid: dto.bssid,
      at: dto.at,
      campus: dto.campus,
    });
  }
}
