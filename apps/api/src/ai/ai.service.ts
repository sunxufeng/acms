// @ts-nocheck
import { Injectable, Logger, OnModuleInit, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { hasPermission } from '@acms/domain';

import {
  routeChat,
  testConnection,
} from './lib/gateway/router.js';
import {
  getConfig,
  setConfig,
  deleteConfig,
  getOrgDefault,
  setOrgDefault,
  listUsers,
} from './lib/config/userConfigStore.js';
import { PROVIDER_PRESETS } from './lib/providers/presets.js';
import { AgentRuntime } from './lib/agent/runtime.js';
import { webTools } from './lib/tools/web.js';
import {
  createSession,
  appendMessage,
  getHistory,
  listSessions,
} from './lib/config/conversationStore.js';
import {
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  getAutomation,
} from './lib/automation/store.js';
import {
  scheduleAll,
  scheduleOne,
  unscheduleOne,
  removePending,
  triggerNow,
  activeJobCount,
} from './lib/automation/scheduler.js';
import { initRunner } from './lib/automation/runner.js';
import { ensureLoaded, aggregateUsage } from './lib/admin/stats.js';
import { record, query as queryAudit } from './lib/audit/auditLog.js';
import { buildCron, describeCron } from './lib/automation/store.js';
import {
  listAgents as listAgentsStore,
  getAgentById,
  upsertAgent,
  removeAgent,
} from './lib/config/agentStore.js';
import {
  listSkills as listSkillsStore,
  getSkill as getSkillStore,
  saveSkill as saveSkillStore,
} from './lib/config/skillStore.js';

type Principal = { roles: readonly string[]; campuses: readonly string[]; maxDataLevel?: string };

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private runtime: AgentRuntime;

  constructor() {
    this.runtime = new AgentRuntime({ tools: webTools });
  }

  async onModuleInit() {
    // 把共享 AgentRuntime 注入给自动化执行器（供 cron 触发时复用工具）
    initRunner({
      agent: this.runtime,
      makeRuntime: () => new AgentRuntime({ tools: webTools }),
    });
    try {
      await ensureLoaded();
    } catch (e) {
      this.logger.warn('用量日志加载失败（可忽略）:', (e as Error).message);
    }
    try {
      const res = await scheduleAll();
      this.logger.log(`自动化调度已启动：${res.scheduled}/${res.total}`);
    } catch (e) {
      this.logger.error('自动化调度启动失败:', (e as Error).message);
    }
  }

  // ---------------- 权限 ----------------
  private assert(user: SessionUser, perm: string) {
    const principal: Principal = {
      roles: user.roles ?? [],
      campuses: user.campuses ?? [],
      maxDataLevel: user.maxDataLevel,
    };
    if (!hasPermission(principal, perm)) {
      throw new ForbiddenException(`缺少权限：${perm}`);
    }
  }

  // ---------------- 配置 / Provider ----------------
  getPresets() {
    return PROVIDER_PRESETS;
  }

  getMyConfig(user: SessionUser) {
    this.assert(user, 'ai:chat');
    const cfg = getConfig(user.openId);
    if (!cfg) return null;
    const { _apiKeyEnc, ...rest } = cfg as Record<string, unknown>;
    return { ...rest, hasApiKey: !!_apiKeyEnc };
  }

  saveMyConfig(user: SessionUser, body: Record<string, unknown>) {
    this.assert(user, 'ai:chat');
    const stored = setConfig(user.openId, body);
    const { _apiKeyEnc, ...rest } = stored as Record<string, unknown>;
    return { ...rest, hasApiKey: !!_apiKeyEnc };
  }

  deleteMyConfig(user: SessionUser) {
    this.assert(user, 'ai:chat');
    const ok = deleteConfig(user.openId);
    return { ok };
  }

  async testMyConnection(user: SessionUser, body: Record<string, unknown> = {}) {
    this.assert(user, 'ai:chat');
    return testConnection(user.openId, body);
  }

  // 组织默认配置（管理员下发模板，不含密钥）
  getOrgDefaultCfg(user: SessionUser) {
    this.assert(user, 'ai:chat');
    return getOrgDefault();
  }

  setOrgDefaultCfg(user: SessionUser, body: Record<string, unknown>) {
    this.assert(user, 'ai:config');
    const tpl = setOrgDefault(body);
    return tpl;
  }

  // ---------------- 智能体配置 ----------------
  listAgents(user: SessionUser) {
    this.assert(user, 'ai:config');
    return listAgentsStore();
  }

  getAgent(user: SessionUser, id: string) {
    this.assert(user, 'ai:config');
    return getAgentById(id);
  }

  saveAgent(user: SessionUser, body: Record<string, unknown>, id?: string) {
    this.assert(user, 'ai:config');
    const clean = { ...body };
    if (!id) clean.owner = user.openId;
    const saved = upsertAgent(clean, id);
    if (!saved) throw new BadRequestException('智能体不存在或更新失败');
    return saved;
  }

  deleteAgent(user: SessionUser, id: string) {
    this.assert(user, 'ai:config');
    return removeAgent(id);
  }

  // 可用工具清单（供智能体「工具开关」使用）
  listTools(_user: SessionUser) {
    return (webTools || []).map((t) => ({ name: t.name, description: t.description || '' }));
  }

  // ---------------- 技能（工具文档） ----------------
  listSkills(user: SessionUser) {
    this.assert(user, 'ai:admin');
    return listSkillsStore();
  }

  getSkill(user: SessionUser, name: string) {
    this.assert(user, 'ai:admin');
    return getSkillStore(name);
  }

  saveSkill(user: SessionUser, name: string, body: Record<string, unknown>) {
    this.assert(user, 'ai:admin');
    return saveSkillStore(name, body);
  }

  // ---------------- 对话 ----------------
  async chat(user: SessionUser, body: { message?: string; sessionId?: string; model?: string; history?: { role: string; content: string }[] }) {
    this.assert(user, 'ai:chat');
    const message = (body.message ?? '').toString();
    if (!message.trim()) throw new BadRequestException('message 不能为空');

    let sessionId = body.sessionId;
    if (!sessionId) sessionId = await createSession(user.openId, '新对话');

    // 历史（不含本轮），最多 20 轮
    const prior = body.history && body.history.length
      ? body.history
      : (await getHistory(user.openId, sessionId, 40)).map((m) => ({ role: m.role, content: m.content }));
    await appendMessage(sessionId, 'user', message);

    // 用户专属人设
    const cfg = getConfig(user.openId);
    const systemPrompt = cfg
      ? this.runtime.buildUserSystemPrompt({
          botName: (cfg as Record<string, string>).botName,
          systemPrompt: (cfg as Record<string, string>).systemPrompt,
        })
      : undefined;

    try {
      const result = await this.runtime.run(message, {
        chat: (messages) => routeChat(user.openId, messages, { model: body.model }),
        history: prior,
        systemPrompt,
        maxSteps: 6,
        context: { openId: user.openId },
      });
      const answer = result.answer || '';
      await appendMessage(sessionId, 'assistant', answer);
      return { content: answer, sessionId, steps: result.steps };
    } catch (e) {
      const err = e as { status?: number; message?: string };
      // 未配置模型（网关 404）时给出引导
      if (err.status === 404) {
        throw new BadRequestException(
          '你尚未配置模型（请在「AI 设置」页配置 Provider / API Key / Model），或等待管理员下发组织默认配置。'
        );
      }
      throw new BadRequestException(err.message || '模型调用失败');
    }
  }

  async listConversations(user: SessionUser) {
    this.assert(user, 'ai:chat');
    return listSessions(user.openId);
  }

  async getConversation(user: SessionUser, sessionId: string) {
    this.assert(user, 'ai:chat');
    return getHistory(user.openId, sessionId, 200);
  }

  async createConversation(user: SessionUser, body: { title?: string } = {}) {
    this.assert(user, 'ai:chat');
    const id = await createSession(user.openId, body.title || '新对话');
    return { id };
  }

  // ---------------- 自动化 ----------------
  async listAutomations(user: SessionUser) {
    this.assert(user, 'ai:automation');
    const autos = await listAutomations();
    return autos.map((a) => ({ ...a, cronText: describeCron(a.cron) }));
  }

  async getAutomationById(user: SessionUser, id: string) {
    this.assert(user, 'ai:automation');
    const auto = await getAutomation(id);
    if (!auto) throw new BadRequestException('自动化不存在');
    return { ...auto, cronText: describeCron(auto.cron) };
  }

  async createAutomation(user: SessionUser, body: Record<string, unknown>) {
    this.assert(user, 'ai:automation');
    const auto = await createAutomation({ ...body, owner: user.openId });
    scheduleOne(auto);
    return auto;
  }

  async updateAutomation(user: SessionUser, id: string, body: Record<string, unknown>) {
    this.assert(user, 'ai:automation');
    const updated = await updateAutomation(id, body);
    if (updated) scheduleOne(updated);
    return updated;
  }

  async deleteAutomation(user: SessionUser, id: string) {
    this.assert(user, 'ai:automation');
    const ok = await deleteAutomation(id);
    unscheduleOne(id);
    removePending(id);
    return { ok };
  }

  async triggerAutomation(user: SessionUser, id: string) {
    this.assert(user, 'ai:automation');
    const auto = await getAutomation(id);
    if (!auto) throw new BadRequestException('自动化不存在');
    // 异步触发，立即返回
    triggerNow(id).catch((e) => this.logger.error('手动触发失败:', e?.message));
    return { ok: true };
  }

  buildCronExpr(input: { freq: string; hour?: number; minute?: number; weeklyDay?: number; monthlyDay?: number }) {
    return buildCron(input);
  }

  // ---------------- 管理：用量 / 审计 ----------------
  async getUsage(user: SessionUser, rangeDays = 30) {
    this.assert(user, 'ai:admin');
    await ensureLoaded();
    const users = listUsers();
    const userMap: Record<string, string> = {};
    for (const u of users) userMap[u.openId] = u.displayName || u.openId;
    return aggregateUsage({ rangeDays, userMap });
  }

  async getAudit(user: SessionUser, limit = 200) {
    this.assert(user, 'ai:admin');
    return queryAudit({ admin: true, limit });
  }

  async recordAudit(actor: string, action: string, target: string, meta: Record<string, unknown> = {}) {
    try {
      await record({ actor, action, target, meta });
    } catch {
      /* 审计失败不影响主流程 */
    }
  }

  jobCount() {
    return activeJobCount();
  }
}
