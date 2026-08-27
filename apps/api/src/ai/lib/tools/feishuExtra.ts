// @ts-nocheck
import { getUserAccessToken } from '../config/userConfigStore.js';
import { sendText, sendMarkdown } from '../feishu/client.js';
import type { BaseClient } from '@acms/base-adapter';

const FEISHU_HOST = 'https://open.feishu.cn';

// 1) 发送飞书消息（机器人身份，tenant token；需开放平台开启 im:message / im:message:send_as_bot）
export function createSendFeishuMessageTool() {
  return {
    name: 'send_feishu_message',
    description:
      '以 ACMS 机器人身份给用户或群发送飞书消息（文本或 Markdown 卡片）。参数：{"receive_id":"接收方 open_id 或 chat_id","receive_id_type":"open_id(默认)|chat_id|union_id","content":"消息内容","msg_type":"text(默认)|markdown"}。需要飞书应用已开通 im:message 权限。',
    async run(args: any) {
      const receiveId = args && args.receive_id;
      const content = (args && args.content) || '';
      const type = (args && args.msg_type) === 'markdown' ? 'markdown' : 'text';
      const ridType = (args && args.receive_id_type) || 'open_id';
      if (!receiveId) return '错误：缺少 receive_id';
      try {
        const r =
          type === 'markdown'
            ? await sendMarkdown(receiveId, content, undefined, { receiveIdType: ridType })
            : await sendText(receiveId, content, undefined, { receiveIdType: ridType });
        if (r && r.skipped) return `发送跳过：${r.reason}`;
        if (r && r.error) return `发送失败：${r.error}`;
        return `已发送消息给 ${receiveId}（${type}）。`;
      } catch (e) {
        return `发送失败：${(e as Error).message}`;
      }
    },
  };
}

// 2) 通讯录搜索（tenant token；需 contact:user.base:readonly）
export function createSearchContactsTool() {
  return {
    name: 'search_contacts',
    description:
      '在飞书通讯录按姓名/手机号/邮箱搜索员工，返回 open_id、姓名、部门、手机号、邮箱。参数：{"keyword":"搜索词","page_size":默认20}。需要飞书应用已开通 contact:user.base:readonly 权限。',
    async run(args: any) {
      const keyword = (args && args.keyword) || '';
      const pageSize = Number((args && args.page_size) || 20);
      const token = await getTenantToken();
      if (!token) return '错误：服务端未配置飞书凭据';
      try {
        const res = await fetch(`${FEISHU_HOST}/open-apis/contact/v3/users/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ query: keyword, page_size: Math.min(100, pageSize) }),
        });
        const data = await res.json();
        if (data.code !== 0) return `通讯录搜索失败：${data.msg}`;
        const users = (data.data && data.data.items) || [];
        if (!users.length) return `未找到匹配「${keyword}」的联系人。`;
        return JSON.stringify(
          {
            count: users.length,
            users: users.map((u: any) => ({
              open_id: u.open_id,
              姓名: u.name,
              部门: (u.departments || []).map((d: any) => d.name).join('/'),
              手机号: u.mobile,
              邮箱: u.email,
            })),
          },
          null,
          2,
        );
      } catch (e) {
        return `通讯录搜索失败：${(e as Error).message}`;
      }
    },
  };
}

// 3) 日历：列出事件（user_access_token；需 calendar:calendar）
export function createListCalendarEventsTool() {
  return {
    name: 'list_calendar_events',
    description:
      '读取当前用户飞书日历事件（默认主日历 cal_1）。参数：{"calendar_id":"可选，默认 cal_1","page_size":默认20}。需要用户在授权页同意日历权限。',
    async run(args: any, context: any) {
      const userToken = await getUserAccessToken(context && context.openId);
      if (!userToken) return '错误：你尚未授权飞书日历，请退出登录重新登录并在授权页同意「日历」权限。';
      const calendarId = (args && args.calendar_id) || 'cal_1';
      const pageSize = Number((args && args.page_size) || 20);
      try {
        const res = await fetch(
          `${FEISHU_HOST}/open-apis/calendar/v4/calendars/${calendarId}/events?page_size=${Math.min(50, pageSize)}`,
          { headers: { authorization: `Bearer ${userToken}` } },
        );
        const data = await res.json();
        if (data.code !== 0) return `读取日历失败：${data.msg}`;
        const events = (data.data && data.data.items) || [];
        if (!events.length) return `日历 ${calendarId} 暂无事件。`;
        return JSON.stringify(
          {
            count: events.length,
            events: events.map((e: any) => ({
              标题: e.summary,
              开始: e.start_time,
              结束: e.end_time,
              event_id: e.event_id,
            })),
          },
          null,
          2,
        );
      } catch (e) {
        return `读取日历失败：${(e as Error).message}`;
      }
    },
  };
}

// 3b) 日历：创建事件（user_access_token；需 calendar:calendar）
export function createCreateCalendarEventTool() {
  return {
    name: 'create_calendar_event',
    description:
      '在用户飞书日历创建日程。参数：{"calendar_id":"可选，默认 cal_1","summary":"标题","start_time":"ISO 时间或时间戳(ms)","end_time":"ISO 时间或时间戳(ms)","description":"可选描述"}。需要用户同意日历权限。',
    async run(args: any, context: any) {
      const userToken = await getUserAccessToken(context && context.openId);
      if (!userToken) return '错误：你尚未授权飞书日历，请退出登录重新登录并在授权页同意「日历」权限。';
      const calendarId = (args && args.calendar_id) || 'cal_1';
      const summary = (args && args.summary) || '';
      const start = (args && args.start_time) || '';
      const end = (args && args.end_time) || '';
      const description = (args && args.description) || '';
      if (!summary || !start || !end) return '错误：缺少 summary / start_time / end_time';
      const ts = (v: string) => {
        const n = Number(v);
        return String(Number.isNaN(n) ? Date.parse(v) : n);
      };
      try {
        const res = await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars/${calendarId}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
          body: JSON.stringify({
            summary,
            description,
            start_time: { timestamp: ts(start), timezone: 'Asia/Shanghai' },
            end_time: { timestamp: ts(end), timezone: 'Asia/Shanghai' },
          }),
        });
        const data = await res.json();
        if (data.code !== 0) return `创建日历事件失败：${data.msg}`;
        return `已创建日历事件「${summary}」（event_id: ${(data.data && data.data.event_id) || ''}）。`;
      } catch (e) {
        return `创建日历事件失败：${(e as Error).message}`;
      }
    },
  };
}

// 4) 多维表格查询（ACMS 自身的飞书 Base，tenant token）
export function createQueryBitableTool(base: BaseClient) {
  return {
    name: 'query_bitable',
    description:
      '查询 ACMS 飞书多维表格记录。参数：{"table_id":"表 ID（如 tbl...；先用 list_bitable_tables 获取）","keyword":"可选，对记录字段做模糊过滤","page_size":默认50}。返回该表记录（record_id + 字段）。',
    async run(args: any) {
      const tableId = args && args.table_id;
      if (!tableId) return '错误：缺少 table_id';
      const pageSize = Number((args && args.page_size) || 50);
      const keyword = (args && args.keyword) || '';
      try {
        const res = await base.search(tableId, { pageSize });
        let items: any[] = res.items || [];
        if (keyword) {
          const kw = keyword.toLowerCase();
          items = items.filter((r) => JSON.stringify(r.fields || {}).toLowerCase().includes(kw));
        }
        return JSON.stringify(
          {
            count: items.length,
            records: items.slice(0, pageSize).map((r) => ({ record_id: r.recordId, fields: r.fields })),
          },
          null,
          2,
        );
      } catch (e) {
        return `查询多维表格失败：${(e as Error).message}`;
      }
    },
  };
}

export function createListBitableTablesTool(base: BaseClient) {
  return {
    name: 'list_bitable_tables',
    description: '列出 ACMS 飞书多维表格（Base）中的所有数据表，返回 table_id 与名称；先调用它获取 table_id 再传给 query_bitable。',
    async run() {
      try {
        const tables = await base.listTables();
        if (!tables.length) return '暂无数据表。';
        return JSON.stringify({ count: tables.length, tables }, null, 2);
      } catch (e) {
        return `列出数据表失败：${(e as Error).message}`;
      }
    },
  };
}

// 5) 飞书任务（user_access_token；需 task:task）
export function createCreateTaskTool() {
  return {
    name: 'create_task',
    description:
      '在用户飞书「任务」中创建待办。参数：{"summary":"标题","due":"可选，截止时间 ISO 或时间戳(ms)","description":"可选描述"}。需要用户同意任务权限。',
    async run(args: any, context: any) {
      const userToken = await getUserAccessToken(context && context.openId);
      if (!userToken) return '错误：你尚未授权飞书任务，请退出登录重新登录并在授权页同意「任务」权限。';
      const summary = (args && args.summary) || '';
      const due = (args && args.due) || '';
      const description = (args && args.description) || '';
      if (!summary) return '错误：缺少 summary';
      try {
        const body: any = { summary: { title: summary } };
        if (description) body.description = description;
        if (due) {
          const n = Number(due);
          const ms = Number.isNaN(n) ? Date.parse(due) : n;
          if (!Number.isNaN(ms)) body.due = { timestamp: String(ms), is_all_day: false };
        }
        const res = await fetch(`${FEISHU_HOST}/open-apis/task/v2/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.code !== 0) return `创建任务失败：${data.msg}`;
        return `已创建飞书任务「${summary}」（guid: ${(data.data && data.data && data.data.task && data.data.task.guid) || ''}）。`;
      } catch (e) {
        return `创建任务失败：${(e as Error).message}`;
      }
    },
  };
}

export function createFeishuExtraTools(base: BaseClient) {
  return [
    createSendFeishuMessageTool(),
    createSearchContactsTool(),
    createListCalendarEventsTool(),
    createCreateCalendarEventTool(),
    createQueryBitableTool(base),
    createListBitableTablesTool(base),
    createCreateTaskTool(),
  ];
}
