'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const ROLE_OPTS = ['系统管理员', '院级管理', '教务', '财务', '教师本人', '学生事务', '招生', 'HR行政', '审计'];
const LEVEL_OPTS = ['一般', '内部', '敏感', '高度敏感', 'L4'];
const STATUS_OPTS = ['启用', '停用'];

const COLUMNS: CrudColumn[] = [
  { key: '姓名', label: '姓名', width: '140px', form: true, type: 'text', required: true },
  { key: '飞书 Open ID', label: '飞书 Open ID', width: '200px', form: true, type: 'text', required: true, list: false },
  { key: '系统角色', label: '系统角色', width: '200px', form: true, type: 'multiselect', options: ROLE_OPTS, render: (v) => Array.isArray(v) ? v.join('、') : String(v ?? '') },
  { key: '教师类型', label: '教师类型', width: '120px', form: true, type: 'select', dictKey: '教师类型', options: ['班主任', '招生老师'], filter: true },
  { key: '数据密级上限', label: '数据密级', width: '110px', form: true, type: 'select', options: LEVEL_OPTS, list: false },
  { key: '默认校区', label: '校区', width: '180px', form: true, type: 'select', dictKey: '校区', render: (v) => Array.isArray(v) ? v.join('、') : String(v ?? ''), list: false },
  { key: '账号状态', label: '状态', width: '100px', form: true, type: 'select', options: STATUS_OPTS, filter: true },
];

export default function UsersPage() {
  return (
    <CrudPage
      title="用户管理"
      subtitle="管理系统账号：分配飞书登录身份、系统角色、数据密级与校区。仅系统管理员可操作。"
      columns={COLUMNS}
      statusField="账号状态"
      statusClass={(s) => (s === '停用' ? 'status-off' : 'status-on')}
      transitions={{ 启用: ['停用'], 停用: ['启用'] }}
      search={{ placeholder: '搜索姓名 / 飞书 Open ID' }}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listUsers(p),
        create: (d) => api.createUser(d),
        update: (id, d) => api.updateUser(id, d),
        archive: (id) => api.deleteUser(id),
        transition: (id, to) => api.setUserStatus(id, to),
      }}
    />
  );
}
