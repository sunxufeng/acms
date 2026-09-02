'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';

export type Auto = {
  id?: string;
  title: string;
  description: string;
  cron: string;
  cronText?: string;
  enabled: boolean;
  idleOnly?: boolean;
  pushTo?: string[];
  maxSteps?: number;
  agentId?: string;
  actionType?: string;
};

type AgentOption = { id: string; name: string; emoji?: string; provider?: string; model?: string };
type UserOption = { openId: string; name: string; role?: string };

export function AutomationForm({ initial, onDone }: { initial?: Partial<Auto>; onDone: () => void }) {
  const t = useTranslations('ai.automations');
  // 通用文案（「（未设置）」等）放在 ai 命名空间根层
  const ta = useTranslations('ai');
  const isEdit = !!initial?.id;
  const [title, setTitle] = useState(initial?.title || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [freq, setFreq] = useState('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(35);
  const [cron, setCron] = useState(initial?.cron || '35 9 * * *');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [idleOnly, setIdleOnly] = useState(!!initial?.idleOnly);
  const [maxSteps, setMaxSteps] = useState(initial?.maxSteps || 10);
  const [agentId, setAgentId] = useState(initial?.agentId || '');
  // 结果动作：push（默认，推送给收件人）/ memory（仅写回智能体记忆，无需收件人）
  const [actionType, setActionType] = useState(initial?.actionType === 'memory' ? 'memory' : 'push');
  const [recipients, setRecipients] = useState<string[]>((initial?.pushTo || []).filter(Boolean));
  const [agentOpenId, setAgentOpenId] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiListAgents().then((list) => setAgents(list as AgentOption[])).catch(() => null);
  }, []);

  // 从系统用户表拉取「飞书 Open ID」，作为收件人选择器数据源（无需手动查 open_id）
  useEffect(() => {
    let alive = true;
    const collected: UserOption[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const params: Record<string, string | undefined> = { pageSize: '100' };
      if (token) params.pageToken = token;
      const p = await api.listUsers(params);
      for (const u of p.items) {
        const openId = String(u['飞书 Open ID'] ?? '');
        if (openId) collected.push({ openId, name: String(u['姓名'] ?? ''), role: Array.isArray(u['系统角色']) ? u['系统角色'].join('、') : String(u['系统角色'] ?? '') });
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => {
        if (alive) setUsers(collected);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const selAgent = agents.find((a) => a.id === agentId) || null;

  async function buildCron() {
    try {
      const r = await api.aiBuildCron({ freq, hour, minute });
      setCron(r.cron);
    } catch { /* ignore */ }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        title, description, cron, enabled, idleOnly,
        actionType,
        maxSteps: Number(maxSteps) || 10,
        agentId: agentId || undefined,
      };
      // 仅记忆型不需要收件人；推送型才带 pushTo（系统用户勾选 + 手工填写的飞书智能体 open_id）
      if (actionType === 'push') {
        const extra = agentOpenId.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
        payload.pushTo = Array.from(new Set([...recipients, ...extra]));
      }
      if (isEdit) await api.aiUpdateAutomation(initial!.id!, payload);
      else await api.aiCreateAutomation(payload);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id="automation-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {error && <p className="msg-error" style={{ marginBottom: 12 }}>{error}</p>}

      {/* 基本信息 */}
      <fieldset className="form-fieldset">
        <legend className="form-legend">{t('legendBasic')}</legend>
        <div className="form-grid">
          <div className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('title')}</span>
            <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('titlePlaceholder')} />
          </div>

          <div className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('prompt')}</span>
            <textarea className="form-input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('promptPlaceholder')} />
          </div>

          <div className="form-label">
            <span className="form-label-text">{t('bindAgent')}</span>
            <select className="form-input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">{t('bindAgentDefault')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.emoji || '🤖'} {a.name}</option>
              ))}
            </select>
          </div>

          {selAgent && (
            <div className="form-label">
              <span className="form-label-text">{t('inheritConfig')}</span>
              <p className="form-hint" style={{ margin: 0 }}>
                {t('inheritProvider')}：{selAgent.provider || ta('notSet')} ／ {t('inheritModel')}：{selAgent.model || ta('notSet')}
              </p>
            </div>
          )}
        </div>
      </fieldset>

      {/* 调度与执行 */}
      <fieldset className="form-fieldset" style={{ marginTop: 'var(--space-md)' }}>
        <legend className="form-legend">{t('legendSchedule')}</legend>
        <div className="form-grid">
          <div className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('schedule')}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="form-input" style={{ width: 'auto' }} value={freq} onChange={(e) => setFreq(e.target.value)}>
                <option value="daily">{t('freqDaily')}</option>
                <option value="weekly">{t('freqWeekly')}</option>
                <option value="monthly">{t('freqMonthly')}</option>
                <option value="hourly">{t('freqHourly')}</option>
              </select>
              <input className="form-input" style={{ width: 80 }} type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Number(e.target.value))} />
              <input className="form-input" style={{ width: 80 }} type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Number(e.target.value))} />
              <button type="button" className="btn btn-outline" onClick={buildCron}>{t('genCron')}</button>
            </div>
          </div>

          <div className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('cronExpr')}</span>
            <input className="form-input" value={cron} onChange={(e) => setCron(e.target.value)} />
          </div>

          <div className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('resultAction')}</span>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label className="checkbox-label"><input type="radio" name="actionType" checked={actionType === 'push'} onChange={() => setActionType('push')} /> {t('actionPush')}</label>
              <label className="checkbox-label"><input type="radio" name="actionType" checked={actionType === 'memory'} onChange={() => setActionType('memory')} /> {t('actionMemory')}</label>
            </div>
          </div>

          {actionType === 'push' && (
            <div className="form-label" style={{ gridColumn: '1 / -1' }}>
              <span className="form-label-text">{t('recipients')}</span>
              <div className="recipient-list">
                {users.length === 0 ? (
                  <div className="form-hint">{t('recipientsLoading')}</div>
                ) : (
                  users.map((u) => (
                    <label key={u.openId} className="recipient-item">
                      <input
                        type="checkbox"
                        checked={recipients.includes(u.openId)}
                        onChange={(e) => setRecipients((prev) => (e.target.checked ? Array.from(new Set([...prev, u.openId])) : prev.filter((x) => x !== u.openId)))}
                      />
                      <span className="recipient-name">{u.name || u.openId}</span>
                      {u.role ? <span className="recipient-role">{u.role}</span> : null}
                      <span className="recipient-openid">{u.openId}</span>
                    </label>
                  ))
                )}
              </div>
              {recipients.length === 0 && <p className="form-hint" style={{ color: 'var(--danger)' }}>{t('recipientsRequired')}</p>}

              <span className="form-label-text" style={{ marginTop: 4 }}>{t('agentOpenId')}</span>
              <input className="form-input" value={agentOpenId} onChange={(e) => setAgentOpenId(e.target.value)} placeholder={t('agentOpenIdPlaceholder')} />
            </div>
          )}

          <div className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('switches')}</span>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('enabled')}</label>
              <label className="checkbox-label"><input type="checkbox" checked={idleOnly} onChange={(e) => setIdleOnly(e.target.checked)} /> {t('idleOnly')}</label>
            </div>
          </div>

          <div className="form-label">
            <span className="form-label-text">{t('maxSteps')}</span>
            <input className="form-input" type="number" min={1} max={50} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} />
          </div>
        </div>
      </fieldset>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
        <button type="button" className="btn btn-ghost" onClick={onDone}>{t('cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('saving') : t('save')}</button>
      </div>
    </form>
  );
}
