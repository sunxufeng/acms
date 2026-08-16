'use client';

import { useState, useEffect } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const CHANNEL_OPTS = ['飞书', '短信', '邮件'];
const TPL_STATUS_OPTS = ['启用', '停用'];
const RECEIPT_OPTS = ['待发送', '已发送', '已送达', '失败', '已读'];
const RECEIPT_TX: Record<string, string[]> = {
  待发送: ['已发送', '失败'],
  已发送: ['已送达', '失败'],
  已送达: ['已读'],
  失败: ['待发送'],
};

const TPL_COLUMNS: CrudColumn[] = [
  { key: '模板名称', label: '模板名称', width: '150px', filter: true, form: true, required: true, type: 'text' },
  { key: '渠道', label: '渠道', width: '90px', filter: true, filterOptions: CHANNEL_OPTS, form: true, type: 'select', options: CHANNEL_OPTS },
  { key: '标题', label: '标题', width: '160px', form: true, type: 'text' },
  { key: '内容模板', label: '内容模板', form: true, type: 'textarea' },
  { key: '状态', label: '状态', width: '90px', filter: true, filterOptions: TPL_STATUS_OPTS, form: true, type: 'select', options: TPL_STATUS_OPTS },
  { key: '备注', label: '备注', form: true, type: 'text' },
];

const LOG_COLUMNS: CrudColumn[] = [
  { key: '模板文本', label: '模板', width: '140px', filter: true, form: true, type: 'text' },
  { key: '接收人', label: '接收人', width: '140px', filter: true, form: true, type: 'text' },
  { key: '渠道', label: '渠道', width: '80px', filter: true, filterOptions: CHANNEL_OPTS, form: true, type: 'select', options: CHANNEL_OPTS },
  { key: '发送状态', label: '回执', width: '100px', filter: true, filterOptions: RECEIPT_OPTS, form: true, type: 'select', options: RECEIPT_OPTS },
  { key: '内容', label: '内容', form: true, type: 'textarea' },
  { key: '关联业务', label: '关联业务', width: '130px', form: true, type: 'text' },
  { key: '回执时间', label: '回执时间', width: '130px', render: (v) => <span className="muted">{String(v ?? '').slice(0, 16)}</span> },
];

function SendPanel() {
  const [templates, setTemplates] = useState<{ id: string; label: string }[]>([]);
  const [tpl, setTpl] = useState('');
  const [receivers, setReceivers] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listTemplates({}).then((r) => setTemplates(r.items.map((i) => ({ id: String(i.id), label: String(i['模板名称'] ?? i.id) })))).catch(() => setTemplates([]));
  }, []);

  async function doSend(batch: boolean) {
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (!tpl) throw new Error('请选择模板');
      if (batch) {
        const list = receivers.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        const r = await api.batchNotification({ templateId: tpl, 接收人列表: list });
        setMsg(`已提交 ${r.count} 条`);
      } else {
        const one = receivers.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)[0];
        if (!one) throw new Error('请填写至少一个接收人');
        await api.sendNotification({ templateId: tpl, 接收人: one });
        setMsg('已发送 1 条');
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '发送失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-fieldset" style={{ marginBottom: 'var(--space-lg)' }}>
      <legend className="form-legend">发送工作台</legend>
      <div className="form-grid">
        <div className="form-label">
          <span className="form-label-text">通知模板</span>
          <select className="form-input" value={tpl} onChange={(e) => setTpl(e.target.value)}>
            <option value="">（选择模板）</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="form-label" style={{ gridColumn: '1 / -1' }}>
          <span className="form-label-text">接收人（多个用逗号或换行分隔）</span>
          <textarea className="form-input" rows={3} value={receivers} onChange={(e) => setReceivers(e.target.value)} placeholder="如 张老师、李老师" />
        </div>
      </div>
      {err && <p className="msg-error">{err}</p>}
      {msg && <p className="muted" style={{ color: 'var(--accent)' }}>{msg}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => doSend(false)}>发送</button>
        <button className="btn btn-outline" disabled={busy} onClick={() => doSend(true)}>批量发送</button>
      </div>
    </div>
  );
}

export default function NotificationsPage() {
  const [tab, setTab] = useState<'logs' | 'templates'>('logs');
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 'var(--space-md)' }}>
        <button className={`btn btn-sm ${tab === 'logs' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('logs')}>发送记录</button>
        <button className={`btn btn-sm ${tab === 'templates' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('templates')}>通知模板</button>
      </div>
      {tab === 'logs' ? (
        <>
          <SendPanel />
          <CrudPage
            title="通知发送记录"
            subtitle="单发 / 批量发送与回执状态机（M4 通知闭环）"
            columns={LOG_COLUMNS}
            api={{
              list: (p) => api.listNotificationLogs(p),
              create: () => Promise.reject(new Error('请使用上方发送工作台创建记录')),
              update: () => Promise.reject(new Error('通知记录不可编辑')),
              archive: () => Promise.reject(new Error('通知记录不可删除')),
              transition: (id, to) => api.transitionNotificationLog(id, to),
            }}
            statusField="发送状态"
            transitions={RECEIPT_TX}
          />
        </>
      ) : (
        <CrudPage
          title="通知模板"
          subtitle="消息模板维护（M4 通知闭环）"
          columns={TPL_COLUMNS}
          api={{
            list: (p) => api.listTemplates(p),
            create: (d) => api.createTemplate(d),
            update: (id, d) => api.updateTemplate(id, d),
            archive: (id) => api.archiveTemplate(id),
          }}
        />
      )}
    </div>
  );
}
