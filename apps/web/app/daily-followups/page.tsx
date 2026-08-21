'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function DailyFollowupsPage() {
  return (
    <CrudPage
      title="日常跟进"
      subtitle="学生日常跟进与待办闭环（M1 学生域）"
      search={{ placeholder: '搜索学生…' }}
      columns={COLUMNS}
      statusField="闭环状态"
      inlineEdit
      standaloneForm
      detailHref={(id) => `/daily-followups/${id}`}
      api={{
        list: (p) => api.listDailyFollowups(p),
        create: (d) => api.createDailyFollowup(d),
        update: (id, d) => api.updateDailyFollowup(id, d),
        archive: (id) => api.archiveDailyFollowup(id),
      }}
      rowExtraActions={[
        {
          label: 'AI 总结',
          run: async (row, reload) => {
            const id = String(row.id);
            const res = await api.dailyFollowupAiPrepare(id);
            const hasSource = (res.attachments?.length ?? 0) > 0 || (res.content ?? '').trim().length > 0;
            if (!hasSource) throw new Error('该记录没有可读取的附件或沟通人备注，无法生成总结');
            await api.dailyFollowupAiMergeAll(id, true, true);
            reload();
          },
        },
      ]}
    />
  );
}
