'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function OpenPlatformPage() {
  return (
    <CrudPage
      title="开放平台"
      subtitle="外接系统的应用凭证配置（App ID / App Secret），仅系统管理员可见"
      search={{ placeholder: '搜索应用名称 / App ID…' }}
      columns={COLUMNS}
      // 模块 key：按钮级授权与接口鉴权都按 module:openPlatformApps:* 走
      moduleKey="openPlatformApps"
      statusField="状态"
      inlineEdit
      standaloneForm
      detailHref={(id) => `/open-platform/${id}`}
      api={{
        list: (p) => api.listOpenPlatformApps(p),
        create: (d) => api.createOpenPlatformApp(d),
        update: (id, d) => api.updateOpenPlatformApp(id, d),
        archive: (id) => api.archiveOpenPlatformApp(id),
      }}
    />
  );
}
