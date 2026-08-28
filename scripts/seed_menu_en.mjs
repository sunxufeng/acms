// 一次性脚本：把菜单/分组的英文名称(enLabel)写入生产「系统配置表」的两条记录。
// 运行于 114 服务器（已部署 base-adapter dist + /opt/acms/.env）。
// 用法：node /tmp/seed_menu_en.mjs
import { readFileSync } from 'node:fs';
import { BaseClient } from '/opt/acms/repo/packages/base-adapter/dist/index.js';

// ---- 读取 /opt/acms/.env ----
const envRaw = readFileSync('/opt/acms/.env', 'utf8');
const env = {};
for (const line of envRaw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const CODE_TABLE_ID = 'tblvBrRCWO65L6Yg'; // 系统配置表（代码内 id）
// TABLE_ID_MAP：代码表 id -> 实际表 id
const tableMap = env.TABLE_ID_MAP ? JSON.parse(env.TABLE_ID_MAP) : {};
const TABLE_ID = tableMap[CODE_TABLE_ID] || CODE_TABLE_ID;

const client = new BaseClient(
  { appId: env.FEISHU_APP_ID || '', appSecret: env.FEISHU_APP_SECRET || '' },
  env.FEISHU_BASE_TOKEN || '',
);

// 默认英文映射
const ITEM_EN = {
  dashboard: 'Overview', students: 'Students', courses: 'Courses', teaching: 'Teaching Classes',
  schedule: 'Schedules', portal: 'Student Portal', student360: 'Student 360',
  sourceFollowups: 'Admissions Follow-ups', studentAttendances: 'Attendance', grades: 'Grades',
  practiceActivities: 'Activities', homeSchoolComms: 'Home-School Comms', dailyFollowups: 'Daily Follow-ups',
  idpPlans: 'IDP Plans', stageEvaluations: 'Stage Evaluations', alumniFollowups: 'Alumni Follow-ups',
  mailAccounts: 'Mail Accounts', mailArchive: 'Mail Archive', teachers: 'Teachers',
  attendance: 'Faculty Attendance', billing: 'Billing', settlements: 'Monthly Settlements',
  adjustments: 'Adjustments', partnerships: 'Partnerships', aiChat: 'AI Chat', aiConfig: 'AI Settings',
  aiAgents: 'Bots', aiSkills: 'Skills', aiAutomations: 'Scheduled Tasks', aiAdmin: 'AI Usage',
  dictionary: 'Dictionaries', export: 'Export', 'audit-logs': 'Audit Logs', users: 'Users',
  permissions: 'Permissions', 'role-management': 'Role Management', notifications: 'Notifications',
  'notification-templates': 'Notification Templates', settings: 'Settings', 'attendance-zones': 'Attendance Zones',
  'wechat-bindings': 'WeChat Users', 'homepage-management': 'Dashboard Theme', 'homepage-settings': 'Login Page Config',
  'menu-settings': 'Menu Management', 'menu-groups-settings': 'Menu Groups', 'student-users': 'Student Accounts',
};
const SECTION_EN = {
  工作台: 'Workspace', 业务管理: 'Operations', 学生闭环: 'Student Lifecycle', 教师管理: 'Faculty',
  智能助手: 'AI Assistant', 后台管理: 'Administration', 邮件归档: 'Mail Archive',
};

function fieldText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v[0]?.text != null) return v[0].text;
  if (v && v.text != null) return v.text;
  return '';
}

async function findRecord(configKey) {
  const res = await client.search(TABLE_ID, { pageSize: 100 });
  return res.items.find((r) => fieldText(r.fields['配置键']) === configKey) || null;
}

function getText(fields) {
  return fieldText(fields['配置值']);
}

let changed = 0;

// 1) 导航菜单项
{
  const rec = await findRecord('nav_menu_config');
  if (!rec) { console.log('nav_menu_config 记录不存在，跳过'); }
  else {
    const parsed = JSON.parse(getText(rec.fields) || '{"items":[]}');
    let touched = 0;
    for (const it of parsed.items) {
      const en = ITEM_EN[it.key];
      if (en && !it.enLabel) { it.enLabel = en; touched++; }
    }
    if (touched > 0) {
      await client.update(TABLE_ID, rec.recordId, { '配置值': JSON.stringify(parsed) });
      changed += touched;
      console.log(`nav_menu_config: 更新 ${touched} 个菜单项的 enLabel`);
    } else {
      console.log('nav_menu_config: 无需更新（enLabel 均已存在）');
    }
  }
}

// 2) 菜单分组
{
  const rec = await findRecord('nav_menu_groups');
  if (!rec) { console.log('nav_menu_groups 记录不存在，跳过'); }
  else {
    const parsed = JSON.parse(getText(rec.fields) || '{"items":[]}');
    let touched = 0;
    for (const g of parsed.items) {
      const en = SECTION_EN[g.key] || SECTION_EN[g.label];
      if (en && !g.enLabel) { g.enLabel = en; touched++; }
    }
    if (touched > 0) {
      await client.update(TABLE_ID, rec.recordId, { '配置值': JSON.stringify(parsed) });
      changed += touched;
      console.log(`nav_menu_groups: 更新 ${touched} 个分组的 enLabel`);
    } else {
      console.log('nav_menu_groups: 无需更新（enLabel 均已存在）');
    }
  }
}

console.log(`DONE, 共写入 ${changed} 处 enLabel`);
