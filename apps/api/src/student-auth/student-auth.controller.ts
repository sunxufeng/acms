import { Controller, Post, Get, Body, Query, Req, Res, UseGuards, ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { LoginRateLimitGuard } from '../auth/rate-limit.guard.js';
import { StudentAuthService } from './student-auth.service.js';
import type {
  StudentLoginDto,
  StudentSetPasswordDto,
  AdminSetStudentPasswordDto,
} from './student-auth.dto.js';

/** 与小程序登录一致的 cookie 种写逻辑 */
function setSessionCookie(res: Response, sid: string, req: Request): void {
  const secure = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() === 'https';
  res.cookie(process.env.SESSION_COOKIE ?? 'acms_sid', sid, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 3600) * 1000,
    path: '/',
  });
}

function toPayload(user: { sessionId: string; studentId?: string; name: string; campuses: string[] }) {
  return {
    ok: true,
    studentId: user.studentId,
    name: user.name,
    campus: user.campuses[0] ?? '',
  };
}

/**
 * 学生密码登录账号接口（B1）。
 *  - POST /student-auth/login              学号 + 密码登录（签发 cookie 会话，角色 student）
 *  - POST /student-auth/set-password       学生自助设密（学号 + 姓名验证身份，成功后登录）
 *  - POST /student-auth/admin/set-password 管理员为学生设密（需会话 + 系统管理员）
 */
@Controller('student-auth')
export class StudentAuthController {
  constructor(private readonly svc: StudentAuthService) {}

  @Post('login')
  @UseGuards(LoginRateLimitGuard)
  async login(@Body() dto: StudentLoginDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const user = await this.svc.login(dto.studentNo ?? '', dto.password ?? '');
    setSessionCookie(res, user.sessionId, req);
    res.json(toPayload(user));
  }

  @Post('set-password')
  @UseGuards(LoginRateLimitGuard)
  async setPassword(@Body() dto: StudentSetPasswordDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const user = await this.svc.setPassword(dto.studentNo ?? '', dto.name ?? '', dto.password ?? '');
    setSessionCookie(res, user.sessionId, req);
    res.json(toPayload(user));
  }

  @Post('admin/set-password')
  @UseGuards(SessionGuard)
  async adminSetPassword(@Req() req: Request, @Body() dto: AdminSetStudentPasswordDto) {
    const user = (req as Request & { user?: { roles?: string[] } }).user;
    if (!user?.roles?.includes('系统管理员')) throw new ForbiddenException('ADMIN_ONLY');
    return this.svc.setPasswordByAdmin(dto.studentNo ?? '', dto.password ?? '');
  }

  @Get('accounts')
  @UseGuards(SessionGuard)
  async accounts(@Req() req: Request) {
    const user = (req as Request & { user?: { roles?: string[] } }).user;
    if (!user?.roles?.includes('系统管理员')) throw new ForbiddenException('ADMIN_ONLY');
    return { items: this.svc.listAccounts() };
  }

  @Get('search')
  @UseGuards(SessionGuard)
  async search(@Req() req: Request, @Query('keyword') keyword?: string) {
    const user = (req as Request & { user?: { roles?: string[] } }).user;
    if (!user?.roles?.includes('系统管理员')) throw new ForbiddenException('ADMIN_ONLY');
    return { items: await this.svc.searchStudents(keyword ?? '') };
  }
}
