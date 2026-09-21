'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';
import CrudView from '../../../components/CrudView';
import AiSummarizeModal, { type AiSummarizeKind } from '../../../components/AiSummarizeModal';
import { NotePanel, linkText, fieldText } from '../../../components/NotePanel';
import { STUDENT_RECORD_TYPE_FIELD } from '@acms/contracts';
import { buildStudentRecordColumns, studentName as studentNameOf } from '../columns';

/**
 * 学生记录详情（2026-09-18 三合一）。
 *
 * 两条兼容约束，改的时候别踩：
 *  ① **词表按记录自身的类型走**（「沟通人」↔「观察人」），不能用列表当前的 Tab ——
 *     从列表点进来时 Tab 可能已经变了，详情页必须自证其类。
 *  ② **`entityType` 与 `kind` 必须按类型传旧的取值**（日常跟进 / 家校沟通 / 学生观察），
 *     不能统一成「学生记录」：NotePanel 的笔记绑定是按「实体类型 + 记录 id」存的，
 *     历史绑定写的就是旧类型名，统一改名会让已有绑定**全部查不出来**。
 *     ③ 2026-09-21 新增的类型「IDP沟通」传的是它**自己的**类型名（不是「日常跟进」）——
 *     同一条记录里 entityType 与 `记录类型` 字段必须一致，否则「存为笔记」写进去的
 *     「实体类型」与之后 NotePanel 查询用的就对不上（查不出已绑的笔记）。
 *     新增实体类型时记得在 `getnote.service.ts` 的 `ENTITY_TAG` 里补一条（只为标签可读）。
 */
const KIND_BY_TYPE: Record<string, AiSummarizeKind> = {
  日常跟进: 'daily-followups',
  // IDP沟通（2026-09-21 新增）用与日常跟进**同一套 AI 摘要配置**（内容完全相同）。
  // 下面的 `?? 'daily-followups'` 虽然也能兜住，但显式写出来更清楚 ——
  // 免得以后有人改了兜底值，IDP沟通 就悄悄换了一套提示词（不报错、结果变差）。
  IDP沟通: 'daily-followups',
  家校沟通: 'home-school-comms',
  学生观察: 'student-observations',
};

export default function StudentRecordDetailPage() {
  const t = useTranslations('common');
  const ts = useTranslations('students');
  const tg = useTranslations('getnote');
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [noteKey, setNoteKey] = useState(0);
  const [savingNote, setSavingNote] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError('');
    api
      .getStudentRecord(id)
      .then((data) => setRecord(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id, reloadKey]);

  const typeValue = String(record?.[STUDENT_RECORD_TYPE_FIELD] ?? '').trim();
  const columns = useMemo(() => buildStudentRecordColumns(typeValue || undefined), [typeValue]);

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '50vh' }}>
        <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!record) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>{ts('notFound')}</p></div>;

  const name = studentNameOf(record);
  // entityType 用旧类型名（历史绑定写的就是它）；缺失时回退「日常跟进」= 主表原义
  const entityType = typeValue || '日常跟进';
  const kind = KIND_BY_TYPE[entityType] ?? 'daily-followups';

  /** 反向归档：把这条记录整体存为一篇 Get笔记 并关联回本条记录 */
  const saveAsNote = async () => {
    setSavingNote(true);
    try {
      const lines = columns
        .filter((c) => c.type !== 'attachment')
        .map((c) => `- **${c.label}**：${fieldText(record[c.key])}`);
      await api.createAndLinkGetnote({
        title: `${entityType} · ${name} · ${fieldText(record['沟通时间'])}`,
        content: lines.join('\n'),
        entityType,
        entityId: id,
        entityName: name,
      });
      setNoteKey((k) => k + 1);
      alert(tg('savedAsNote'));
    } catch (e) {
      alert(tg('opFailed', { msg: (e as Error).message ?? String(e) }));
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/student-records" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">
                STUDENT-RECORD / {entityType} / {String(record['沟通编号'] ?? id.slice(0, 6))}
              </div>
              <h1 className="page-title">学生记录详情 · {name || '—'}</h1>
              <p className="page-subtitle">{ts('subtitleViewOnly')}</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-outline btn-sm" onClick={() => setAiOpen(true)}>AI 总结</button>
            <button className="btn btn-primary btn-sm" disabled={savingNote} onClick={saveAsNote}>
              {savingNote ? tg('saving') : tg('saveAsNote')}
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => router.push('/student-records')}>{t('backToList')}</button>
          </div>
        </div>
      </div>

      <CrudView columns={columns} record={record} />

      <NotePanel entityType={entityType} entityId={id} entityName={linkText(record['关联学生'])} reloadKey={noteKey} />

      {aiOpen && (
        <AiSummarizeModal
          recordId={id}
          recordName={`${entityType} · ${name}`}
          kind={kind}
          onClose={() => setAiOpen(false)}
          onSuccess={() => {
            setAiOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
