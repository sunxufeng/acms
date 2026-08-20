// @ts-nocheck
// 智能体（Agent）存储 —— 轻量 JSON 文件存储（复用 jsonStore 的 mtime/size 自动失效）。
//
// v1 数据模型（相比 acaily 的 8 段人设 + 飞书绑定 + 心跳，做了简化）：
//   id, name, emoji, description, systemPrompt(单段人设 markdown),
//   toolList(允许使用的工具子集，空=全部), model, provider, baseUrl,
//   owner, createdAt, updatedAt
// 飞书应用绑定 / Provider 池 / 心跳自动化等 acaily 企业版能力本期不做。
//
// 同时保留 automation/runner 的 import 契约（getAgent/getAgentApiKey/
// getAgentFeishuSecret/saveAgent(patch,id)/appendMemory），核心范围不绑定
// 独立飞书智能体，这些返回 null / 透传语义，保证 runner 行为不变。
import { createJsonStore } from './jsonStore.js';
import { randomUUID } from 'node:crypto';

const STORE_PATH = process.env.ACAILY_AGENT_STORE || '/opt/acms/data/ai/agents.json';
const store = createJsonStore(STORE_PATH, { agents: [] });

function all() {
  const d = store.load();
  if (!d.agents) d.agents = [];
  return d.agents;
}

// ---------------- 新 CRUD（供 AiService / 前端使用） ----------------
export function listAgents() {
  return all().slice();
}

export function getAgentById(id) {
  return all().find((a) => a.id === id) || null;
}

export function upsertAgent(input, id) {
  const agents = all();
  const now = new Date().toISOString();
  if (id) {
    const i = agents.findIndex((a) => a.id === id);
    if (i < 0) return null;
    agents[i] = { ...agents[i], ...input, id, updatedAt: now };
    store.persist();
    return agents[i];
  }
  const agent = { id: randomUUID(), createdAt: now, updatedAt: now, ...input };
  agents.push(agent);
  store.persist();
  return agent;
}

export function removeAgent(id) {
  const agents = all();
  const before = agents.length;
  const next = agents.filter((a) => a.id !== id);
  if (next.length === before) return { ok: false };
  store.load().agents = next;
  store.persist();
  return { ok: true };
}

// ---------------- runner 契约（核心范围保持桩语义） ----------------
export function getAgent(_id) {
  return null;
}

export function getAgentApiKey(_id) {
  return null;
}

export function getAgentFeishuSecret(_id) {
  return null;
}

// 记忆型自动化（actionType='memory'）在核心范围不会触发，保留兼容签名。
export function saveAgent(patch, _id) {
  return { ...(patch || {}) };
}

// 把新记忆追加到既有记忆文本之后（多行拼接）。
export function appendMemory(prev, add) {
  const p = (prev || '').trim();
  const a = (add || '').trim();
  if (!p) return a;
  if (!a) return p;
  return `${p}\n${a}`;
}
