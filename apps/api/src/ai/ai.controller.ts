import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { AiService } from './ai.service.js';

type ReqWithUser = Request & { user: SessionUser };

@Controller('ai')
@UseGuards(SessionGuard)
export class AiController {
  constructor(private readonly svc: AiService) {}

  // ---------------- 配置 / Provider ----------------
  @Get('presets')
  presets() {
    return this.svc.getPresets();
  }

  @Get('config/me')
  configMe(@Req() req: ReqWithUser) {
    return this.svc.getMyConfig(req.user);
  }

  @Post('config/me')
  saveConfigMe(@Req() req: ReqWithUser, @Body() body: Record<string, unknown>) {
    return this.svc.saveMyConfig(req.user, body);
  }

  @Delete('config/me')
  deleteConfigMe(@Req() req: ReqWithUser) {
    return this.svc.deleteMyConfig(req.user);
  }

  @Post('config/test')
  testConnection(@Req() req: ReqWithUser, @Body() body: Record<string, unknown>) {
    return this.svc.testMyConnection(req.user, body);
  }

  @Get('org-default')
  orgDefault(@Req() req: ReqWithUser) {
    return this.svc.getOrgDefaultCfg(req.user);
  }

  @Post('org-default')
  saveOrgDefault(@Req() req: ReqWithUser, @Body() body: Record<string, unknown>) {
    return this.svc.setOrgDefaultCfg(req.user, body);
  }

  // ---------------- 智能体配置 ----------------
  @Get('agents')
  agents(@Req() req: ReqWithUser) {
    return this.svc.listAgents(req.user);
  }

  @Get('tools')
  tools(@Req() req: ReqWithUser) {
    return this.svc.listTools(req.user);
  }

  @Post('agents')
  createAgent(@Req() req: ReqWithUser, @Body() body: Record<string, unknown>) {
    return this.svc.saveAgent(req.user, body);
  }

  @Get('agents/:id')
  agent(@Req() req: ReqWithUser, @Param('id') id: string) {
    return this.svc.getAgent(req.user, id);
  }

  @Put('agents/:id')
  updateAgent(@Req() req: ReqWithUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.saveAgent(req.user, body, id);
  }

  @Delete('agents/:id')
  deleteAgent(@Req() req: ReqWithUser, @Param('id') id: string) {
    return this.svc.deleteAgent(req.user, id);
  }

  // ---------------- 技能（工具文档） ----------------
  @Get('skills')
  skills(@Req() req: ReqWithUser) {
    return this.svc.listSkills(req.user);
  }

  @Get('skills/:name')
  skill(@Req() req: ReqWithUser, @Param('name') name: string) {
    return this.svc.getSkill(req.user, name);
  }

  @Put('skills/:name')
  saveSkill(@Req() req: ReqWithUser, @Param('name') name: string, @Body() body: Record<string, unknown>) {
    return this.svc.saveSkill(req.user, name, body);
  }

  // ---------------- 对话 ----------------
  @Post('chat')
  chat(@Req() req: ReqWithUser, @Body() body: { message?: string; sessionId?: string; model?: string; history?: { role: string; content: string }[] }) {
    return this.svc.chat(req.user, body);
  }

  @Get('conversations')
  conversations(@Req() req: ReqWithUser) {
    return this.svc.listConversations(req.user);
  }

  @Post('conversations')
  createConversation(@Req() req: ReqWithUser, @Body() body: { title?: string }) {
    return this.svc.createConversation(req.user, body);
  }

  @Get('conversations/:id')
  conversation(@Req() req: ReqWithUser, @Param('id') id: string) {
    return this.svc.getConversation(req.user, id);
  }

  // ---------------- 自动化 ----------------
  @Get('automations')
  automations(@Req() req: ReqWithUser) {
    return this.svc.listAutomations(req.user);
  }

  @Post('automations')
  createAutomation(@Req() req: ReqWithUser, @Body() body: Record<string, unknown>) {
    return this.svc.createAutomation(req.user, body);
  }

  @Get('automations/:id')
  getAutomation(@Req() req: ReqWithUser, @Param('id') id: string) {
    return this.svc.getAutomationById(req.user, id);
  }

  @Put('automations/:id')
  updateAutomation(@Req() req: ReqWithUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.updateAutomation(req.user, id, body);
  }

  @Delete('automations/:id')
  deleteAutomation(@Req() req: ReqWithUser, @Param('id') id: string) {
    return this.svc.deleteAutomation(req.user, id);
  }

  @Post('automations/:id/run')
  runAutomation(@Req() req: ReqWithUser, @Param('id') id: string) {
    return this.svc.triggerAutomation(req.user, id);
  }

  @Post('cron/build')
  buildCron(@Body() body: { freq: string; hour?: number; minute?: number; weeklyDay?: number; monthlyDay?: number }) {
    return { cron: this.svc.buildCronExpr(body) };
  }

  // ---------------- 管理：用量 / 审计 ----------------
  @Get('admin/usage')
  usage(@Req() req: ReqWithUser, @Query('rangeDays') rangeDays?: string) {
    return this.svc.getUsage(req.user, Number(rangeDays) || 30);
  }

  @Get('admin/audit')
  audit(@Req() req: ReqWithUser, @Query('limit') limit?: string) {
    return this.svc.getAudit(req.user, Number(limit) || 200);
  }
}
