// @ts-nocheck
// 创建飞书云文档（docx）工具：以服务端飞书应用身份创建一篇云文档并写入正文，返回链接。
// 复用 ai/lib/feishu/client.js 的 getTenantToken（带缓存）。
// 需要 ACMS 飞书应用在开放平台开通 docx:document 权限范围。

import { getTenantToken } from '../feishu/client.js';

const FEISHU_HOST = 'https://open.feishu.cn';

// 把简化 Markdown 文本转换为飞书 docx blocks 结构。
// 支持：# ~ ###### 标题、- / * 无序列表、1. 有序列表、普通段落。
function markdownToBlocks(md) {
  const lines = String(md || '').split(/\r?\n/);
  const children = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') continue;

    let blockType = 2;
    let field = 'text';
    let content = line;

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length; // 1..6
      blockType = 2 + level; // heading1=3 .. heading6=8
      field = 'heading' + level;
      content = h[2];
    } else if (/^\s*[-*]\s+/.test(line)) {
      blockType = 12; // bullet
      field = 'bullet';
      content = line.replace(/^\s*[-*]\s+/, '');
    } else if (/^\s*\d+\.\s+/.test(line)) {
      blockType = 13; // ordered
      field = 'ordered';
      content = line.replace(/^\s*\d+\.\s+/, '');
    }

    children.push({
      block_type: blockType,
      [field]: {
        elements: [{ text_run: { content } }],
      },
    });
  }
  return children;
}

async function createFeishuDoc({ title, content, owner_open_id } = {}, context = {}) {
  const token = await getTenantToken();
  if (!token) {
    return '创建飞书文档失败：服务端未配置飞书应用凭据（FEISHU_APP_ID / FEISHU_APP_SECRET）。请配置后重试。';
  }

  const docTitle = (title || '未命名文档').slice(0, 100);

  // 1) 创建空文档
  const res = await fetch(`${FEISHU_HOST}/open-apis/docx/v1/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: docTitle }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    return `创建飞书文档失败：${data.msg}（code ${data.code}）。请确认 ACMS 飞书应用已开通 docx:document 权限范围。`;
  }
  const documentId = data.data?.document?.document_id;
  const url = data.data?.document?.url || `https://www.feishu.cn/docx/${documentId}`;
  if (!documentId) {
    return `创建飞书文档失败：未返回 document_id（${JSON.stringify(data).slice(0, 200)}）`;
  }

  // 2) 写入正文（如有）
  const blocks = markdownToBlocks(content);
  if (blocks.length) {
    const cRes = await fetch(
      `${FEISHU_HOST}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children?document_revision_id=-1`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ children: blocks, index: -1 }),
      }
    );
    const cData = await cRes.json();
    if (cData.code !== 0) {
      return `飞书文档已创建，但正文写入失败：${cData.msg}。文档链接：${url}`;
    }
  }

  // 3) 若提供了归属用户，best-effort 将其加为可编辑成员（失败不影响返回链接）
  const owner = owner_open_id || context?.openId;
  if (owner) {
    try {
      await fetch(
        `${FEISHU_HOST}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/permissions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ member_type: 'openid', member_id: owner, perm: 'full_access', type: 'cloud' }),
        }
      );
    } catch {
      /* 权限设置失败不影响主流程 */
    }
  }

  return `已创建飞书云文档：《${docTitle}》\n链接：${url}\n（文档 ID：${documentId}）`;
}

export const createFeishuDocTool = {
  name: 'create_feishu_doc',
  description:
    '创建一篇飞书云文档（docx）并写入正文，返回文档链接。当用户要求「生成飞书文档 / 写一份纪要到飞书云文档 / 创建飞书文档」时使用。参数：{"title":"文档标题","content":"文档正文（支持简化 Markdown：# 标题、列表 - / 1.、普通段落）","owner_open_id":"可选，文档归属用户 open_id（默认用当前对话用户）"}。需要服务端飞书应用已开通 docx:document 权限范围。',
  run: createFeishuDoc,
};
