'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function SourceFollowupsPage() {
  return (
    <CrudPage
      title="招生跟进"
      subtitle="招生线索与跟进闭环（M1 学生域）"
      search={{ placeholder: '搜索学生姓名…' }}
      columns={COLUMNS}
      statusField="跟进状态"
      inlineEdit
      standaloneForm
      detailHref={(id) => `/source-followups/${id}`}
      api={{
        list: (p) => api.listSourceFollowups(p),
        create: (d) => api.createSourceFollowup(d),
        update: (id, d) => api.updateSourceFollowup(id, d),
        archive: (id) => api.archiveSourceFollowup(id),
      }}
      rowExtraActions={[
        {
          label: 'AI 总结',
          run: async (row, reload) => {
            const id = String(row.id);
            const res = await api.sourceFollowupAiPrepare(id);
            const hasSource = (res.attachments?.length ?? 0) > 0 || (res.content ?? '').trim().length > 0;
            if (!hasSource) throw new Error('该记录没有可读取的附件或沟通主题，无法生成总结');
            await api.sourceFollowupAiMergeAll(id, true, true);
            reload();
          },
        },
      ]}
    />
  );
}
