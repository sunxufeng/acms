// @ts-nocheck
// 技能（Skill）存储 —— 轻量 JSON 文件存储。
//
// v1 简化模型：每个「内置工具/技能」对应一条可编辑的文档记录
//   { note, tags, description, markdown }
// skills: { [toolName]: { note, tags, description, markdown } }
// 相比 acaily 的目录式文件管理（assets/references/scripts 多文件上传），
// v1 只保留「可编辑的 SKILL.md 说明 + 元信息」，满足「为内置工具补充说明」的
// 核心诉求；文件上传类资源后续可再扩展。
import { createJsonStore } from './jsonStore.js';

const STORE_PATH = process.env.ACAILY_SKILL_STORE || '/opt/acms/data/ai/skills.json';
const store = createJsonStore(STORE_PATH, {});

export function listSkills() {
  const d = store.load();
  return Object.keys(d).map((name) => ({
    name,
    note: d[name].note || '',
    tags: d[name].tags || [],
    description: d[name].description || '',
    hasMarkdown: !!d[name].markdown,
  }));
}

export function getSkill(name) {
  const d = store.load();
  if (!d[name]) return null;
  return { name, note: d[name].note || '', tags: d[name].tags || [], description: d[name].description || '', markdown: d[name].markdown || '' };
}

export function saveSkill(name, meta) {
  const d = store.load();
  d[name] = {
    note: meta.note || '',
    tags: meta.tags || [],
    description: meta.description || '',
    markdown: meta.markdown || '',
  };
  store.persist();
  return getSkill(name);
}
