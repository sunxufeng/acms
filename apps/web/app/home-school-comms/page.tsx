'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function HomeSchoolCommsPage() {
  return (
    <CrudPage
      title="家校沟通"
      subtitle="家长沟通与待办闭环（M1 学生域）"
      search={{ placeholder: '搜索学生…' }}
      columns={COLUMNS}
      statusField="闭环状态"
      inlineEdit
      standaloneForm
      detailHref={(id) => `/home-school-comms/${id}`}
      api={{
        list: (p) => api.listHomeSchoolComms(p),
        create: (d) => api.createHomeSchoolComm(d),
        update: (id, d) => api.updateHomeSchoolComm(id, d),
        archive: (id) => api.archiveHomeSchoolComm(id),
      }}
      rowExtraActions={[
        {
          label: 'AI 总结',
          run: async (row, reload) => {
            const id = String(row.id);
            const res = await api.aiSummarizePrepare(id);
            const hasSource = (res.attachments?.length ?? 0) > 0 || (res.content ?? '').trim().length > 0;
            if (!hasSource) throw new Error('该记录没有可读取的附件或沟通人备注，无法生成总结');
            await api.aiSummarizeMergeAll(id, true, true);
            reload();
          },
        },
      ]}
    />
  );
}
