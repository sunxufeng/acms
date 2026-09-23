'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '../lib/api';
import CrudView from './CrudView';
import { COLUMNS as SOURCE_COLUMNS } from '../app/source-followups/columns';
import { Modal } from './Modal';

/**
 * 招生跟进详情弹窗（2026-09-24，供「我的跟进」展开区点击用）。
 *
 * 为什么做成弹窗而不是跳详情页：在「我的跟进」里是**连着看多条**（一个联系人可能挂 3 条招生跟进），
 * 每看一条跳一次页、再返回，来回成本太高。弹窗就地看，看完关掉继续看下一条。
 *
 * 两个页签（按峰哥要求"看总结，切换之后看明细"）：
 *   · 总结 —— 沟通主题 / 沟通总结（Markdown）/ 时间 / 负责人
 *   · 明细 —— 沟通明细（MD 对话记录）/ 附件清单
 * ⚠️ 复用招生跟进模块自己的 `COLUMNS` 做渲染，字段口径与那边保持一致（不另写一套）。
 */
type Tab = 'summary' | 'detail';

const SUMMARY_KEYS = ['关联学生', '学生姓名', '关联联系人', '沟通主题', '跟进时间', '跟进状态', '活动类型', '跟进负责人', '意向等级', '沟通总结'];
const DETAIL_KEYS = ['沟通明细', '沟通附件清单', '下次跟进日期', '下一步行动', '家长反馈态度'];

export default function SourceFollowupModal({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('myFollowups');
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [fail, setFail] = useState('');
  const [tab, setTab] = useState<Tab>('summary');

  useEffect(() => {
    setLoading(true);
    setFail('');
    api
      .getRecord('/source-followups', id)
      .then(setRecord)
      .catch((e) => setFail(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false));
  }, [id]);

  const cols = (keys: string[]) => SOURCE_COLUMNS.filter((c) => keys.includes(c.key));

  return (
    <Modal
      title={t('sourceModalTitle', { subject: String(record?.['沟通主题'] ?? '') })}
      onClose={onClose}
      width={760}
      footer={
        <Link href={`/source-followups/${id}`} className="btn btn-outline btn-sm" onClick={onClose}>
          {t('openFullPage')} →
        </Link>
      }
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['summary', 'detail'] as Tab[]).map((k) => (
          <button
            key={k}
            type="button"
            className={tab === k ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
            onClick={() => setTab(k)}
          >
            {k === 'summary' ? t('tabSummary') : t('tabDetail')}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: 'var(--fg-tertiary)' }}>{t('loading')}</p>
      ) : fail ? (
        <p className="msg-error">{t('loadFailed', { msg: fail })}</p>
      ) : record ? (
        <CrudView columns={cols(tab === 'summary' ? SUMMARY_KEYS : DETAIL_KEYS)} record={record} />
      ) : null}
    </Modal>
  );
}
