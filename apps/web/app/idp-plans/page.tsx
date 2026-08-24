'use client';

import { useRouter } from 'next/navigation';
import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function IdpPlansPage() {
  const router = useRouter();
  return (
    <CrudPage
      title="IDP管理"
      subtitle="学生个性化发展计划（IDP）：人生平衡轮、目标与行动、阶段成果与展示路演（M1 学生域）"
      search={{ placeholder: '搜索学生…' }}
      columns={COLUMNS}
      statusField="状态"
      createHref="/idp-plans/new"
      editHref={(id) => `/idp-plans/${id}/edit`}
      detailHref={(id) => `/idp-plans/${id}`}
      rowExtraActions={[
        {
          label: '新增沟通',
          run: (row) => router.push(`/idp-plans/${String(row.id)}/communications/new`),
        },
      ]}
      api={{
        list: (p) => api.listIdpPlans(p),
        create: (d) => api.createIdpPlan(d),
        update: (id, d) => api.updateIdpPlan(id, d),
        archive: (id) => api.archiveIdpPlan(id),
      }}
    />
  );
}
