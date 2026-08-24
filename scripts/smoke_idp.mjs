#!/usr/bin/env node
/**
 * IDP 数据层冒烟：直接对飞书 Base 的 IDP方案 / IDP沟通记录 两张表做
 * 建 → 读 → 建子表 → 读 → 删，校验字段名与 schema 与代码完全一致。
 * Usage: node scripts/smoke_idp.mjs
 */
import fs from 'node:fs';

function loadEnv(path) {
  if (!fs.existsSync(path)) return {};
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const ENV = loadEnv('.env');
const { BaseClient } = await import('/Users/sunxufeng/WorkBuddy/2026-08-16-08-53-48/acms/packages/base-adapter/dist/index.js');
const { TABLES } = await import('/Users/sunxufeng/WorkBuddy/2026-08-16-08-53-48/acms/packages/contracts/dist/index.js');

const base = new BaseClient(
  { appId: ENV.FEISHU_APP_ID, appSecret: ENV.FEISHU_APP_SECRET },
  ENV.FEISHU_BASE_TOKEN,
);

console.log('IDP_PLAN tableId =', TABLES.idpPlan.tableId);
console.log('IDP_COMM tableId =', TABLES.idpCommunication.tableId);

const now = Date.now();
const planFields = {
  关联学生: '冒烟测试学生',
  学期: '2026春',
  导师: '冒烟导师',
  状态: '草稿',
  人生平衡轮: JSON.stringify([{ 维度: '内驱力', 当前值: 3, 期望値: 5 }]),
  目标列表: JSON.stringify([{ 目标: '提升内驱力', 提升领域: ['内驱力'], 重要性: 5, 紧急程度: 4, 意义: '成长', 衡量方式: ['技能提升'], 其他说明: '' }]),
  阶段成果: JSON.stringify([{ 阶段: '期中', 成果: '完成项目', 完成时间: now }]),
  展示方式: 'PPT',
  展示内容: '内驱力提升路演',
  展示亮点: '自主完成',
  邀请人员: '家长',
  学生确认时间: now,
  导师确认时间: now,
  原始文档: JSON.stringify([]),
  制定日期: now,
};

const planId = await base.create(TABLES.idpPlan.tableId, planFields);
console.log('CREATED plan', planId);

const readPlan = await base.get(TABLES.idpPlan.tableId, planId);
console.log('READ plan 关联学生 =', readPlan.fields['关联学生'], '| 学期 =', readPlan.fields['学期'], '| 状态 =', readPlan.fields['状态']);
if (readPlan.fields['关联学生'] !== '冒烟测试学生') throw new Error('plan 字段回读不一致');

const commId = await base.create(TABLES.idpCommunication.tableId, {
  关联IDP方案: planId,
  沟通日期: now,
  沟通人: '冒烟导师',
  沟通内容: '第一次沟通',
  '需要的帮助/下一步计划': '继续推进',
  原始文档: JSON.stringify([]),
});
console.log('CREATED comm', commId);

const readComm = await base.get(TABLES.idpCommunication.tableId, commId);
console.log('READ comm 关联IDP方案 =', readComm.fields['关联IDP方案']);
if (readComm.fields['关联IDP方案'] !== planId) throw new Error('comm 关联字段回读不一致');

await base.delete(TABLES.idpPlan.tableId, planId);
await base.delete(TABLES.idpCommunication.tableId, commId);
console.log('DELETED both ok');
console.log('IDP SMOKE PASS');
