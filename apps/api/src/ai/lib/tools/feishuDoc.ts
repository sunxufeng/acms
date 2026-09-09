// 创建 ACMS 内部文档（云文档内化）：AI 工具把正文以 Markdown 落 PostgreSQL ai_docs，
// 返回系统内链接，不再创建飞书云文档。归属当前对话用户，可在「AI 文档」页查看/编辑。

import type { AiDocsService } from '../../../ai-docs/ai-docs.service.js';

export interface AcmsDocToolContext {
  openId?: string;
  [k: string]: unknown;
}

export const createAcmsDocTool = (service: AiDocsService) => ({
  name: 'create_acms_doc',
  description:
    '创建一篇 ACMS 内部文档（Markdown）并保存，返回系统内链接。当用户要求「生成文档 / 写一份纪要 / 创建文档 / 保存为文档」时使用。参数：{"title":"文档标题","content":"文档正文（支持简化 Markdown：# 标题、列表 - / 1.、普通段落）","ref_table":"可选，关联表 key","ref_record":"可选，关联记录 id"}。文档归属当前对话用户，可在 ACMS「AI 文档」页查看。',
  run: async (
    args: { title?: string; content?: string; ref_table?: string; ref_record?: string } = {},
    context: AcmsDocToolContext = {},
  ) => {
    try {
      const r = await service.create({
        title: args.title,
        content: args.content,
        ownerOpenId: context?.openId,
        refTable: args.ref_table,
        refRecord: args.ref_record,
      });
      return `已创建 ACMS 文档：《${args.title || '未命名文档'}》\n链接：${r.url}\n（文档 ID：${r.id}）`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `创建 ACMS 文档失败：${msg}`;
    }
  },
});
