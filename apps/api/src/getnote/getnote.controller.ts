import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, Res, UseGuards,
  HttpException, HttpStatus, HttpCode, NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { authorize } from '@acms/domain';
import type { SessionUser, Permission } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { GetnoteService } from './getnote.service.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { sniffAudioFormat, withAudioExt } from '../file-storage/audio-format.js';
import { parseByteRange } from '../file-storage/byte-range.js';

/**
 * 得到大脑（Get笔记）代理控制器。
 *
 * ⚠️ 凭证模型（2026-09-05 二次修正）：**Client ID 与 API Key 都是每人一份**。
 * 官方「5 分钟快速上手」写明「创建应用 → 获取 Client ID 和 API Key」，两者是用户建
 * 应用时成对拿到的，所以不存在「应用级全局一份」的强约束。早期版本把 Client ID 塞进
 * .env，结果不配就整页阻塞在「请联系管理员」，用户什么也做不了 —— 已废弃。
 *
 * 每个请求都带当前用户，service 按 openId 取他自己的凭证对。一人一份还顺带解决了
 * 限流问题：官方限流是**按 Key 算**的（QPS 2 / 每天 5000 次），共用必然撞墙。
 *
 * 两条配置路径，互不依赖：
 * - **手动填入** —— 用户自己建应用，两个值都自己填。不依赖任何服务端配置
 * - **一键授权（OAuth 设备授权）** —— 需要 .env 配 GETNOTE_OAUTH_CLIENT_ID，
 *   这是 OAuth 的固有模型（设备授权需要一个应用身份）。没配时前端自动隐藏该入口
 *
 * ⚠️ 路由顺序：带后缀的子路由必须先声明，否则会被 `:id` 通配吃掉。
 */
@Controller('getnote')
@UseGuards(SessionGuard)
export class GetnoteController {
  constructor(
    private readonly svc: GetnoteService,
    // 音频播放：笔记级可见性校验通过后，从附件目录把字节流返给浏览器
    private readonly fileUpload: FileUploadService,
  ) {}

  /**
   * 判据 = `module:<模块key>:<动作>`。
   * 2026-09-17 从 legacy `getnote:read/write` 收口到 module 体系：
   * 那套旧点界面上看不到（收在「兼容权限点」折叠区），导致「矩阵里没勾、实际却能改」。
   * **本 controller 的接口一律用 `module:getnote:*`** —— 包括「我的凭证」(`/getnote/credential`)
   * 与设备授权 (`/getnote/oauth/*`) 和笔记关联 (`/getnote/links`)。
   *
   * ⚠️ 2026-09-17 踩过：当初按名字把它们当成「配置侧」用了 `module:getnoteSources:*`，
   *    结果「我的笔记」页面一加载就 403（该页 `load()` 会调 `/getnote/credential`，
   *    403 时整页显示「你没有「我的笔记/知识库」的访问权限」）。
   *    **判断接口归属不能看名字，要看「谁在调它」**：
   *      · `/getnote/credential`、`/getnote/oauth/*` → 只有「我的笔记」页在用（我自己的凭证）
   *      · `/getnote/links` → `NotePanel`（家校沟通详情等业务页）与 `CrudPage` 在用
   *      · 真正的「知识库配置」是 `/getnote-sources`（`sources.controller.ts`，通用 CRUD）
   *        → 那里才是 `module:getnoteSources:*`
   */
  private assert(user: SessionUser, perm: Permission) {
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, perm).allowed)
      throw new HttpException(`FORBIDDEN:${perm}`, HttpStatus.FORBIDDEN);
  }

  /**
   * 把当前管理员视角的笔记同步进快照表（报表「笔记统计」的数据源）。
   * 需要 admin:monitor 权限 —— 会真实拉一次上游（受 QPS 2 节流），不能谁都能点。
   */
  @Post('sync-snapshot')
  syncSnapshot(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (
      !authorize(
        { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel },
        'admin:monitor',
      ).allowed
    )
      throw new HttpException('FORBIDDEN:admin:monitor', HttpStatus.FORBIDDEN);
    return this.svc.syncSnapshot(user);
  }

  /**
   * 「重新收取」：把笔记**正文**（智能总结 + 原始记录）批量拉一遍并落库。
   *
   * 为什么异步：上游限速 QPS 2，一条 0.6 秒，几百条要几分钟 ——
   * 同步等会被 nginx 掐成 504。这里 POST 立即返回进度对象，前端轮询 status。
   *
   * 不传 `sourceRecordId` = 收取当前用户可见的全部笔记；传了就只收那一个知识库配置的。
   * 幂等：按笔记 ID upsert，重复点不会产生重复数据（但会重复消耗上游额度）。
   */
  @Post('refetch-bodies')
  @HttpCode(200)
  refetchBodies(@Req() req: Request, @Body() body: { sourceRecordId?: string }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.startRefetchBodies(user, body?.sourceRecordId || undefined);
  }

  /** 查询「重新收取」进度。 */
  @Get('refetch-bodies/status')
  refetchStatus(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    return this.svc.refetchBodiesStatus(user);
  }

  // ── 用户凭证（API Key 一人一份） ────────────────────────────────────

  /** 当前用户的凭证状态 + 服务器 Client ID 是否已配。不返回任何明文。 */
  @Get('credential')
  credential(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    return this.svc.credentialStatus(user);
  }

  /**
   * 保存自己的凭证（Client ID + API Key 都要）。
   * 存之前会先打一次真实请求验活，验不过不落库。
   */
  @Put('credential')
  saveCredential(@Req() req: Request, @Body() body: { apiKey?: string; clientId?: string }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.saveCredential(user, String(body?.apiKey ?? ''), String(body?.clientId ?? ''));
  }

  @Delete('credential')
  clearCredential(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.clearCredential(user);
  }

  // ── OAuth 设备授权（可选；未开启时 start 返回 503，前端据此隐藏入口） ──

  /** 第 1 步：换设备码。返回二维码与 user_code，一次性 code 不下发前端。 */
  @Post('oauth/start')
  startOAuth(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.startOAuth(user);
  }

  /** 第 2 步：前端按 interval 定时轮询，直到 success / expired / rejected。 */
  @Get('oauth/poll')
  pollOAuth(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    return this.svc.pollOAuth(user);
  }

  @Delete('oauth')
  cancelOAuth(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.cancelOAuth(user);
  }

  // ── 笔记 ↔ 业务实体 关联 ────────────────────────────────────────────

  /** 某业务实体（如某个学生）当前关联的笔记。关联记录全员可见，chip 上标注归属人。 */
  @Get('links')
  listLinks(@Req() req: Request, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    this.assert((req as Request & { user: SessionUser }).user, 'module:getnote:read');
    if (!entityType || !entityId)
      throw new HttpException('BAD_REQUEST:entityType/entityId required', HttpStatus.BAD_REQUEST);
    return this.svc.listLinks(entityType, entityId);
  }

  /**
   * 某个学生**所有路径**关联到的笔记 —— 学生详情页聚合面板的数据源（2026-09-22 新增）。
   *
   * 与上面 `@Get('links')` 的区别：那个是「某个业务实体直接绑了哪些笔记」（单跳），
   * 这个是「这个学生**以及他的各类记录**绑了哪些笔记」（多跳 + 来源标注）。
   *
   * ⚠️ 权限点沿用 `module:getnote:read`：它同样是 `NotePanel` 一类界面在用，不是「知识库配置」
   *    —— 判断接口归属要看「谁在调它」，别按名字选权限点（2026-09-17 踩过这个坑）。
   *    这里**不额外要求学生模块权限**：能看到该页面的人已经过了页面级门控，重复加只会让
   *    「有笔记权限、无学生权限」的调用方拿到 403。跨模块的泄漏由 service 内按**来源模块**
   *    逐个 read 权限挡住（没权限的来源整块跳过，不是返回空列表）。
   */
  @Get('links/by-student/:studentId')
  listLinksByStudent(@Req() req: Request, @Param('studentId') studentId: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    if (!studentId) throw new HttpException('BAD_REQUEST:studentId required', HttpStatus.BAD_REQUEST);
    return this.svc.listLinksByStudent(user, studentId);
  }

  /** 全量覆盖式写入关联（传空数组即清空）。与邮件归档「手动关联学生」同一范式。 */
  @Put('links')
  replaceLinks(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    const entityType = String(body?.entityType ?? '');
    const entityId = String(body?.entityId ?? '');
    if (!entityType || !entityId)
      throw new HttpException('BAD_REQUEST:entityType/entityId required', HttpStatus.BAD_REQUEST);
    const links = Array.isArray(body?.links) ? (body.links as { noteId: string; title?: string }[]) : [];
    return this.svc.replaceLinks(
      user,
      entityType,
      entityId,
      String(body?.entityName ?? ''),
      links,
    );
  }

  // ── 笔记 ────────────────────────────────────────────────────────────

  /**
   * 笔记列表。
   *
   * ⚠️ 出站必须转成全站统一的 `Page<T>`（`items/total/hasMore/pageToken`）。
   * service 返回的是 Get笔记 原生结构（`notes/has_more/cursor`），直接透出去的话
   * 前端按 `res.items` 取会拿到 undefined，`res.items.map(...)` 当场抛
   * 「Cannot read properties of undefined (reading 'map')」—— 保存凭证后第一次渲染
   * 列表必炸（未连凭证时页面停在引导页，从没走到这一步，所以藏了很久）。
   *
   * 请求侧同理：CrudPage 翻页传的是 `pageToken`，这里映射成上游的 `cursor`。
   *
   * `total` 的估算：上游不保证返回总数，而 CrudPage 用 `total / pageSize` 推算页数，
   * 只给当前页条数会算出「只有 1 页」，用户永远翻不到下一页。所以 has_more 为真时
   * 按「已拿到的 + 一页」估，翻到下一页后 total 又会被刷新成更大的值（渐进式）。
   */
  @Get('notes')
  async list(
    @Req() req: Request,
    @Query('pageToken') pageToken?: string,
    @Query('q') q?: string,
    @Query('pageSize') pageSize?: string,
    /**
     * 结构化筛选（2026-09-17）。参数名用中文字段名，与列表列 `key` 一一对应
     * —— CrudPage 的筛选控件就是按列 key 拼 query 的（见 `buildParams`）。
     * 前端会对参数名做 percent-encoding；**未编码的中文参数名会被 Node 直接 400**
     * （用 curl 手测时务必 `--data-urlencode`，否则会误判成接口坏了）。
     */
    @Query('来源') source?: string,
    @Query('配置名称') configName?: string,
    @Query('归属人') owner?: string,
    @Query('标签') tag?: string,
    /**
     * 状态（有效 / 归档 / 全部）—— 2026-09-21 新增。
     * 与上面四个同规则：**裸中文参数名**（自建 controller 不认 `__contains` 之类的后缀，
     * 加了后缀会被当未知参数静默忽略）。值来自 contracts 的 `NOTE_STATUS_*`，
     * 「全部」/空 = 不限制；缺行（历史笔记）永远算「有效」。
     */
    @Query('状态') status?: string,
    /**
     * `mine=1` ⇒ 只返回**我自己的笔记**（本人凭证那一路）。见 `NoteListFilters.mine`：
     * 「我的 IDP → 导入笔记」用这个口径（老师只看自己的；管理员不受影响，仍看全部）。
     */
    @Query('mine') mine?: string,
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
    // size 要传进 service：管理员走的是服务端快照分页，得知道每页切多少
    const r = await this.svc.list(user, pageToken, q, size, {
      source,
      configName,
      owner,
      tag,
      status,
      mine: mine === '1' || mine === 'true',
    });
    const items = r.notes ?? [];
    const hasMore = Boolean(r.has_more);
    return {
      items,
      hasMore,
      pageToken: r.cursor,
      total: r.total ?? (hasMore ? items.length + size : items.length),
      // 被「状态」筛选挡掉的条数（列表顶部提示「已隐藏 N 条已归档笔记」用）：
      // 前端拿到的已是筛过的结果，靠减法算不出来，只能服务端给。
      archivedHidden: r.archivedHidden ?? 0,
    };
  }

  /** ⚠️ 必须声明在 @Post('notes/:id/tags') 与 @Get('notes/:id') 之前 */
  @Post('notes/search')
  search(@Req() req: Request, @Body() body: { query?: string; top_k?: number }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    const q = String(body?.query ?? '').trim();
    if (!q) throw new HttpException('BAD_REQUEST:query required', HttpStatus.BAD_REQUEST);
    return this.svc.recall(user, q, body?.top_k);
  }

  @Post('notes')
  create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:create');
    return this.svc.create(user, {
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
      topic_id: body?.topic_id as string | undefined,
      parent_id: body?.parent_id as string | undefined,
    });
  }

  /**
   * 原始音频播放（2026-09-17，方案 A）。
   *
   * 🔴 为什么不直接给前端 `/files/:token` 的链接：那个接口是**登录即可下载**，
   *    而录音是私密内容 —— 任何登录用户拿到 token 就能听别人的会议录音。
   *    这里先让 service 做**笔记级可见性校验**，通过才返流；不通过统一 404
   *    （不区分「不存在」与「无权」，避免被拿来探测）。
   *
   * ⚠️ 必须声明在 `@Get('notes/:id')` 之前，否则 `:id` 通配会先吃掉这条路由。
   */
  @Get('notes/:id/audio')
  async noteAudio(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    const hit = await this.svc.noteAudio(user, id);
    if (!hit) throw new NotFoundException('AUDIO_NOT_FOUND');
    const f = await this.fileUpload.readLocal(hit.token);

    // 以**文件头**为准给 Content-Type：落库时 MIME 是写死的 audio/ogg，而实测 554 个
    // 录音里 40 个实际是 MP3 —— 按 audio/ogg 解 MP3 会解码失败、播放器不出声。
    const sniffed = sniffAudioFormat(f.buffer);
    const mime = sniffed?.mime ?? f.mime ?? 'audio/ogg';
    const name = sniffed ? withAudioExt(hit.name, sniffed.ext) : hit.name;

    // Range 必须支持：录音最长 3 小时 / 单文件 168 MB，全量返流时进度条拖不动，
    // 且 Safari 会直接拒绝播放。
    const range = parseByteRange(req.headers.range, f.buffer.length);
    res.status(range ? 206 : 200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (range) {
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${f.buffer.length}`);
      res.setHeader('Content-Length', String(range.length));
      res.end(f.buffer.subarray(range.start, range.end + 1));
      return;
    }
    res.setHeader('Content-Length', String(f.buffer.length));
    res.end(f.buffer);
  }

  /**
   * 「保存原始音频」：把笔记的原始录音下载并落进 ACMS 附件目录（异步 + 进度轮询）。
   * 不传 `limit` = 处理全部待保存的；传了小数值可先试点。幂等，可反复调用。
   */
  @Post('refetch-audio')
  @HttpCode(200)
  refetchAudio(@Req() req: Request, @Body() body: { limit?: number }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.startRefetchAudio(user, { limit: Number(body?.limit) || 0 });
  }

  /** 查询「保存原始音频」进度。 */
  @Get('refetch-audio/status')
  refetchAudioStatus(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    return this.svc.refetchAudioStatus(user);
  }

  @Get('notes/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    return this.svc.detail(user, id);
  }

  /**
   * 归档 / 激活一条笔记（2026-09-21 峰哥要求）。
   *
   * 语义：**只改 ACMS 自己的状态表**，不动 Get笔记 里的笔记 —— 上游 note 对象没有可写的
   * 自定义字段，而且那是别人的数据（用户在手机 App 里看到的跟原来一样）。所以「归档」
   * 是「在本系统里把它收起来」，**不是删除**；真要删是 `DELETE /getnote/notes/:id`（进上游回收站）。
   * 历史笔记没有状态行 = 有效，所以「激活」只对归档过的笔记有意义（幂等，重复点不出错）。
   *
   * 权限：复用 `module:getnote:update`（矩阵里的「编辑」列）。
   * 为什么不为它单开权限点：动作目录是固定 9 个（enter/read/create/update/delete/import/
   * export/refresh/transition），新增 `transition` 要抬 `ROLE_PERMISSION_VERSION` 并迁移存量角色
   * （生产角色矩阵是持久化配置，不迁移的话**连系统管理员都不持有新点**，上线即「点了 403」）。
   * 归档在语义上就是「编辑这条笔记的状态」，归到「编辑」不牵强，且零迁移、零风险。
   *
   * ⚠️ 声明在 `@Put('notes/:id')` 之前：与既有子路由保持同一惯例（顺序本身不冲突，
   *    路径段数不同，但排前面将来加 `notes/:id/*` 时不会被 :id 吃掉）。
   */
  @Put('notes/:id/status')
  setStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { status?: string; title?: string },
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.setNoteStatus(user, id, String(body?.status ?? ''), body?.title);
  }

  @Put('notes/:id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.update(user, {
      note_id: id,
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
    });
  }

  /** 删除 = 移入回收站。前端必须先让用户二次确认笔记标题。 */
  @Delete('notes/:id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:delete');
    return this.svc.remove(user, id);
  }

  /** ⚠️ 必须声明在 @Post('notes/:id/tags') 之前 —— 否则 'link' 会被当成 :id */
  @Post('notes/link')
  createAndLink(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    const entityType = String(body?.entityType ?? '');
    const entityId = String(body?.entityId ?? '');
    if (!entityType || !entityId)
      throw new HttpException('BAD_REQUEST:entityType/entityId required', HttpStatus.BAD_REQUEST);
    return this.svc.createAndLink(user, {
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
      entityType,
      entityId,
      entityName: String(body?.entityName ?? ''),
    });
  }

  @Post('notes/:id/tags')
  addTags(@Req() req: Request, @Param('id') id: string, @Body() body: { tags?: string[] }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    const tags = Array.isArray(body?.tags) ? body.tags.filter((t) => String(t).trim()) : [];
    if (!tags.length) throw new HttpException('BAD_REQUEST:tags required', HttpStatus.BAD_REQUEST);
    return this.svc.addTags(user, id, tags);
  }

  /** ⚠️ 删的是 tag_id 不是标签名；system 类型标签删不掉。 */
  @Delete('notes/:id/tags/:tagId')
  removeTag(@Req() req: Request, @Param('id') id: string, @Param('tagId') tagId: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.removeTag(user, id, tagId);
  }

  // ── 笔记转换留痕 ──────────────────────────────────────────────────
  //
  // 留痕不落在 Get笔记 标签上（上游单篇笔记最多 5 个标签，位置根本不够），
  // 而是记在 ACMS 自己的「笔记转换记录」表，所以这里全是本地读写，不碰外部 API。

  /** 记一次转换：同一笔记 + 同一模块累加次数。返回 logId 供后续回填。 */
  @Post('convert-log')
  logConvert(
    @Req() req: Request,
    @Body() body: { noteId?: string; noteTitle?: string; moduleKey?: string; moduleLabel?: string },
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.logConvert(user, {
      noteId: String(body?.noteId ?? ''),
      noteTitle: body?.noteTitle,
      moduleKey: String(body?.moduleKey ?? ''),
      moduleLabel: String(body?.moduleLabel ?? ''),
    });
  }

  /**
   * 批量查留痕。?noteIds=a,b,c —— 列表页一次拿全，避免 N 次请求。
   * 留痕是全局的（谁都能看出这篇笔记转过几次），不做按人过滤。
   */
  @Get('convert-log')
  listConverts(@Req() req: Request, @Query('noteIds') noteIds?: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    const ids = String(noteIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    return this.svc.listConverts(user, ids);
  }

  /** 回填「转成了哪条业务记录」。目标页保存成功后调用，失败不影响已存的业务记录。 */
  @Put('convert-log/:id/target')
  linkConvert(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { targetRecordId?: string },
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:update');
    return this.svc.linkConvert(user, id, String(body?.targetRecordId ?? ''));
  }

  // ── 笔记 ↔ 知识库配置 归属 ────────────────────────────────────────
  //
  // Get笔记 的 note 对象里没有任何字段能标识它属于哪个配置（source 只是平台自己的
  // "app" 标识、note_type 是录音类型），所以归属记在 ACMS 的「笔记配置映射」表：
  // 自动同步时由 SourcesService.processNote 写入，历史笔记由回填脚本补。

  /**
   * 批量查笔记归属。?noteIds=a,b,c —— 列表页一次拿全，避免 N 次请求。
   * 归属是全局的（不随登录人变化），不做按人过滤。
   */
  @Get('config-map')
  listConfigMap(@Req() req: Request, @Query('noteIds') noteIds?: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'module:getnote:read');
    const ids = String(noteIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    return this.svc.listConfigMap(user, ids);
  }
}
