/** 通知闭环 DTO（M4，表：通知模板表 / 通知记录表） */

export interface CreateTemplateDto {
  模板名称?: string;
  渠道?: string;
  标题?: string;
  内容模板?: string;
  状态?: string;
  备注?: string;
}

export interface UpdateTemplateDto {
  模板名称?: string;
  渠道?: string;
  标题?: string;
  内容模板?: string;
  状态?: string;
  备注?: string;
}

export interface TemplateFilterDto {
  q?: string;
  渠道?: string;
  状态?: string;
  pageToken?: string;
}

export interface SendDto {
  templateId: string;
  接收人: string;
  渠道?: string;
  内容?: string;
  关联业务?: string;
}

export interface BatchSendDto {
  templateId: string;
  接收人列表: string[];
  渠道?: string;
  关联业务?: string;
}

export interface LogFilterDto {
  q?: string;
  渠道?: string;
  发送状态?: string;
  模板文本?: string;
  pageToken?: string;
}

export interface TransitionDto {
  to: string;
}

/** 回执状态机（fail-closed 渲染；待发送→已发送→已送达/失败→已读） */
export const NOTIFICATION_RECEIPT: Record<string, { to: string; perm: string }[]> = {
  待发送: [
    { to: '已发送', perm: 'notification:send' },
    { to: '失败', perm: 'notification:send' },
  ],
  已发送: [
    { to: '已送达', perm: 'notification:send' },
    { to: '失败', perm: 'notification:send' },
  ],
  已送达: [{ to: '已读', perm: 'notification:read' }],
  失败: [{ to: '待发送', perm: 'notification:send' }],
};
