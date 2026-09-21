'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS, contactName, parseSourceFollowupFromSummary } from './columns';
import { useCurrentUserName } from '../../lib/useCurrentUserName';
// 操作列的录音播放（与学生记录共用同一套；逻辑见 lib/rowAudio）
import { audioAttachmentsOf, attachmentAudioSrc, useRowAudio } from '../../lib/rowAudio';

/**
 * 招生跟进的录音存在**附件字段**里（「我的笔记」转出时把音频 token 写进这个字段）。
 * 一条记录可能挂多个音频 —— 操作列的按钮播第 1 个，全部音频可在详情页逐个播放。
 */
const AUDIO_FIELD = '沟通附件清单';

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function SourceFollowupsPage() {
  const ts = useTranslations('students');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  /**
   * 新建表单的「负责人」默认值 = **当前登录用户**（2026-09-21 峰哥要求）。
   *
   * 服务端 meta 的 `defaults` 也会给同一个默认（接口直连/导入都覆盖到），
   * 这里再预填一次是为了**打开表单就能看见**，而不是保存后才出现。
   * 从「我的笔记」转过来的那条路走的是 `enrichPrefill`（见 columns.tsx）：代转别人的
   * 笔记时记笔记归属人，其余记登录用户 —— 口径统一在 contracts 的 `defaultFollowupOwner`。
   */
  const me = useCurrentUserName();

  /**
   * 操作列的行内播放（有录音才出现）—— 与学生记录页同一套交互：
   * 点一下就地播放、再点停止、点另一行自动切歌；播的是该行第 1 个音频。
   */
  const audioSrcOf = useCallback((row: Record<string, unknown>) => {
    const first = audioAttachmentsOf(row, AUDIO_FIELD)[0];
    return first?.file_token ? attachmentAudioSrc(first.file_token) : null;
  }, []);
  const { playingId, toggle: toggleRowAudio } = useRowAudio(audioSrcOf);

  const renderAudioAction = (row: Record<string, unknown>) => {
    const audios = audioAttachmentsOf(row, AUDIO_FIELD);
    if (!audios.length) return null;
    const playing = playingId === String(row.id ?? '');
    const n = audios.length;
    return (
      <button
        type="button"
        className={playing ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
        title={playing ? ts('stop') : n > 1 ? ts('playAudioN', { n }) : ts('playAudio')}
        // 行上还挂着「点击编辑」（沟通主题列 openRecord），不拦住冒泡会顺手打开表单
        onClick={(e) => {
          e.stopPropagation();
          toggleRowAudio(row);
        }}
      >
        {playing ? `⏸ ${ts('stop')}` : `▶ ${ts('play')}`}
      </button>
    );
  };

  // 按联系人聚合已选招生跟进记录，构建 AI 上下文
  const context = useMemo(() => {
    if (selected.length === 0) return '（未选择招生跟进记录）';
    const byContact = new Map<string, Record<string, unknown>[]>();
    for (const row of selected) {
      const name = contactName(row) || ts('unknownContact');
      if (!byContact.has(name)) byContact.set(name, []);
      byContact.get(name)!.push(row);
    }
    const lines: string[] = [];
    lines.push(
      '你是 ACMS 招生跟进智能分析助手。用户从招生跟进列表勾选了若干条记录，请基于以下聚合信息回答关于招生意向、跟进进度、家长反馈、风险与下一步建议等问题。若信息不足请明确说明。',
    );
    lines.push('');
    lines.push(`【已选招生跟进记录】（共 ${selected.length} 条，涉及 ${byContact.size} 位联系人）`);
    for (const [name, rows] of byContact) {
      lines.push(`◆ 联系人：${name}（${rows.length} 条）`);
      for (const r of rows) {
        const parts = [
          `沟通主题：${str(r['沟通主题']) || '—'}`,
          `跟进时间：${str(r['跟进时间']) || '—'}`,
          `跟进状态：${str(r['跟进状态']) || '—'}`,
          `活动类型：${str(r['活动类型']) || '—'}`,
          `负责人：${str(r['跟进负责人']) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const summary = str(r['沟通总结']);
        const detail = str(r['沟通明细']);
        if (summary) lines.push(`    沟通总结：${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`);
        else if (detail) lines.push(`    沟通明细：${detail.slice(0, 200)}${detail.length > 200 ? '...' : ''}`);
      }
    }
    return lines.join('\n');
  }, [selected]);

  const contactCount = useMemo(() => new Set(selected.map((r) => contactName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length
    ? ts('aiSubjectSelectedContact', { count: selected.length, contacts: contactCount })
    : ts('aiSubjectNone');

  return (
    <>
      <CrudPage
        moduleKey="sourceFollowups"
        title="招生跟进"
        subtitle="招生线索与跟进闭环（M1 学生域）"
        search={{ placeholder: '搜索学生姓名 / 沟通主题…' }}
        columns={COLUMNS}
        enrichPrefill={parseSourceFollowupFromSummary}
        // 新建时负责人默认就是当前登录用户（见上方 me）
        createDefaults={me ? { 跟进负责人: me } : undefined}
        statusField="跟进状态"
        inlineEdit
        standaloneForm
        detailHref={(id) => `/source-followups/${id}`}
        // 操作列：有录音就给「播放 / 停止」（与学生记录页同款，逻辑共用 lib/rowAudio）
        rowActionSlot={renderAudioAction}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listSourceFollowups(p),
          create: (d) => api.createSourceFollowup(d),
          update: (id, d) => api.updateSourceFollowup(id, d),
          archive: (id) => api.archiveSourceFollowup(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考学生全景，按勾选的一条或多条招生跟进记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条招生跟进记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="sourcefollowups-ai-dialog"
        placeholder="输入与招生跟进相关的问题，Enter 发送…"
      />
    </>
  );
}
