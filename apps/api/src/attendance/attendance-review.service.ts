import { Inject, Injectable, BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { TABLES } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import type { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { toFlatRecord } from '../shared/record.util.js';
import { AuditService } from '../audit/audit.service.js';
import {
  REVIEW_APPROVED,
  REVIEW_REJECTED,
  reviewStatusOf,
  type ReviewStatus,
} from '../reports/attendance-rate.js';
import type { ReviewAttendanceDto, ReviewAttendanceBatchDto } from './attendance.dto.js';

/**
 * 学生考勤记录的**终态审核**（教务审核后才计入出勤率与结算基数）。
 *
 * 为什么单独一个 service、而不是塞进 AttendanceService：
 * `AttendanceService` 管的是「教师履约记录表」（TABLES.teacherAttendance，/attendances），
 * 与这里的学生考勤记录表（TABLES.attendance，/student-attendances）是**两张不同的表**。
 * 混在一起会出现「在履约列表里点审核，出勤率报表却没变」这种最难查的问题。
 *
 * 路由挂在 `/student-attendances`（与 `sign.controller.ts` 同一个挂载点，
 * 子路径 `:id/review`、`review-batch` 不与通用 CRUD 的 `:id` / `:id/transition` 冲突）。
 *
 * 权限：**`attendance:approve`** —— 即「教务审核」这个既有权限点（教师履约的
 * 「待教师确认 → 教务已审核」用的就是它）。为什么不用模块级 `module:attendance:update`：
 * 生产角色矩阵实测该权限点同时挂在**教师本人 / student / 学生事务**上，
 * 用它会导致学生能自己批自己的出勤（2026-09-14 核对 role_permission_config 后确定）。
 * 持有 `attendance:approve` 的角色：系统管理员 / 院级管理 / 教务。
 */

const TABLE = TABLES.attendance.tableId;
const APPROVE_PERM = 'attendance:approve';
const MAX_BATCH = 500;
const MAX_COMMENT = 500;
const READONLY = new Set<string>(['创建时间', '更新时间']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/** 本地时间 "YYYY-MM-DD HH:mm"（与库内其它日期字段的可读形态一致，前端 formatDateTime 也认） */
function nowText(at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

@Injectable()
export class AttendanceReviewService {
  private readonly logger = new Logger(AttendanceReviewService.name);

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly audit: AuditService,
  ) {}

  /** 审核人：取当前登录用户，**不接受前端传入**（前端传了也会被这里覆盖） */
  private reviewerOf(user: SessionUser): string {
    return user.name || user.openId || 'unknown';
  }

  private assertPerm(user: SessionUser): void {
    if (!authorize(toPrincipal(user), APPROVE_PERM).allowed) {
      throw new ForbiddenException('FORBIDDEN:' + APPROVE_PERM);
    }
  }

  /** status 只接受「已通过」/「已驳回」：待审核不在这里设，避免绕过审核链路把记录改回未审 */
  private normalizeStatus(status: string | undefined): ReviewStatus {
    const s = String(status ?? '').trim();
    if (s === REVIEW_APPROVED || s === REVIEW_REJECTED) return s;
    throw new BadRequestException(`VALIDATION:status 只能是「${REVIEW_APPROVED}」或「${REVIEW_REJECTED}」`);
  }

  private normalizeComment(comment: string | undefined): string {
    const s = String(comment ?? '').trim();
    // 驳回必须写理由：终态不可回退，没有理由的驳回下游无法申诉（与教师履约同一判据）
    if (s.length > MAX_COMMENT) throw new BadRequestException(`VALIDATION:审核意见最多 ${MAX_COMMENT} 字`);
    return s;
  }

  /** 审核一条考勤记录，返回更新后的记录（前端就地刷新行） */
  async review(user: SessionUser, id: string, dto: ReviewAttendanceDto) {
    this.assertPerm(user);
    const recordId = String(id ?? '').trim();
    if (!recordId) throw new BadRequestException('VALIDATION:id 必填');
    const status = this.normalizeStatus(dto.status);
    const comment = this.normalizeComment(dto.comment);
    if (status === REVIEW_REJECTED && !comment) {
      throw new BadRequestException('VALIDATION:驳回必须填写审核意见');
    }

    const before = await this.base.get(TABLE, recordId);
    if (!before) throw new NotFoundException('NOT_FOUND');

    const previous = reviewStatusOf(before.fields['审核状态']);
    const fields: Record<string, unknown> = {
      审核状态: status,
      审核人: this.reviewerOf(user),
      审核时间: nowText(),
      // 始终覆盖：否则「先驳回写了意见、后通过」会留着上一次的驳回理由，读起来像自相矛盾
      审核意见: comment,
    };
    await this.base.update(TABLE, recordId, fields);

    // 终态审核要留痕：谁在什么时候把哪条记录从什么状态改成了什么状态
    void this.audit.log({
      actor: this.reviewerOf(user),
      action: '更新',
      module: 'student-attendances',
      recordId,
      summary: `考勤终态审核：${previous} → ${status}`,
      detail: `审核状态,审核人,审核时间${comment ? ',审核意见' : ''}`,
    });

    const after = await this.base.get(TABLE, recordId);
    if (!after) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(after, READONLY, new Set());
  }

  /**
   * 批量审核（勾选后一次提交）。
   * 逐条写、失败的单独计数不中断整体 —— 某条被别处删掉了不该让整批白干。
   */
  async reviewBatch(user: SessionUser, dto: ReviewAttendanceBatchDto) {
    this.assertPerm(user);
    const status = this.normalizeStatus(dto.status);
    const comment = this.normalizeComment(dto.comment);
    if (status === REVIEW_REJECTED && !comment) {
      throw new BadRequestException('VALIDATION:驳回必须填写审核意见');
    }
    const ids = [...new Set((dto.ids ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!ids.length) throw new BadRequestException('VALIDATION:ids 不能为空');
    if (ids.length > MAX_BATCH) throw new BadRequestException(`VALIDATION:一次最多审核 ${MAX_BATCH} 条`);

    const reviewer = this.reviewerOf(user);
    const at = nowText();
    let ok = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const rec = await this.base.get(TABLE, id);
        if (!rec) {
          failed.push(id);
          continue;
        }
        await this.base.update(TABLE, id, {
          审核状态: status,
          审核人: reviewer,
          审核时间: at,
          审核意见: comment,
        });
        ok += 1;
      } catch (e) {
        failed.push(id);
        this.logger.warn(`批量审核单条失败 id=${id}：${(e as Error).message.slice(0, 120)}`);
      }
    }

    if (ok > 0) {
      void this.audit.log({
        actor: reviewer,
        action: '更新',
        module: 'student-attendances',
        recordId: `${ok} 条`,
        summary: `考勤终态审核（批量）：${status}`,
        detail: comment ? `审核意见: ${comment}` : '审核状态,审核人,审核时间',
      });
    }
    return { ok, failed: failed.length, failedIds: failed.slice(0, 20), status };
  }
}
