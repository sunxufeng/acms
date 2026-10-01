import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
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

  /**
   * 「联系人 → 转入学生档案」的判据：**两个权限点都要**（2026-09-30）。
   *
   * 动作实质 = 读联系人 + 往学生档案**建一条记录**，所以：
   *   · `module:weilingEnroll:update` —— 这是"把线索变成学生"这件事本身的许可
   *     （`legacyRead: null`，只手工勾给招生老师）；
   *   · `module:students:create` —— 建学生档案的许可。
   *
   * 🔴 为什么两个都判、而不是只判 `weilingEnroll`：只判前者时，若某个角色有入学点
   *    但没有建学生点，请求会在 `StudentService.create()` 里才 403 ——
   *    那时错误已经"离按钮很远"，前端只能显示一句莫名的失败。
   *    在这里判，403 的 message 能直接说清**缺的是哪一个**。
   * 🔴 为什么不用 `module:weilingContacts:update` 代替 `weilingEnroll`：
   *    能"维护联系人"（同步 / 重算 / 重匹配）的人不该自动获得"建学生档案"的能力，
   *    两者受众与后果都不同。详见 contracts 里该权限点的注释。
   */
  private static requireEnroll(user: SessionUser): void {
    const principal = { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
    if (!authorize(principal, 'module:weilingEnroll:update').allowed) {
      throw new HttpException('FORBIDDEN:module:weilingEnroll:update', HttpStatus.FORBIDDEN);
    }
    if (!authorize(principal, 'module:students:create').allowed) {
      throw new HttpException('FORBIDDEN:module:students:create', HttpStatus.FORBIDDEN);
    }
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
   * 「卫瓴映射」配置（v13）：读 / 试算 / 存。
   *
   * 🔴 判的是**独立权限点** `module:weilingMapping:read/:update`，不是 `weilingContacts` 的读写：
   *    改这份配置等于改**以后每个转档学生**的字段值（来源渠道 / 生源跟进状态 / 原学校类型 /
   *    入学年月 / 付款状态），是"口径级"的操作，与"能不能维护联系人"受众不同。
   * 🔴 三个都是**静态路由**，必须排在 `@Get('contacts/:id/…')` 这类带参数的路由之前 ——
   *    否则 `mapping` 会被当成某个 id（静默 404）。本 controller 里 `mapping` 无同名参数段，
   *    但仍按惯例前置，避免以后加 `@Get(':id')` 时踩。
   */
  /**
   * 学生详情页「招生来源」（二期）：反查这个学生是从哪个卫瓴联系人转来的。
   *
   * 🔴 权限只判 `students:read`（看学生的人就该看到"他来自哪"）；
   *    返回里**不含联系方式** —— 那是联系人模块的数据。
   * ⚠️ 静态路由，排在带参数路由之前。
   */
  @Get('students/:studentId/source')
  studentSource(@Req() req: Request, @Param('studentId') studentId: string) {
    return this.svc.sourceOfStudent((req as Request & { user: SessionUser }).user, String(studentId));
  }

  @Get('mapping')
  mappingGet(@Req() req: Request) {
    return this.svc.mappingGet((req as Request & { user: SessionUser }).user);
  }

  /** 用提交的配置试算（**不保存**）：看这样配能填上多少条、还有哪些取值没配 */
  @Post('mapping/preview')
  mappingPreview(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.mappingPreview((req as Request & { user: SessionUser }).user, body ?? {});
  }

  /** 保存映射（整体替换；归一化后存，存进去的就是生效的那份） */
  @Put('mapping')
  mappingSave(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.mappingSave((req as Request & { user: SessionUser }).user, body ?? {});
  }

  /**
   * 转档预览：把「会写进学生档案的每一格、它的来源、同名学生、已有关联」一次取全。
   *
   * 🔴 **不写任何数据**，是给确认弹窗用的。为什么单独一个接口而不是让前端自己算：
   *    判据（哪些能填 / 能不能映射 / 姓名是否可用）在 contracts 里**只有一份**，
   *    前端重算一遍必然与后端不一致 —— 就会出现"弹窗说会填、实际没填"。
   */
  @Get('contacts/:id/enroll-preview')
  enrollPreview(@Req() req: Request, @Param('id') id: string) {
    WeilingController.requireEnroll((req as Request & { user: SessionUser }).user);
    return this.svc.enrollPreview(String(id));
  }

  /**
   * 转入学生档案。两种模式：
   *   · 默认 —— 新建一条学生档案；
   *   · 传了 `linkExistingStudentId` —— **关联到已存在的学生**（重名分支），
   *     只补空的「招生负责老师」，不新建、不改动其它字段。
   *
   * 返回 `steps[]`：逐条说明"哪一格写进去了、哪一格为什么跳过"，用户要看这个。
   */
  @Post('contacts/:id/enroll')
  enroll(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    body: {
      picked?: Record<string, boolean>;
      overrides?: Record<string, string>;
      linkExistingStudentId?: string;
      backfill?: { sourceFollowups?: boolean; mail?: boolean };
    },
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    WeilingController.requireEnroll(user);
    return this.svc.enroll(user, String(id), body ?? {});
  }

  /**
   * **取消关联**（2026-10-01 峰哥）：这条联系人和这个学生没关系。
   *
   * 起因：联系人「丁点儿-万美妗妈妈转介绍」被自动关联到了学生「万美妗」，
   * 但那其实是**妈妈的朋友**在推荐 —— 而系统里原先根本没有取消关联的功能。
   *
   * 三件事一起做才算真的取消（缺一个这个功能就是假的）：
   *   ① 清 `关联学生` + `关联学生ID`（只清一个 = 悬空壳值）；
   *   ② 把 `关联来源` 置为 **已忽略** —— 否则下一轮同步（每天 07:00）会原样写回来；
   *   ③ 原依据与原因**留痕在 `匹配依据` 里**（以后回看才知道它当初靠什么匹配上的）。
   *
   * 幂等：重复调用返回成功（`already` 标明这次其实没改动）。
   * 权限：复用 `module:weilingContacts:update`（服务内 `loadContactForLink` 里判），
   *      与 sync / match / fill-recruiter 同一档 —— 它只改联系人自己的字段，不碰学生档案。
   * ⚠️ 路由段是 `contacts/:id/unlink`，与 `@Get('contacts/:id/enroll-preview')` 同形，
   *    不会与任何静态路由冲突（本 controller 没有裸 `@Get(':id')`）。
   */
  @Put('contacts/:id/unlink')
  unlink(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.unlinkContact((req as Request & { user: SessionUser }).user, String(id), body ?? {});
  }

  /**
   * **手工关联 / 改为关联到指定学生**：有关系，但不是原来那个。
   *
   * 为什么「取消」之外还必须有它：误关联实际分两类 ——
   *   · 「妈妈的朋友」⇒ 跟谁都没关系 ⇒ 取消；
   *   · 「选错人了，应该是另一个学生」⇒ 只是指错了 ⇒ 改指。
   * 只做取消的话，第二类得先取消再等自动匹配，而取消之后它被标成"已忽略"，
   * **再也匹配不回来** ⇒ 死锁。
   */
  @Put('contacts/:id/relink')
  relink(@Req() req: Request, @Param('id') id: string, @Body() body: { studentId?: string }) {
    return this.svc.relinkContact((req as Request & { user: SessionUser }).user, String(id), body ?? {});
  }

  /**
   * **恢复自动匹配**：把「已忽略 / 人工指定」放回「自动」，让每轮同步重新接管。
   *
   * 没有它，「已忽略」就是单向门 —— 点错了取消之后再也回不到自动匹配。
   */
  @Put('contacts/:id/restore-auto')
  restoreAuto(@Req() req: Request, @Param('id') id: string) {
    return this.svc.restoreAutoLink((req as Request & { user: SessionUser }).user, String(id));
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
