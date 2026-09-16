import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { requireModule } from '../shared/require-module.js';
import { ExamGradeService, SUBJECT_NONE, type ReportCardData } from './exam-grade.service.js';
import { renderReportCardPdf } from './exam-grade.pdf.js';

/**
 * 考试与成绩的「专用接口」。
 *
 * 通用 CRUD（考核类型 / 成绩批次 / 期末总评 / 成绩单四张表）由
 * `GenericCrudModule.registerAll(EXAM_GRADE_METAS)` 承载；这里放它表达不了的动作：
 *
 *  1. `GET  exam-grades/batches`        —— 批次下拉
 *  2. `GET  exam-grades/subjects`       —— 该班可用科目（取**实际去重值**，不读字典）
 *  3. `GET  exam-grades/preview`        —— 结转**预览**（不落库）
 *  4. `POST exam-grades/roll`           —— 一键结转（幂等 upsert，已确认跳过）
 *  5. `POST exam-grades/confirm[/:id]`  —— 确认单条 / 批量确认（状态流转）
 *  6. `POST exam-grades/undo/:id`       —— 撤销确认
 *  7. `POST exam-grades/adjust/:id`     —— 手工调分（记原自动值可还原）
 *  8. `POST exam-grades/restore/:id`    —— 还原自动值
 *  9. `GET  exam-grades/term-grades`    —— 期末总评列表（评语页用）
 * 10. `POST exam-grades/comments`       —— 批量保存各科评语（失焦即存）
 * 11. `POST exam-grades/summary-comment`—— 班主任总评语
 * 12. `GET  exam-grades/anomalies`      —— 异常成绩审查（只提示，不改分）
 * 13. `GET  exam-grades/report-card`    —— 成绩单数据（屏幕预览）
 * 14. `GET  exam-grades/report-card.pdf`—— 成绩单 PDF（服务端生成，零系统依赖）
 *
 * 权限一律「模块 × 动作」：
 *   读 = `module:examGrades:read`；写 = `:update`；
 *   确认 / 撤销 = `:transition`（状态流转）；导出 = `:export`。
 *
 * ⚠️ 静态路由必须排在参数路由之前 —— 否则 `/report-card.pdf` 会被吃成 `:id`。
 *    这里没有 `@Get(':id')`，但仍按这个顺序写，避免以后加详情接口时踩坑。
 */
@Controller('exam-grades')
@UseGuards(SessionGuard)
export class ExamGradeController {
  constructor(private readonly svc: ExamGradeService) {}

  // ── 读 ───────────────────────────────────────────────────────

  /** 批次下拉（读） */
  @Get('batches')
  batches(@Req() req: { user: SessionUser }) {
    requireModule(req.user, 'examGrades', 'read');
    return this.svc.listBatches();
  }

  /** 该班可用科目（读） */
  @Get('subjects')
  subjects(@Req() req: { user: SessionUser }, @Query('cls') cls: string) {
    requireModule(req.user, 'examGrades', 'read');
    return this.svc.subjectOptions(cls ?? '');
  }

  /** 结转预览（读，不落库） */
  @Get('preview')
  preview(
    @Req() req: { user: SessionUser },
    @Query('batchId') batchId: string,
    @Query('cls') cls: string,
    @Query('subject') subject?: string,
  ) {
    requireModule(req.user, 'examGrades', 'read');
    return this.svc.preview(batchId ?? '', cls ?? '', subject ?? '');
  }

  /** 期末总评列表（读；评语页/成绩单页用） */
  @Get('term-grades')
  termGrades(
    @Req() req: { user: SessionUser },
    @Query('batchId') batchId: string,
    @Query('cls') cls?: string,
    @Query('subject') subject?: string,
    @Query('onlyMissingComment') onlyMissingComment?: string,
  ) {
    requireModule(req.user, 'examGrades', 'read');
    return this.svc.listTermGrades({
      batchId: batchId ?? '',
      cls,
      subject,
      onlyMissingComment: onlyMissingComment === '1' || onlyMissingComment === 'true',
    });
  }

  /** 异常成绩审查（读） */
  @Get('anomalies')
  anomalies(
    @Req() req: { user: SessionUser },
    @Query('batchId') batchId: string,
    @Query('cls') cls: string,
  ) {
    requireModule(req.user, 'examGrades', 'read');
    return this.svc.anomalies(batchId ?? '', cls ?? '');
  }

  /** 成绩单数据（读；屏幕预览用） */
  @Get('report-card')
  reportCard(
    @Req() req: { user: SessionUser },
    @Query('studentId') studentId: string,
    @Query('batchId') batchId: string,
  ) {
    requireModule(req.user, 'examGrades', 'read');
    return this.svc.buildReportCard(studentId ?? '', batchId ?? '');
  }

  /**
   * 成绩单 PDF（导出）。
   *
   * 🔴 导出必须**单独**判一次可见性 —— 历史踩过「列表 33 条、导出 82 条」。
   *    学生不在当前用户的学生数据范围内时返回 404（与该模块既有约定一致）。
   *    这里用 `buildReportCard` 的结果做存在性判据就足够了：它按（学生 × 批次）取，
   *    通用 CRUD 层已经给期末总评加了 `studentScoped`，取不到就说明越权或本来就没有。
   */
  @Get('report-card.pdf')
  async reportCardPdf(
    @Req() req: { user: SessionUser },
    @Res() res: any,
    @Query('studentId') studentId: string,
    @Query('batchId') batchId: string,
  ) {
    requireModule(req.user, 'examGrades', 'export');
    const data: ReportCardData | null = await this.svc.buildReportCard(studentId ?? '', batchId ?? '');
    if (!data) {
      res.status(404).json({ message: '找不到该学生的成绩单（批次或学生不存在，或你没有权限查看）' });
      return;
    }
    const buf = await renderReportCardPdf(data);
    // 中文文件名走 RFC 5987（filename*）；ASCII 兜底给老浏览器
    const cn = `成绩单_${data.studentName}_${data.cls || ''}_${data.batchName}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-card.pdf"; filename*=UTF-8''${encodeURIComponent(cn)}`,
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);

    // 留痕：生成时间 / 生成人 / 导出次数 +1（失败不影响下载）
    try {
      await this.svc.markExported(data.batchId, data.studentId, req.user?.name ?? '', {
        studentName: data.studentName,
        cls: data.cls,
      });
    } catch {
      /* 留痕失败不当成下载失败 */
    }
  }

  // ── 写 ───────────────────────────────────────────────────────

  /** 一键结转（写） */
  @Post('roll')
  roll(
    @Req() req: { user: SessionUser },
    @Body() body: { batchId?: string; cls?: string; subject?: string },
  ) {
    requireModule(req.user, 'examGrades', 'update');
    return this.svc.roll(body?.batchId ?? '', body?.cls ?? '', body?.subject ?? '', req.user?.name ?? '');
  }

  /** 批量保存评语（写） */
  @Post('comments')
  comments(
    @Req() req: { user: SessionUser },
    @Body() body: { rows?: { id: string; comment: string; status?: string }[] },
  ) {
    requireModule(req.user, 'examGrades', 'update');
    return this.svc.saveComments(body?.rows ?? []);
  }

  /** 班主任总评语（写） */
  @Post('summary-comment')
  summaryComment(
    @Req() req: { user: SessionUser },
    @Body()
    body: { batchId?: string; studentId?: string; comment?: string; studentName?: string; cls?: string },
  ) {
    requireModule(req.user, 'examGrades', 'update');
    return this.svc.saveSummaryComment(
      body?.batchId ?? '',
      body?.studentId ?? '',
      body?.comment ?? '',
      { studentName: body?.studentName ?? '', cls: body?.cls ?? '' },
    );
  }

  /** 手工调分（写） */
  @Post('adjust/:id')
  adjust(
    @Req() req: { user: SessionUser },
    @Param('id') id: string,
    @Body() body: { total?: number; reason?: string },
  ) {
    requireModule(req.user, 'examGrades', 'update');
    return this.svc.adjust(id, Number(body?.total), body?.reason ?? '');
  }

  /** 还原自动值（写） */
  @Post('restore/:id')
  restore(@Req() req: { user: SessionUser }, @Param('id') id: string) {
    requireModule(req.user, 'examGrades', 'update');
    return this.svc.restore(id);
  }

  /** 确认单条（状态流转） */
  @Post('confirm/:id')
  confirm(@Req() req: { user: SessionUser }, @Param('id') id: string) {
    requireModule(req.user, 'examGrades', 'transition');
    return this.svc.confirm(id, req.user?.name ?? '');
  }

  /** 批量确认（状态流转） */
  @Post('confirm-all')
  confirmAll(
    @Req() req: { user: SessionUser },
    @Body() body: { batchId?: string; cls?: string; subject?: string },
  ) {
    requireModule(req.user, 'examGrades', 'transition');
    return this.svc.confirmAll(body?.batchId ?? '', body?.cls ?? '', body?.subject ?? '', req.user?.name ?? '');
  }

  /** 撤销确认（状态流转） */
  @Post('undo/:id')
  undo(@Req() req: { user: SessionUser }, @Param('id') id: string) {
    requireModule(req.user, 'examGrades', 'transition');
    return this.svc.undo(id);
  }
}

export { SUBJECT_NONE };
