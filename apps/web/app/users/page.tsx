'use client';

import { useCallback, useEffect, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import UserForm from '../../components/UserForm';
import DepartmentTree from '../../components/DepartmentTree';
import { RoleLabelsCell } from '../../components/RoleLabels';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { LEVEL_OPTS, STATUS_OPTS } from './constants';

const COLUMNS: CrudColumn[] = [
  { key: '姓名', label: '姓名', width: '140px', form: true, type: 'text', required: true },
  // 「所属部门」不是用户表字段，是后端按部门成员快照（openId → 部门名）注入的只读展示字段。
  // 点左树「全部用户」或「公司」时会跨多个部门，靠它才知道每个人具体在哪。
  { key: '所属部门', label: '部门', width: '130px', form: false },
  { key: '飞书 Open ID', label: '飞书 Open ID', width: '200px', form: false, type: 'text', list: false },
  // ⚠️ 不写死 options：表单区已由 UserForm 接管，角色动态取自 GET /role-management
  { key: '系统角色', label: '系统角色', width: '200px', form: true, type: 'multiselect', render: (v) => <RoleLabelsCell value={v} /> },
  { key: '教师类型', label: '教师类型', width: '120px', form: true, type: 'select', dictKey: '教师类型', options: ['班主任', '招生老师'], filter: true },
  { key: '数据密级上限', label: '数据密级', width: '110px', form: true, type: 'select', options: LEVEL_OPTS, list: false },
  // 校区：默认选中字典第一项（=「申昆路校区」，真实校区）。
  // 原因：ABAC 会按校区逐行过滤 —— 选错校区 ⇒ 一条数据都看不到；
  // 而**留空**反而会被判成「不受校区限制」，能看到全部数据，是更危险的反向口子。
  // 所以既给默认值，又标 required（服务端也会拦，见 user.service.ts 的校验）。
  { key: '默认校区', label: '校区', width: '180px', form: true, type: 'select', dictKey: '校区', required: true, defaultFirstOption: true, render: (v) => Array.isArray(v) ? v.join('、') : String(v ?? ''), list: false },
  { key: '账号状态', label: '状态', width: '100px', form: true, type: 'select', options: STATUS_OPTS, filter: true },
];

/**
 * 用户管理（2026-09-15 加左侧「组织架构」树）。
 *
 * 左侧点部门 → 右侧账号列表同步筛选。人与部门的关系**不在用户表里**，
 * 只存在于「部门成员快照」（飞书通讯录同步落下，记录 id = `${部门ID}__${open_id}`），
 * 所以筛选由后端 `GET /users?departmentId=...` 站在快照上做（先过滤再分页 ——
 * 用户列表原本是「先取一页、再内存过滤」的游标分页，直接套会把 total 和页数算错）。
 *
 * 两个口径（峰哥 2026-09-15 确认）：
 * 1. 「含下级部门」**默认开** —— 点「学术轨」看到 12 人（含 3 个中心），
 *    与部门管理页口径一致；该层直属只有 1 人，不含下级会反直觉。
 * 2. 选中的部门**写进 URL**（`?departmentId=od-xxx`；不含下级时附 `includeSub=0`），
 *    刷新不丢、链接可分享。
 */
export default function UsersPage() {
  const tl = useTl();
  /** 左树选中的部门（'' = 全部用户，不做部门限制） */
  const [deptId, setDeptId] = useState('');
  const [deptName, setDeptName] = useState('');
  /** 含下级部门（默认开，见上方说明） */
  const [includeSub, setIncludeSub] = useState(true);
  /** 左树徽标口径：部门→成员 openId 索引 + 「有系统账号的 openId」集合 */
  const [memberIndex, setMemberIndex] = useState<{ departmentId: string; openId: string }[]>([]);
  const [accountOpenIds, setAccountOpenIds] = useState<Set<string> | undefined>(undefined);

  /**
   * 左树徽标 = 「点这个部门能筛出几个账号」。
   * 要两份数据：部门→成员 openId（member-index）+ 哪些 openId 有系统账号（人员目录）。
   * 都是几十条的小接口，进页面各拉一次；拉不到时组件自动回退成飞书的直属人数。
   */
  useEffect(() => {
    let alive = true;
    api
      .departmentMemberIndex()
      .then((r) => {
        if (alive) setMemberIndex(r.map((x) => ({ departmentId: x.departmentId, openId: x.openId })));
      })
      .catch(() => {});
    api
      .listUserDirectory()
      .then((r) => {
        if (alive) setAccountOpenIds(new Set(r.map((u) => u.openId).filter(Boolean)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 从 URL 恢复筛选（刷新保持 / 分享链接）。只在挂载时读一次，之后不再覆盖用户操作 */
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    setDeptId(qs.get('departmentId') ?? '');
    setIncludeSub(qs.get('includeSub') !== '0');
  }, []);

  const syncUrl = useCallback((id: string, sub: boolean) => {
    if (typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location.search);
    if (id) qs.set('departmentId', id);
    else qs.delete('departmentId');
    if (sub) qs.delete('includeSub');
    else qs.set('includeSub', '0');
    const s = qs.toString();
    window.history.replaceState(null, '', s ? `${window.location.pathname}?${s}` : window.location.pathname);
  }, []);

  const pick = useCallback(
    (id: string, name: string) => {
      setDeptId(id);
      setDeptName(name);
      syncUrl(id, includeSub);
    },
    [includeSub, syncUrl],
  );

  const setSub = useCallback(
    (v: boolean) => {
      setIncludeSub(v);
      syncUrl(deptId, v);
    },
    [deptId, syncUrl],
  );

  /**
   * 额外查询参数。⚠️ 每次渲染都是新对象，CrudPage 侧用序列化值做依赖
   * （内部的 extraKey），所以不会造成无限重载。
   */
  const extraParams = { departmentId: deptId || undefined, includeSub: includeSub ? undefined : '0' };

  const sidebar = (
    <>
      <DepartmentTree
        selectedId={deptId}
        onSelect={pick}
        allLabel={tl('全部用户')}
        allCount={accountOpenIds?.size}
        countedOpenIds={accountOpenIds}
        memberIndex={memberIndex}
        toolbarExtra={
          <label className="dept-sub-toggle">
            <input type="checkbox" checked={includeSub} onChange={(e) => setSub(e.target.checked)} />
            <span>{tl('含下级部门')}</span>
          </label>
        }
      />
      {deptId ? (
        <div
          className="card"
          style={{
            marginTop: 'var(--space-md)',
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 'var(--font-sm)',
          }}
        >
          <span style={{ color: 'var(--fg-tertiary)' }}>{tl('筛选中')}</span>
          <span style={{ fontWeight: 600 }}>{deptName}</span>
          {includeSub ? (
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('含下级')}</span>
          ) : null}
          <button type="button" className="link-btn" style={{ marginLeft: 'auto' }} onClick={() => pick('', '')}>
            {tl('清除筛选')}
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <CrudPage
      moduleKey="users"
      title="用户管理"
      subtitle="管理系统账号：分配飞书登录身份、系统角色、数据密级与校区。仅系统管理员可操作。"
      columns={COLUMNS}
      statusField="账号状态"
      statusClass={(s) => (s === '停用' ? 'status-off' : 'status-on')}
      transitions={{ 启用: ['停用'], 停用: ['启用'] }}
      search={{ placeholder: '搜索姓名 / 飞书 Open ID' }}
      inlineEdit
      standaloneForm
      sidebar={sidebar}
      extraParams={extraParams}
      renderForm={({ row, onDone }) => <UserForm row={row} onDone={onDone} />}
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
