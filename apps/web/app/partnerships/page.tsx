'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTranslations } from 'next-intl';

const STATUS_OPTS = ['生效中', '已结束', '暂停'];
const METHOD_OPTS = ['按课时', '按月', '打包'];

export default function PartnershipsPage() {
  const t = useTranslations('teachers');

  const COLUMNS: CrudColumn[] = [
    { key: '教师文本', label: t('colTeacher'), width: '120px', filter: true, filterType: 'text', form: true, required: true, type: 'text' },
    { key: '合作机构文本', label: t('colPartnerOrg'), width: '140px', form: true, type: 'text' },
    { key: '计费方式', label: t('colBillingMethod'), width: '100px', filter: true, filterOptions: METHOD_OPTS, form: true, type: 'select', options: METHOD_OPTS },
    { key: '费率', label: t('colRate'), width: '90px', form: true, type: 'number' },
    { key: '计费规则说明', label: t('colBillingRule'), form: true, type: 'textarea' },
    { key: '生效开始', label: t('colEffectiveStart'), width: '130px', form: true, type: 'date' },
    { key: '生效结束', label: t('colEffectiveEnd'), width: '130px', form: true, type: 'date' },
    { key: '合作状态', label: t('colStatus'), width: '100px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
    { key: '备注', label: t('colRemark'), form: true, type: 'text' },
  ];

  return (
    <CrudPage
      title={t('titlePartnerships')}
      subtitle={t('subtitlePartnerships')}
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchPlaceholderPartnerships') }}
      api={{
        list: (p) => api.listPartnerships(p),
        create: (d) => api.createPartnership(d),
        update: (id, d) => api.updatePartnership(id, d),
        archive: (id) => api.archivePartnership(id),
      }}
    />
  );
}
