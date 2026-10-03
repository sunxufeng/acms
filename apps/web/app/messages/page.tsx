'use client';

import { useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 内部消息（教学管理 › 内部消息，2026-10-03）。
 *
 * 教务 / 教师 / 学务之间的轻量内部通知：教务通知 / 作业提醒 / 活动通知 / 温馨提示。
 * 与「通知任务 / 通知模板」（模板化群发）是两套独立能力。
 *
 * ⚠️ 后端表 `TABLES.message` 当前为占位 tableId，上线前须在飞书 Base 建表并回填真实 tableId，
 *   否则列表 / 新建会 500。
 */
export default function MessagesPage() {
  const messageTypeOptions = ['教务通知', '作业提醒', '活动通知', '温馨提示', '其他'];
  const scopeOptions = ['全员', '按班级', '按学生', '按教师'];
  const readStatusOptions = ['未读', '已读'];

  const COLUMNS: CrudColumn[] = [
    {
      key: '主题',
      label: '主题',
      width: '240px',
      form: true,
      type: 'text',
      required: true,
    },
    {
      key: '关联学生编号',
      label: '关联学生',
      width: '160px',
      form: true,
      type: 'text',
      hint: '学生档案 record id（留空表示不关联具体学生）',
    },
    {
      key: '关联收件人编号',
      label: '接收人',
      width: '160px',
      form: true,
      type: 'text',
      hint: '接收人 record id（全员 / 按班级时留空）',
    },
    {
      key: '消息类型',
      label: '消息类型',
      width: '130px',
      form: true,
      type: 'select',
      options: messageTypeOptions,
      required: true,
    },
    {
      key: '接收范围',
      label: '接收范围',
      width: '120px',
      form: true,
      type: 'select',
      options: scopeOptions,
      required: true,
    },
    {
      key: '正文',
      label: '正文',
      width: '320px',
      form: true,
      type: 'textarea',
    },
    {
      key: '发送时间',
      label: '发送时间',
      width: '150px',
      form: true,
      type: 'date',
      render: (v) => <span className="muted">{formatDateTime(v)}</span>,
    },
    {
      key: '发件人',
      label: '发件人',
      width: '120px',
      form: true,
      type: 'text',
    },
    {
      key: '已读状态',
      label: '已读状态',
      width: '110px',
      form: true,
      type: 'select',
      options: readStatusOptions,
    },
  ];

  return (
    <CrudPage
      title="内部消息"
      subtitle="教务 / 教师 / 学务之间的轻量内部通知（与群发通知任务相互独立）"
      columns={COLUMNS}
      statusField="已读状态"
      search={{ placeholder: '搜索主题 / 关联学生 / 发件人' }}
      api={{
        list: (p) => api.messages.list(p),
        create: (d) => api.messages.create(d),
        update: (id, d) => api.messages.update(id, d),
        archive: (id) => api.messages.archive(id),
      }}
    />
  );
}
