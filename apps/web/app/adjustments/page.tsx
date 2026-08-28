'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTranslations } from 'next-intl';

const STATUS_OPTS = ['待审核', '已审核'];
const DIR_OPTS = ['调整', '冲销'];

const TRANSITIONS: Record<string, string[]> = {
  待审核: ['已审核'],
};

export default function AdjustmentsPage() {
  const t = useTranslations('teachers');

  const COLUMNS: CrudColumn[] = [
    { key: '关联结算文本', label: t('colRelatedSettlement'), width: '150px', filter: true, filterType: 'text', form: true, type: 'text' },
    { key: '关联计费文本', label: t('colRelatedBilling'), width: '150px', form: true, type: 'text' },
    { key: '方向', label: t('colDirection'), width: '90px', filter: true, filterOptions: DIR_OPTS, form: true, required: true, type: 'select', options: DIR_OPTS },
    { key: '金额', label: t('colAmount'), width: '100px', form: true, type: 'number' },
    { key: '状态', label: t('colStatus'), width: '90px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
    { key: '原因', label: t('colReason'), form: true, type: 'textarea' },
    { key: '审核人', label: t('colAuditor'), width: '110px', form: true, type: 'text' },
    { key: '备注', label: t('colRemark'), form: true, type: 'text' },
  ];

  return (
    <CrudPage
      title={t('titleAdjustments')}
      subtitle={t('subtitleAdjustments')}
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listAdjustments(p),
        create: (d) => api.createAdjustment(d),
        update: (id, d) => api.updateAdjustment(id, d),
        archive: (id) => api.archiveAdjustment(id),
        transition: (id, to) => api.transitionAdjustment(id, to),
      }}
      statusField="状态"
      transitions={TRANSITIONS}
      search={{ placeholder: t('searchPlaceholderAdjustments') }}
    />
  );
}
