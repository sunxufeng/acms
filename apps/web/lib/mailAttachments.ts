/**
 * 邮件归档的附件解析与体积格式化 —— **只写一份**。
 *
 * 「附件信息」字段存的是 JSON 字符串（`[{name,size,type,file_token}]`），
 * 但历史记录可能是已经是数组的形态，两种都要兼容。
 *
 * 使用者：邮件归档列表（`app/mail-archive/columns.tsx` 的 AttachmentCell）
 * 与学生档案「相关邮件」（`app/students/[id]/page.tsx`）。
 * 各写一份的话，哪天解析规则变了（例如上游换字段名、size 改成字符串）必然漏改一处，
 * 表现是「一个页面有附件、另一个没有」，很难查。
 */

export interface MailAttachment {
  name: string;
  size: number;
  type: string;
  file_token: string;
}

/** 宽容解析「附件信息」：数组直接用，JSON 字符串解析，其余一律当「无附件」 */
export function parseMailAttachments(raw: unknown): MailAttachment[] {
  if (Array.isArray(raw)) return raw as MailAttachment[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p)) return p as MailAttachment[];
    } catch {
      /* 解析失败按无附件处理 */
    }
  }
  return [];
}

/** 附件体积展示（0/空 返回空串，调用方自己决定要不要显示） */
export function fmtAttachmentSize(n?: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
