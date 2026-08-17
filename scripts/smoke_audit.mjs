#!/usr/bin/env node
/** Smoke-test the 审计日志 Feishu table: create → read → delete a record. */
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

const ENV = loadEnv('/opt/acms/.env');
const { BaseClient } = await import('/opt/acms/repo/packages/base-adapter/dist/index.js');
const { TABLES } = await import('/opt/acms/repo/packages/contracts/dist/index.js');

const base = new BaseClient(
  { appId: ENV.FEISHU_APP_ID, appSecret: ENV.FEISHU_APP_SECRET },
  ENV.FEISHU_BASE_TOKEN,
);

const id = await base.create(TABLES.auditLog.tableId, {
  操作时间: Date.now(),
  操作人: 'smoke-test',
  操作类型: '创建',
  业务模块: 'smoke',
  记录标识: 'test-1',
  摘要: 'smoke 验证',
  详情: '操作类型,业务模块',
});
console.log('CREATED', id);
const rec = await base.get(TABLES.auditLog.tableId, id);
console.log('READ', JSON.stringify(rec));
await base.delete(TABLES.auditLog.tableId, id);
console.log('DELETED ok');
