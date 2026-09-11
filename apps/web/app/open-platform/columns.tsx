import type { CrudColumn } from '../../components/CrudPage';

/**
 * 开放平台 · 外接系统应用的列定义。
 *
 * 数据存在 ACMS 自建 SQL 表（不走飞书 Base），所以字段名自由定义。
 *
 * ⚠️ App Secret 的安全约定（与后端 lifecycle.meta.ts 的 secretFields 配套）：
 *  - 列表：不展示（`list: false`）
 *  - 表单：`type: 'password'`，读回来是掩码 `******`
 *  - 保存：原样回传掩码 = 不修改；改成别的值才真正更新（库里 AES 加密存储）
 */
export const COLUMNS: CrudColumn[] = [
  {
    key: '应用名称',
    label: '应用名称',
    width: '180px',
    form: true,
    type: 'text',
    required: true,
    filter: true,
    openRecord: true,
  },
  {
    key: '系统来源',
    label: '系统来源',
    width: '140px',
    form: true,
    type: 'select',
    // 候选项来自字典表（后端 dict.data.ts 的「外接系统来源」，运营可在字典数据页自助增删）
    dictKey: '外接系统来源',
    required: true,
    filter: true,
  },
  {
    key: 'App ID',
    label: 'App ID',
    width: '220px',
    form: true,
    type: 'text',
    required: true,
  },
  {
    key: 'App Secret',
    label: 'App Secret',
    width: '180px',
    form: true,
    type: 'password',
    required: true,
    // 敏感凭证：不在列表展示；编辑时显示掩码，不改就不覆盖
    list: false,
    hint: '保存后不可查看原文，仅在修改时重新输入；库中加密存储',
  },
  { key: '接口地址', label: '接口地址', width: '220px', form: true, type: 'text' },
  { key: '回调地址', label: '回调地址', width: '220px', form: true, type: 'text' },
  {
    key: '状态',
    label: '状态',
    width: '90px',
    form: true,
    type: 'select',
    dictKey: '开放平台应用状态',
    required: true,
    filter: true,
    render: (v) => {
      const on = String(v ?? '') === '启用';
      return (
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 'var(--font-xs)',
            background: on ? 'var(--success-bg, #eaf5ee)' : 'var(--bg-hover)',
            color: on ? 'var(--success, #2c6b45)' : 'var(--fg-tertiary)',
          }}
        >
          {String(v ?? '—')}
        </span>
      );
    },
  },
  { key: '备注', label: '备注', width: '240px', form: true, type: 'textarea', fieldHeight: 3 },
];
