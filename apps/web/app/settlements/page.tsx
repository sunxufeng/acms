'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTranslations } from 'next-intl';

const STATUS_OPTS = ['草拟', '已提交', '审批中', '已批准', '已关闭'];

const TRANSITIONS: Record<string, string[]> = {
  草拟: ['已提交'],
  已提交: ['审批中'],
  审批中: ['已批准'],
  已批准: ['已关闭'],
};

export default function SettlementsPage() {
  const t = useTranslations('teachers');

  const COLUMNS: CrudColumn[] = [
    { key: '结算周期', label: t('colSettlePeriod'), width: '120px', filter: true, filterType: 'text', form: true, required: true, type: 'text' },
    { key: '结算主体', label: t('colSettleSubject'), width: '140px', form: true, type: 'text' },
    { key: '明细数量', label: t('colDetailCount'), width: '90px', form: true, type: 'number' },
    { key: '总金额', label: t('colTotalAmount'), width: '110px', form: true, type: 'number' },
    { key: '结算状态', label: t('colStatus'), width: '100px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
    { key: '审批人', label: t('colApprover'), width: '110px', form: true, type: 'text' },
    { key: '审批意见', label: t('colApprovalComment'), form: true, type: 'textarea' },
    { key: '备注', label: t('colRemark'), form: true, type: 'text' },
  ];

  return (
    <CrudPage
      title={t('titleSettlements')}
      subtitle={t('subtitleSettlements')}
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listSettlements(p),
        create: (d) => api.createSettlement(d),
        update: (id, d) => api.updateSettlement(id, d),
        archive: (id) => api.archiveSettlement(id),
        transition: (id, to) => api.transitionSettlement(id, to),
      }}
      statusField="结算状态"
      transitions={TRANSITIONS}
      search={{ placeholder: t('searchPlaceholderSettlements') }}
      extraActions={[
        {
          label: t('btnAggregateByPeriod'),
          run: async (reload) => {
            const period = window.prompt(t('promptSettlePeriod'));
            if (!period?.trim()) return;
            const subject = window.prompt(t('promptSettleSubject')) || '';
            await api.aggregateSettlement({ 结算周期: period.trim(), 结算主体: subject });
            await reload();
          },
        },
      ]}
    />
  );
}
