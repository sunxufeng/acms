// @ts-nocheck
import { Injectable, Logger, ForbiddenException, NotFoundException, Inject, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize } from '@acms/domain';
import { BaseClient, toText } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { routeChat } from '../ai/lib/gateway/router.js';
import type { AiSummarizeTableConfig } from './ai-summarize.config.js';

const WRITE_PERM = 'student:write';

@Injectable()
export class AiSummarizeService {
  private readonly logger = new Logger('AiSummarize');

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly fileUpload: FileUploadService,
  ) {}

  /** tableId|fieldName -> fieldId 缓存（避免每次 AI 总结都拉字段列表） */
  private fieldIdCache = new Map<string, string>();

  private async resolveFieldId(tableId: string, fieldName: string): Promise<string | undefined> {
    const key = `${tableId}|${fieldName}`;
    if (this.fieldIdCache.has(key)) return this.fieldIdCache.get(key);
    try {
      const fields = await this.base.listFields(tableId);
      const hit = (fields || []).find((f: { field_name?: string; name?: string; field_id?: string; id?: string }) =>
        f.field_name === fieldName || f.name === fieldName,
      );
      const id = hit?.field_id || hit?.id;
      if (id) this.fieldIdCache.set(key, id);
      return id;
    } catch {
      return undefined;
    }
  }

  private toPrincipal(user: SessionUser) {
    return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
  }

  private checkWrite(user: SessionUser) {
    if (!authorize(this.toPrincipal(user), WRITE_PERM).allowed) {
      throw new ForbiddenException('FORBIDDEN:' + WRITE_PERM);
    }
  }

  /** 解析附件字段值：飞书文本字段返回 [{text:'...',type:'text'}]，里面存 JSON 数组 */
  private parseAttachments(v: unknown): { file_token: string; name: string }[] {
    const raw = toText(v);
    if (!raw) return [];
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(arr)) return [];
    return arr
      .map((it) => (typeof it === 'string' ? { file_token: '', name: it } : it) as { file_token?: string; name?: string })
      .filter((it) => it && it.file_token)
      .map((it) => ({ file_token: it.file_token as string, name: it.name || it.file_token as string }));
  }

  /** 从下载的文件中抽取纯文本：文本类直接解码；疑似二进制给出说明 */
  private extractText(buf: Buffer, name: string): string {
    const lower = (name || '').toLowerCase();
    const textExts = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml'];
    if (!textExts.some((x) => lower.endsWith(x))) {
      return `（附件「${name}」为二进制格式，暂不支持自动解析，请在「沟通内容」中补充要点）`;
    }
    if (buf.includes(0)) {
      return `（附件「${name}」疑似二进制，跳过自动解析）`;
    }
    try {
      return buf.toString('utf-8');
    } catch {
      return '';
    }
  }

  private async readAttachment(cfg: AiSummarizeTableConfig, recordId: string, fileToken: string, name: string): Promise<string> {
    const fieldId = await this.resolveFieldId(cfg.tableId, cfg.fieldAttach);
    if (!fieldId) throw new Error(`无法解析附件字段「${cfg.fieldAttach}」的 fieldId`);
    const tmpUrl = await this.fileUpload.getBitableTmpDownloadUrl(cfg.tableId, recordId, fieldId, fileToken);
    const resp = await fetch(tmpUrl);
    if (!resp.ok) {
      throw new Error(`下载失败 HTTP ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return this.extractText(buf, name);
  }

  /** 读取记录并做权限校验 */
  private async getRecord(cfg: AiSummarizeTableConfig, user: SessionUser, id: string) {
    this.checkWrite(user);
    const rec = await this.base.get(cfg.tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return { cfg, fields: rec.fields as Record<string, unknown> };
  }

  /** 供前端弹窗使用：返回当前附件、已有明细/总结、沟通内容 */
  async prepare(cfg: AiSummarizeTableConfig, user: SessionUser, id: string) {
    const { fields } = await this.getRecord(cfg, user, id);
    return {
      attachments: this.parseAttachments(fields[cfg.fieldAttach]),
      currentDetail: toText(fields[cfg.fieldDetail]) || '',
      currentSummary: toText(fields[cfg.fieldSummary]) || '',
      content: toText(fields[cfg.fieldContent]) || '',
    };
  }

  /** 同步单个附件：把该附件文本写入「沟通明细」 */
  async syncAttachment(
    cfg: AiSummarizeTableConfig,
    user: SessionUser,
    id: string,
    fileToken: string,
    overwriteDetail = false,
  ) {
    const { fields } = await this.getRecord(cfg, user, id);
    const attachments = this.parseAttachments(fields[cfg.fieldAttach]);
    const target = attachments.find((a) => a.file_token === fileToken);
    if (!target) throw new BadRequestException('ATTACHMENT_NOT_FOUND');

    const text = await this.readAttachment(cfg, id, target.file_token, target.name);
    if (!text.trim()) throw new BadRequestException('ATTACHMENT_EMPTY:该附件无可用文本内容');

    const currentDetail = toText(fields[cfg.fieldDetail]) || '';
    let detail = currentDetail;
    if (overwriteDetail || !currentDetail.trim()) {
      detail = `## 附件来源：${target.name}\n\n${text}`;
      await this.base.update(cfg.tableId, id, { [cfg.fieldDetail]: detail });
    }

    return {
      ok: true,
      synced: target.name,
      overwritten: Boolean(overwriteDetail || !currentDetail.trim()),
      [cfg.fieldDetail]: detail,
    };
  }

  /** 合并所有附件：生成/覆盖「沟通明细」，并据此生成/覆盖「沟通总结」 */
  async mergeAll(
    cfg: AiSummarizeTableConfig,
    user: SessionUser,
    id: string,
    overwriteDetail = false,
    overwriteSummary = false,
  ) {
    const { fields } = await this.getRecord(cfg, user, id);
    const attachments = this.parseAttachments(fields[cfg.fieldAttach]);

    let corpus = '';
    let okCount = 0;
    for (const a of attachments) {
      try {
        const text = await this.readAttachment(cfg, id, a.file_token, a.name);
        if (text) {
          corpus += `\n\n--- 附件来源：${a.name} ---\n${text}`;
          okCount++;
        }
      } catch (e) {
        this.logger.warn(`附件解析失败 ${a.name}: ${(e as Error).message}`);
      }
    }

    if (!corpus.trim()) {
      const content = toText(fields[cfg.fieldContent]);
      if (content) corpus = `\n\n--- 沟通内容 ---\n${content}`;
    }

    if (!corpus.trim()) {
      throw new NotFoundException('NO_SOURCE:该记录既没有附件，也没有「沟通内容」文本，无法生成总结');
    }

    const meta = cfg.metaFields
      .map((m) => `${m.label}：${toText(fields[m.key]) || '—'}`)
      .join('\n');

    const currentDetail = toText(fields[cfg.fieldDetail]) || '';
    const currentSummary = toText(fields[cfg.fieldSummary]) || '';

    let detailMd = currentDetail;
    if (overwriteDetail || !currentDetail.trim()) {
      detailMd = await this.generateDetail(meta, corpus);
      await this.base.update(cfg.tableId, id, { [cfg.fieldDetail]: detailMd });
    }

    let summary = currentSummary;
    if (overwriteSummary || !currentSummary.trim()) {
      summary = await this.generateSummary(meta, detailMd);
      await this.base.update(cfg.tableId, id, { [cfg.fieldSummary]: summary });
    }

    return {
      ok: true,
      [cfg.fieldDetail]: detailMd,
      [cfg.fieldSummary]: summary,
      parsedAttachments: okCount,
      totalAttachments: attachments.length,
      detailOverwritten: overwriteDetail || !currentDetail.trim(),
      summaryOverwritten: overwriteSummary || !currentSummary.trim(),
    };
  }

  /** 一键总结：等价于 mergeAll(detail=true, summary=true) */
  async aiSummarize(cfg: AiSummarizeTableConfig, user: SessionUser, id: string) {
    return this.mergeAll(cfg, user, id, true, true);
  }

  private async chat(user: SessionUser, messages: { role: string; content: string }[]): Promise<string> {
    const res = await routeChat(user.openId, messages);
    return (res && res.content) || '';
  }

  private async generateDetail(meta: string, corpus: string): Promise<string> {
    const system =
      '你是沟通记录整理助手。请把提供的沟通素材整理为规范的「沟通明细」Markdown 对话记录。' +
      '要求：使用 Markdown 标题/列表/引用等结构；按对话双方还原发言；' +
      '保留关键事实、时间、诉求与共识；不要编造素材中不存在的信息；中文输出。';
    const userMsg =
      `【记录基本信息】\n${meta}\n\n【沟通素材（附件/沟通内容）】\n${corpus}\n\n` +
      `请输出 Markdown 格式的沟通明细（对话记录）。`;
    return this.chatWithRetry(user, system, userMsg);
  }

  private async generateSummary(meta: string, detailMd: string): Promise<string> {
    const system =
      '你是沟通总结助手。请基于「沟通明细」提炼一份结构化的「沟通总结（报告）」。' +
      '要求：使用 Markdown；包含「核心结论 / 关键议题 / 诉求与反馈 / 后续待办 / 风险提示（如有）」等小节；' +
      '简洁、客观、可执行；不要复述全部对话；中文输出。';
    const userMsg =
      `【记录基本信息】\n${meta}\n\n【沟通明细（MD 对话记录）】\n${detailMd}\n\n` +
      `请输出 Markdown 格式的沟通总结（报告）。`;
    return this.chatWithRetry(user, system, userMsg);
  }

  private async chatWithRetry(user: SessionUser, system: string, userMsg: string, attempts = 2): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const out = await this.chat(user, [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ]);
        if (out && out.trim()) return out.trim();
        lastErr = new Error('模型返回为空');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('模型调用失败');
  }
}
