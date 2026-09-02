'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 角色_OPTS = ['学生', '家长'];
const 登录方式_OPTS = ['微信小程序', '家长H5'];
const 状态_OPTS = ['已绑定', '已解绑'];

const COLUMNS: CrudColumn[] = [
  { key: '标识', label: '登录标识', width: '220px', form: true, type: 'text', hint: '微信 openid（小程序）或 parent_<学生ID>（家长 H5）' },
  { key: '关联学生', label: '关联学生', width: '120px', form: true, type: 'text' },
  { key: '学号', label: '学号', width: '120px', form: true, type: 'text' },
  { key: '姓名', label: '姓名', width: '120px', form: true, type: 'text' },
  { key: '角色', label: '角色', width: '90px', filter: true, filterOptions: 角色_OPTS, form: true, type: 'select', options: 角色_OPTS },
  { key: '登录方式', label: '登录方式', width: '110px', filter: true, filterOptions: 登录方式_OPTS, form: true, type: 'select', options: 登录方式_OPTS },
  { key: '绑定时间', label: '绑定时间', width: '160px', form: true, type: 'datetime' },
  { key: '最近登录', label: '最近登录', width: '160px', form: true, type: 'datetime' },
  { key: '状态', label: '状态', width: '90px', filter: true, filterOptions: 状态_OPTS, form: true, type: 'select', options: 状态_OPTS },
];

export default function WechatBindingsPage() {
  return (
    <CrudPage
      title="微信用户"
      subtitle="微信用户"
      columns={COLUMNS}
      statusField="状态"
      inlineEdit
      standaloneForm
      search={{ placeholder: '登录标识、姓名、学号' }}
      api={{
        list: (p) => api.listWechatBindings(p),
        create: (d) => api.createWechatBinding(d),
        update: (id, d) => api.updateWechatBinding(id, d),
        archive: (id) => api.archiveWechatBinding(id),
      }}
      rowExtraActions={[
        {
          label: '强制下线',
          run: async (row, reload) => {
            if (!confirm(`确认强制下线「${String(row['姓名'] || row['标识'])}」的当前会话？绑定关系保留。`)) return;
            await api.forceLogoutWechatBinding(String(row.id));
            await reload();
          },
        },
        {
          label: '解绑',
          run: async (row, reload) => {
            if (!confirm(`确认解绑「${String(row['姓名'] || row['标识'])}」？将移除绑定并强制下线，该用户需重新绑定才能登录。`)) return;
            await api.unbindWechatBinding(String(row.id));
            await reload();
          },
        },
      ]}
    />
  );
}
