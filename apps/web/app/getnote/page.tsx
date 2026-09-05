'use client';

import { useEffect, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';

/**
 * 把 Get笔记 的 note 对象适配成 CrudPage 的行数据。
 *
 * ⚠️ 两条硬约束：
 * 1. **CrudPage 用 `row.id` 作行键**（取值、编辑、删除全走它），而 Get笔记 的 ID 字段叫
 *    `note_id`，且是 int64 的字符串形态 —— 映射过去，**绝不能转 Number**（会丢精度，
 *    末几位变 0，导致编辑/删除命中错误的笔记）。
 * 2. `tags` 是对象数组 `[{id,name,type}]`，列表里渲染成「、」连接的名称串。
 */
function toRow(n: Record<string, unknown>): Record<string, unknown> {
  const tags = Array.isArray(n.tags) ? (n.tags as { name?: string }[]) : [];
  return {
    ...n,
    id: String(n.note_id ?? n.id ?? ''),
    标签: tags.map((t) => t?.name).filter(Boolean).join('、'),
  };
}

/**
 * 表单提交前的转换：把「标签」文本拆成数组。
 * Get笔记 的 tags 是**替换语义**（传了就整体覆盖原标签），所以要显式拆成数组再提交。
 */
function withTags(d: Record<string, unknown>): Record<string, unknown> {
  const raw = d.标签;
  const list =
    typeof raw === 'string'
      ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(raw)
        ? (raw as string[])
        : undefined;
  const { 标签, ...rest } = d;
  return { ...rest, ...(list ? { tags: list } : {}) };
}

const COLUMNS: CrudColumn[] = [
  { key: 'title', label: '标题', form: true, type: 'text', required: true, width: '280px', listOrder: 1 },
  { key: 'note_type', label: '类型', width: '100px', listOrder: 2 },
  {
    key: '标签',
    label: '标签',
    form: true,
    type: 'text',
    width: '180px',
    listOrder: 3,
    hint: '多个标签用逗号分隔；保存后会整体替换原有标签',
  },
  { key: 'updated_at', label: '更新时间', width: '170px', listOrder: 4 },
  { key: 'content', label: '正文', form: true, type: 'textarea', list: false, listOrder: 5 },
];

/**
 * ⚠️ 每页条数必须与 Get笔记 服务端返回的单页条数一致。
 * Get笔记 的列表接口**不支持自定义 pageSize**，而 CrudPage 用 `total / pageSize` 推算总页数，
 * 两边不一致会让分页条显示的页数不对。拿到 API Key 实测后校准这个常量。
 */
const PAGE_SIZE = 20;

export default function GetnotePage() {
  const tl = useTl();
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .getnoteStatus()
      .then((r) => setConfigured(Boolean(r?.configured)))
      .catch(() => setConfigured(false));
  }, []);

  // 未配置凭证时给明确引导，而不是让用户在列表页撞一堆 502
  if (configured === false) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          {tl('尚未配置得到大脑（Get笔记）的 API Key。')}
        </p>
        <p className="muted">
          {tl('请在服务器 /opt/acms/.env 中配置 GETNOTE_API_KEY 与 GETNOTE_CLIENT_ID，然后重启 acms-api 服务。')}
        </p>
      </div>
    );
  }

  return (
    <CrudPage
      title="知识库"
      subtitle="得到大脑笔记"
      columns={COLUMNS}
      pageSize={PAGE_SIZE}
      inlineEdit
      standaloneForm
      search={{ placeholder: '语义搜索' }}
      api={{
        list: async (p) => {
          const res = await api.listGetnote(p);
          return { ...res, items: res.items.map(toRow) };
        },
        create: (d) => api.createGetnote(withTags(d)),
        update: (id, d) => api.updateGetnote(id, withTags(d)),
        // 删除 = 移入回收站，可恢复
        archive: (id) => api.deleteGetnote(id),
      }}
    />
  );
}
