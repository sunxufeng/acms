import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { modulePermission, REPORT_MODULE_KEYS } from '@acms/contracts';
import { authorize } from '@acms/domain';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { WeilingService } from './weiling.service.js';

/** 卫瓴联系人：只读。刻意不提供 create / update / delete，接口层就没有写入能力。 */
@UseGuards(SessionGuard)
@Controller('weiling')
export class WeilingController {
  constructor(@Inject(WeilingService) private readonly svc: WeilingService) {}

  private static requireRead(user: SessionUser): void {
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:weilingContacts:read').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingContacts:read', HttpStatus.FORBIDDEN);
    }
  }

  /**
   * 「报表 → 招生分析」专用：认 `module:reportWeiling:read` **或** `module:weilingContacts:read`。
   *
   * 为什么要单独一条：`/weiling/analyze` 是**报表**的数据源，而原先它复用
   * `requireRead`（只认 `weiling:read` —— 那是「联系人管理」模块的权限点），
   * 结果**除系统管理员外所有角色都能看见报表卡片、点进去却 403**
   * （2026-09-14 吴倩反馈；实测 8 个角色全中，全站只有系统管理员有 `weiling:read`）。
   *
   * 2026-09-19 起报表改为**按报表授权**：招生分析有自己的权限点 `module:reportWeiling:read`，
   * 所以这里改认它。「联系人管理」的人（`module:weilingContacts:read`）仍可看分析 ——
   * 他们本来就能看到线索明细，看聚合不构成越权。
   *
   * 收口原则：**能看见这张报表的人就该能取到它的数据**；
   * 而联系人明细（列表 / 详情 / 字段 / 同步）仍只认 `weiling:read` + `module:weilingContacts:read`，
   * 不因为能看报表就顺带拿到线索明细的读取权。
   */
  private static requireReportRead(user: SessionUser): void {
    const principal = { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
    const need = modulePermission(REPORT_MODULE_KEYS.weiling, 'read');
    if (authorize(principal, need).allowed || authorize(principal, 'module:weilingContacts:read').allowed) return;
    throw new HttpException(`FORBIDDEN:${need}`, HttpStatus.FORBIDDEN);
  }

  /** 字段描述（中文名 + 枚举选项），前端用它渲染详情与翻译自定义字段 */
  @Get('fields')
  fields(@Req() req: Request, @Query('refresh') refresh?: string) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return this.svc.fields(refresh === '1');
  }

  /**
   * 筛选下拉的可选值（客户阶段 / 来源渠道 / 归属人），取自**本地联系人表的实际取值**。
   * 不用字段描述的枚举 —— 那套 options 是 `{label: 数字编码, value: 中文名}`，
   * 前端取 label 就会显示成数字；而且渠道有父子层级，缓存的枚举值跟表里存的值对不上，
   * 拿它做筛选项会一条都筛不出来。
   */
  @Get('contact-filter-options')
  contactFilterOptions(@Req() req: Request) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return this.svc.contactFilterOptions();
  }

  @Get('sync-status')
  syncStatus(@Req() req: Request) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return { ...this.svc.syncStatus(), progress: this.svc.progressStatus(), lost: this.svc.lostStatus() };
  }

  /** 招生分析（报表用）：多维度聚合，支持按人/渠道/阶段/时间筛选。权限：`report:read` 或 `weiling:read` */
  @Get('analyze')
  analyze(
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('owner') owner?: string,
    @Query('channel') channel?: string,
    @Query('stage') stage?: string,
    /** 线索状态：`1` 已认领 / `4` 待分配 / `0` 待认领（公海），码值口径见 contracts 的 weilingStatusLabel */
    @Query('status') status?: string,
  ) {
    WeilingController.requireReportRead((req as Request & { user: SessionUser }).user);
    return this.svc.analyze({ from, to, 归属人: owner, 来源渠道: channel, 客户阶段: stage, 状态: status });
  }

  /** 某个联系人的跟进记录（详情页内嵌展示，按时间倒序） */
  @Get('progress')
  progress(@Req() req: Request, @Query('contactId') contactId?: string) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return this.svc.progressOf(String(contactId ?? ''));
  }

  /** 后台同步跟进记录（量很大，异步执行；用 sync-status 看进度） */
  @Post('sync-progress')
  syncProgress(@Req() req: Request, @Query('full') full?: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:weilingContacts:update').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingContacts:update', HttpStatus.FORBIDDEN);
    }
    return this.svc.syncProgress(full !== '0');
  }

  /**
   * 同步流失状态（后台异步，用 sync-status 的 lost 字段看进度）。
   * 流失状态只在客户接口 `/openapi/customer/get` 里有，联系人接口不返回。
   */
  @Post('sync-lost')
  syncLost(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:weilingContacts:update').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingContacts:update', HttpStatus.FORBIDDEN);
    }
    return this.svc.syncLost();
  }

  /** 重算与 ACMS 学生档案的疑似匹配（不访问上游，只扫本地库） */
  @Post('match')
  match(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:weilingContacts:update').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingContacts:update', HttpStatus.FORBIDDEN);
    }
    return this.svc.matchStudents();
  }

  /**
   * 补「招生负责老师」（2026-09-26 峰哥需求）。
   *
   * 口径：联系人已匹配到学生时，该联系人的「归属人」经「归属人映射」能得到 ACMS 用户
   * （= 招生老师）⇒ **学生的「招生负责老师」为空就填上**，已有值不动（老师可自由改）。
   *
   * 为什么单独一个入口：自动同步只在**新建立关联**时补（避免老师手工清空后又被同步填回来），
   * 存量数据要用这个显式动作补一次。幂等：重复点只会补新增的空值。
   */
  @Post('fill-recruiter')
  fillRecruiter(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:weilingContacts:update').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingContacts:update', HttpStatus.FORBIDDEN);
    }
    return this.svc.matchStudents({ fillRecruiter: 'always' });
  }

  /**
   * 重算联系人的「跟进次数」（不访问上游，只扫本地库）。
   * 该字段是同步时写回的缓存快照，会与跟进记录表漂移；权限与其它维护动作一致（weiling:sync）。
   */
  @Post('recount-follows')
  recountFollows(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:weilingContacts:update').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingContacts:update', HttpStatus.FORBIDDEN);
    }
    return this.svc.recountFollows();
  }

  /** 手动触发同步（会真实拉取上游，限管理员：weiling:sync） */
  @Post('sync')
  sync(@Req() req: Request, @Query('full') full?: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:weilingContacts:update').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingContacts:update', HttpStatus.FORBIDDEN);
    }
    return this.svc.syncAll(full !== '0');
  }
}
