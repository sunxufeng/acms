/**
 * 学生支持看板 —— HTTP 层与建表（2026-09-29 峰哥需求）。
 *
 * ## 路由设计
 *
 * ```
 * GET  /student-support/board                 看板聚合（一次返回全部行）
 * GET  /student-support/owner-options         负责人候选（挂本模块读权限，避免直连 /users 403）
 * GET  /student-support/student-options       可登记的学生候选（**含没上板的**，登记弹窗用）
 * GET  /student-support/:studentId            支持卡详情（信号证据 + 时间线 + 动作）
 * POST /student-support/:studentId/claim      认领（可带问题登记字段，一步到位）
 * PUT  /student-support/:studentId            登记 / 更新问题
 * POST /student-support/:studentId/resolve    已缓解 / 关闭 / 升级
 * ```
 *
 * ⚠️ `board` / `owner-options` / `student-options` 都是**静态路由，必须排在 `@Get(':studentId')`
 *    之前** —— 否则会被 `:studentId` 吃掉，把 "board" 当成学生 id（套件红线）。
 *
 * ## 权限
 *
 * 全部接口走 `module:studentSupport:read`（**含写动作**）。为什么写不给单独的 update 点：
 * 生产实测**教职工角色的 `:update` 点交集为空**（dailyFollowups 只有 6 个角色、
 * studentRecords 另 8 个且不含院级管理）⇒ 没有任何"所有老师都持有"的写权限点可当继承源，
 * 硬找一个会让老师点「认领」直接 403（上线即残废、且前后端不一致极难自查）。
 * 数据面另有 `supportInScope` 兜住：看不到的学生不能读也不能写。
 * 详见 `packages/contracts/src/module-permissions.ts` 文件头 v9。
 */
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  type OnModuleInit,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { TABLES, type SessionUser } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { SessionGuard } from '../auth/session.guard.js';
import { StudentSupportService } from './student-support.service.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('student-support')
@UseGuards(SessionGuard)
class StudentSupportController {
  constructor(private readonly svc: StudentSupportService) {}

  /** 看板聚合。（静态路由，**必须**在 :studentId 之前） */
  @Get('board')
  board(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.board(userOf(req), {
      campus: q['campus'] ?? '',
      owner: q['owner'] ?? '',
      signal: q['signal'] ?? '',
      mine: q['mine'] ?? '',
    });
  }

  /**
   * 「谁能当负责人」的候选（用户表里有飞书 Open ID 的人）。
   *
   * 为什么不直接调 `/users`：那个接口属别的模块的权限点，普通老师打它 403
   * ⇒ 下拉空白（看起来像"一个老师都没有"）。套件「模块与页面开发/05」第 4 节踩过。
   * 静态路由同样要排在 `:studentId` 之前。
   */
  @Get('owner-options')
  ownerOptions(@Req() req: Request) {
    return this.svc.ownerOptions(userOf(req));
  }

  /**
   * 「我可以给谁登记」的候选（登记弹窗的学生选择器）。
   *
   * 🔴 含**没上板**的学生 —— 老师要主动登记一个看板上没有的学生时，只有这个入口。
   * 🔴 范围与 `board` 同一份判据（老师不能给范围外的学生登记）。
   * ⚠️ 静态路由，同样必须在 `:studentId` 之前。
   */
  @Get('student-options')
  studentOptions(@Req() req: Request) {
    return this.svc.studentOptions(userOf(req));
  }

  /** 支持卡详情 */
  @Get(':studentId')
  detail(@Req() req: Request, @Param('studentId') studentId: string) {
    return this.svc.detail(userOf(req), studentId);
  }

  /** 认领（可同时带上问题登记；幂等键 = 学生） */
  @Post(':studentId/claim')
  claim(
    @Req() req: Request,
    @Param('studentId') studentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.save(userOf(req), studentId, { ...normalize(body), status: '跟进中' });
  }

  /** 登记 / 更新问题（未传的字段不动） */
  @Put(':studentId')
  save(
    @Req() req: Request,
    @Param('studentId') studentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.save(userOf(req), studentId, normalize(body));
  }

  /** 已缓解 / 关闭 / 升级 */
  @Post(':studentId/resolve')
  resolve(
    @Req() req: Request,
    @Param('studentId') studentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.resolve(userOf(req), studentId, {
      status: typeof body['status'] === 'string' ? body['status'] : undefined,
      note: typeof body['note'] === 'string' ? body['note'] : undefined,
      owner: typeof body['owner'] === 'string' ? body['owner'] : undefined,
    });
  }

  /**
   * 「移除卡片」= 忽略 / 恢复（v10，2026-09-30 峰哥要求）。
   *
   * 权限是**另一个点** `module:studentSupportRemove:read`（不是 studentSupport）——
   * 破坏性操作，只给显式授予的角色（默认只有系统管理员）。
   * `on: false` 即恢复。
   */
  @Post(':studentId/dismiss')
  dismiss(
    @Req() req: Request,
    @Param('studentId') studentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.dismiss(userOf(req), studentId, {
      reason: typeof body['reason'] === 'string' ? body['reason'] : undefined,
      on: body['on'] === undefined ? true : Boolean(body['on']),
    });
  }
}

/**
 * 请求体归一。
 *
 * 🔴 只在**传了**的时候放进对象（`undefined` 与"没这个键"在 `save` 里含义不同：
 *    没传 = 不动该字段，传空串 = 显式清空）。`exactOptionalPropertyTypes` 下
 *    直接塞 `undefined` 还会让"未传"与"传了 undefined"混在一起。
 */
function normalize(body: Record<string, unknown>): {
  problemType?: string;
  severity?: string;
  problemText?: string;
  owner?: string;
  dueMs?: number;
  note?: string;
  status?: string;
  source?: string;
} {
  const out: Record<string, unknown> = {};
  const str = ['problemType', 'severity', 'problemText', 'owner', 'note', 'status', 'source'];
  for (const k of str) {
    const v = body[k];
    if (typeof v === 'string') out[k] = v;
  }
  if (body['dueMs'] != null) out['dueMs'] = Number(body['dueMs']) || 0;
  return out as ReturnType<typeof normalize>;
}

@Module({
  controllers: [StudentSupportController],
  providers: [StudentSupportService],
  // 定时任务（`看板快照`）要调 `StudentSupportService.snapshot()` ⇒ 必须导出。
  // ⚠️ 注意依赖方向：本模块**不** import 定时任务模块，所以不会成环。
  exports: [StudentSupportService],
})
export class StudentSupportModule implements OnModuleInit {
  private readonly logger = new Logger('StudentSupport');

  /**
   * 建「学生支持」表（幂等）。
   *
   * ⚠️ 纯 PG 自建表：字段类型**一律用 1（文本）/ 2（数字）**，不用 3（单选）/18（关联）——
   *    枚举约束与关联解析都在本模块的代码里（校验 + JSONB 数组），
   *    PG 侧只要能把值原样存取即可。这与 IDP 两张新表的做法一致
   *    （见 `identity` 的教训：类型写错会让读取侧被格式化，值静默变样）。
   * ⚠️ 建表失败**不阻断启动**：看板页会报错，其余功能不受影响。
   */
  async onModuleInit(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[studentSupport] 未配置 DATABASE_URL，跳过建表');
      return;
    }
    try {
      await sql.ensureTable(TABLES.studentSupport.tableId, TABLES.studentSupport.name, [
        { name: '关联学生', type: 1 },
        { name: '学生姓名', type: 1 },
        { name: '支持状态', type: 1 },
        { name: '问题类型', type: 1 },
        { name: '严重程度', type: 1 },
        { name: '问题描述', type: 1 },
        { name: '负责跟进', type: 1 },
        { name: '负责来源', type: 1 },
        { name: '期望回应日期', type: 2 },
        { name: '认领时间', type: 2 },
        { name: '关闭时间', type: 2 },
        { name: '处理备注', type: 1 },
        { name: '来源', type: 1 },
        { name: '更新人', type: 1 },
        { name: '更新时间', type: 2 },
        // v10（2026-09-30）「移除卡片」= 忽略：不是删数据，藏起来 + 记下原因，可恢复
        { name: '已忽略', type: 1 },
        { name: '忽略原因', type: 1 },
        { name: '忽略人', type: 1 },
        { name: '忽略时间', type: 2 },
      ]);
      this.logger.log('[studentSupport] 学生支持表已就绪');
    } catch (e) {
      this.logger.error(`[studentSupport] 建表失败: ${(e as Error).message}`);
    }
  }
}

