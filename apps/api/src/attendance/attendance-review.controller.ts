import { Controller, Post, Param, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { AttendanceReviewService } from './attendance-review.service.js';
import type { ReviewAttendanceDto, ReviewAttendanceBatchDto } from './attendance.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

/**
 * 学生考勤记录的终态审核入口。
 *
 * 路由挂在通用 CRUD 的 `/student-attendances` 之下（与 `sign.controller.ts` 同一套路），
 * 子路径不与 `:id` / `:id/transition` 冲突。审核人取会话里的当前登录用户，
 * 前端只传 status / comment。
 */
@Controller('student-attendances')
@UseGuards(SessionGuard)
export class AttendanceReviewController {
  constructor(private readonly svc: AttendanceReviewService) {}

  /** 单条审核：POST /student-attendances/:id/review { status, comment? } */
  @Post(':id/review')
  review(@Req() req: Request, @Param('id') id: string, @Body() dto: ReviewAttendanceDto) {
    return this.svc.review(userOf(req), id, dto);
  }

  /** 批量审核：POST /student-attendances/review-batch { ids, status, comment? } */
  @Post('review-batch')
  reviewBatch(@Req() req: Request, @Body() dto: ReviewAttendanceBatchDto) {
    return this.svc.reviewBatch(userOf(req), dto);
  }
}
