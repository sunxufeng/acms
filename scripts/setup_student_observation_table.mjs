#!/usr/bin/env node
/**
 * 建表：学生观察表（student_observation）
 *
 * Usage (on server):
 *   node scripts/setup_student_observation_table.mjs [/path/to/.env]
 *
 * Idempotent：名为「学生观察表」的表已存在时，只打印 table_id 并退出 0，不会重复建。
 *
 * 为什么新建一张表而不是复用「日常跟进表」：
 *   学生观察是独立业务（新生观察 / 日常观察 / 招生观察），与家校沟通、日常跟进的数据
 *   需要分开统计与授权。字段结构照搬日常跟进表（保证字典同步同源），
 *   只新增「观察类型」单选字段。
 *
 * 字段清单（type 见飞书 Bitable：1=文本 2=数字 3=单选 5=日期）：
 *   沟通编号 1 / 关联学生 1 / 沟通人 1 / 沟通方式 3 / 沟通人备注 1 /
 *   沟通时间 5(yyyy/MM/dd HH:mm) / 沟通明细 1 / 沟通总结 1 / 沟通附件清单 1 /
 *   待办事项 1 / 责任人 1 / 跟进截止日期 5 / 闭环状态 3 / 闭环日期 5 /
 *   信息敏感级别 3 / 待办负责人 1 / 沟通主题 1 / 沟通时长(分钟) 2 /
 *   观察类型 3(新生观察 / 日常观察 / 招生观察)
 *
 * ⚠️ 界面上统一把「沟通X」显示为「观察X」，但飞书字段名保持「沟通X」不变，
 *    这样可以继续复用 dict.service 的字典同步逻辑（ensureCommCommonFields 等）。
 */
import fs from 'node:fs';

function loadEnv(path) {
  if (!path || !fs.existsSync(path)) return;
  const txt = fs.readFileSync(path, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const envPath = process.argv[2] || '/opt/acms/.env';
loadEnv(envPath);

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

const TABLE_NAME = '学生观察表';

// 与 dict.data.ts 保持一致
const DICT = {
  沟通方式: ['电话', '微信', '腾讯会议', '面谈', '家长会', '邮件', '其他'],
  闭环状态: ['无需跟进', '待跟进', '跟进中', '已闭环'], // 字典 key 是「家校闭环状态」
  信息敏感级别: ['内部', '敏感', '高度敏感'],
  观察类型: ['新生观察', '日常观察', '招生观察'],
};
const opts = (arr) => arr.map((name) => ({ name }));

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    console.error('tenant_access_token failed:', JSON.stringify(data));
    process.exit(1);
  }
  return data.tenant_access_token;
}

async function findExisting(token) {
  let pageToken;
  for (let i = 0; i < 20; i++) {
    const url =
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables?page_size=100` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) {
      console.error('listTables failed:', JSON.stringify(data));
      process.exit(1);
    }
    const hit = (data.data?.items ?? []).find((t) => t.name === TABLE_NAME);
    if (hit) return hit.table_id;
    if (!data.data?.has_more) return null;
    pageToken = data.data.page_token;
  }
  return null;
}

const FIELDS = [
  { field_name: '沟通编号', type: 1 },
  { field_name: '关联学生', type: 1 },
  { field_name: '沟通人', type: 1 },
  { field_name: '沟通方式', type: 3, property: { options: opts(DICT.沟通方式) } },
  { field_name: '沟通人备注', type: 1 },
  { field_name: '沟通时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false } },
  { field_name: '沟通明细', type: 1 },
  { field_name: '沟通总结', type: 1 },
  { field_name: '沟通附件清单', type: 1 },
  { field_name: '待办事项', type: 1 },
  { field_name: '责任人', type: 1 },
  { field_name: '跟进截止日期', type: 5, property: { date_formatter: 'yyyy/MM/dd', auto_fill: false } },
  { field_name: '闭环状态', type: 3, property: { options: opts(DICT.闭环状态) } },
  { field_name: '闭环日期', type: 5, property: { date_formatter: 'yyyy/MM/dd', auto_fill: false } },
  { field_name: '信息敏感级别', type: 3, property: { options: opts(DICT.信息敏感级别) } },
  { field_name: '待办负责人', type: 1 },
  { field_name: '沟通主题', type: 1 },
  { field_name: '沟通时长(分钟)', type: 2, property: { formatter: '0.0' } },
  { field_name: '观察类型', type: 3, property: { options: opts(DICT.观察类型) } },
];

async function main() {
  const token = await getToken();

  const existing = await findExisting(token);
  if (existing) {
    console.log(`STUDENT_OBSERVATION_TABLE_ID=${existing}`);
    console.log(`Table "${TABLE_NAME}" already exists (${existing}), skipping creation.`);
    console.log('Register it in packages/contracts/src/tables.ts as:');
    console.log(`  studentObservation: { tableId: '${existing}', name: '学生观察表' },`);
    return;
  }

  const res = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ table: { name: TABLE_NAME, fields: FIELDS } }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    console.error('createTable failed:', JSON.stringify(data));
    process.exit(1);
  }
  const tableId = data.data.table_id;
  console.log(`STUDENT_OBSERVATION_TABLE_ID=${tableId}`);
  console.log(`Created table "${TABLE_NAME}" (${tableId}) with ${FIELDS.length} fields.`);
  console.log('Register it in packages/contracts/src/tables.ts as:');
  console.log(`  studentObservation: { tableId: '${tableId}', name: '学生观察表' },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
