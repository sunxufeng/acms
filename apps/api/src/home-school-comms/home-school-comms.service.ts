// @ts-nocheck
import { Injectable, Logger, ForbiddenException, NotFoundException, Inject, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize } from '@acms/domain';
import { BaseClient, toText } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { TABLES } from '@acms/contracts';
import { routeChat } from '../ai/lib/gateway/router.js';

const WRITE_PERM = 'student:write';
const FIELD_ATTACH = '沟通附件清单';
const FIELD_DETAIL = '沟通明细';
const FIELD_SUMMARY = '沟通总结';
const FIELD_CONTENT = '沟通内容';

/** 家校沟通「AI 总结」：附件内容抽取 → 生成 MD 沟通明细 + 沟通总结，回写飞书表 */
@Injectable()
export class HomeSchoolCommsService {
  private readonly logger = new Logger('HomeSchoolComms');
  /** 调用时由上层方法注入的当前用户（routeChat 需 openId 选模型） */
  private currentUser: SessionUser | null = null;

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly fileUpload: FileUploadService,
  ) {}

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

  private async readAttachment(fileToken: string, name: string): Promise<string> {
    const resp = await this.fileUpload.downloadFile(fileToken);
    if (!resp.ok) {
      throw new Error(`下载失败 HTTP ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return this.extractText(buf, name);
  }

  /** 读取记录并做权限校验 */
  private async getRecord(user: SessionUser, id: string) {
    this.checkWrite(user);
    this.currentUser = user;
    const tableId = TABLES.homeSchoolComm.tableId;
    const rec = await this.base.get(tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return { tableId, fields: rec.fields as Record<string, unknown> };
  }

  /** 供前端弹窗使用：返回当前附件、已有明细/总结、沟通内容 */
  async prepare(user: SessionUser, id: string) {
    const { fields } = await this.getRecord(user, id);
    return {
      attachments: this.parseAttachments(fields[FIELD_ATTACH]),
      currentDetail: toText(fields[FIELD_DETAIL]) || '',
      currentSummary: toText(fields[FIELD_SUMMARY]) || '',
      content: toText(fields[FIELD_CONTENT]) || '',
    };
  }

  /**
   * 同步单个附件：把该附件文本写入「沟通明细」。
   * overwriteDetail=true 时强制覆盖；false 且已有明细时不覆盖。
   */
  async syncAttachment(user: SessionUser, id: string, fileToken: string, overwriteDetail = false) {
    const { tableId, fields } = await this.getRecord(user, id);
    const attachments = this.parseAttachments(fields[FIELD_ATTACH]);
    const target = attachments.find((a) => a.file_token === fileToken);
    if (!target) throw new BadRequestException('ATTACHMENT_NOT_FOUND');

    const text = await this.readAttachment(target.file_token, target.name);
    if (!text.trim()) throw new BadRequestException('ATTACHMENT_EMPTY:该附件无可用文本内容');

    const currentDetail = toText(fields[FIELD_DETAIL]) || '';
    let detail = currentDetail;
    if (overwriteDetail || !currentDetail.trim()) {
      detail = `## 附件来源：${target.name}\n\n${text}`;
      await this.base.update(tableId, id, { [FIELD_DETAIL]: detail });
    }

    return {
      ok: true,
      synced: target.name,
      overwritten: Boolean(overwriteDetail || !currentDetail.trim()),
      [FIELD_DETAIL]: detail,
    };
  }

  /**
   * 合并所有附件：生成/覆盖「沟通明细」，并据此生成/覆盖「沟通总结」。
   * overwriteDetail=false 且已有明细时保留原明细；overwriteSummary=false 且已有总结时保留原总结。
   */
  async mergeAll(
    user: SessionUser,
    id: string,
    overwriteDetail = false,
    overwriteSummary = false,
  ) {
    const { tableId, fields } = await this.getRecord(user, id);
    const attachments = this.parseAttachments(fields[FIELD_ATTACH]);

    // 1) 收集附件文本
    let corpus = '';
    let okCount = 0;
    for (const a of attachments) {
      try {
        const text = await this.readAttachment(a.file_token, a.name);
        if (text) {
          corpus += `\n\n--- 附件来源：${a.name} ---\n${text}`;
          okCount++;
        }
      } catch (e) {
        this.logger.warn(`附件解析失败 ${a.name}: ${(e as Error).message}`);
      }
    }

    // 2) 无附件时回退到「沟通内容」
    if (!corpus.trim()) {
      const content = toText(fields[FIELD_CONTENT]);
      if (content) corpus = `\n\n--- 沟通内容 ---\n${content}`;
    }

    if (!corpus.trim()) {
      throw new NotFoundException('NO_SOURCE:该记录既没有附件，也没有「沟通内容」文本，无法生成总结');
    }

    const meta = [
      `关联学生：${toText(fields['关联学生']) || '—'}`,
      `家长：${toText(fields['家长']) || '—'}`,
      `沟通人：${toText(fields['沟通人']) || '—'}`,
      `沟通方式：${toText(fields['沟通方式']) || '—'}`,
      `沟通主题：${toText(fields['沟通主题']) || '—'}`,
      `沟通时间：${toText(fields['沟通时间']) || '—'}`,
    ].join('\n');

    const currentDetail = toText(fields[FIELD_DETAIL]) || '';
    const currentSummary = toText(fields[FIELD_SUMMARY]) || '';

    // 3) 生成/保留沟通明细
    let detailMd = currentDetail;
    if (overwriteDetail || !currentDetail.trim()) {
      detailMd = await this.generateDetail(meta, corpus);
      await this.base.update(tableId, id, { [FIELD_DETAIL]: detailMd });
    }

    // 4) 生成/保留沟通总结（基于最终明细）
    let summary = currentSummary;
    if (overwriteSummary || !currentSummary.trim()) {
      summary = await this.generateSummary(meta, detailMd);
      await this.base.update(tableId, id, { [FIELD_SUMMARY]: summary });
    }

    return {
      ok: true,
      [FIELD_DETAIL]: detailMd,
      [FIELD_SUMMARY]: summary,
      parsedAttachments: okCount,
      totalAttachments: attachments.length,
      detailOverwritten: overwriteDetail || !currentDetail.trim(),
      summaryOverwritten: overwriteSummary || !currentSummary.trim(),
    };
  }

  /** 一键总结：等价于 mergeAll(detail=true, summary=true) */
  async aiSummarize(user: SessionUser, id: string) {
    return this.mergeAll(user, id, true, true);
  }

  private async chat(messages: { role: string; content: string }[]): Promise<string> {
    if (!this.currentUser) throw new Error('内部错误：未注入当前用户');
    const res = await routeChat(this.currentUser.openId, messages);
    return (res && res.content) || '';
  }

  private async generateDetail(meta: string, corpus: string): Promise<string> {
    const system =
      '你是家校沟通记录整理助手。请把提供的沟通素材整理为规范的「沟通明细」Markdown 对话记录。' +
      '要求：使用 Markdown 标题/列表/引用等结构；按对话双方（如老师 / 家长）还原发言；' +
      '保留关键事实、时间、诉求与共识；不要编造素材中不存在的信息；中文输出。';
    const userMsg =
      `【记录基本信息】\n${meta}\n\n【沟通素材（附件/沟通内容）】\n${corpus}\n\n` +
      `请输出 Markdown 格式的沟通明细（对话记录）。`;
    return this.chatWithRetry(system, userMsg);
  }

  private async generateSummary(meta: string, detailMd: string): Promise<string> {
    const system =
      '你是家校沟通总结助手。请基于「沟通明细」提炼一份结构化的「沟通总结（报告）」。' +
      '要求：使用 Markdown；包含「核心结论 / 关键议题 / 家长诉求与反馈 / 后续待办 / 风险提示（如有）」等小节；' +
      '简洁、客观、可执行；不要复述全部对话；中文输出。';
    const userMsg =
      `【记录基本信息】\n${meta}\n\n【沟通明细（MD 对话记录）】\n${detailMd}\n\n` +
      `请输出 Markdown 格式的沟通总结（报告）。`;
    return this.chatWithRetry(system, userMsg);
  }

  /** 调用模型，失败重试一次（避免偶发超时导致整条失败） */
  private async chatWithRetry(system: string, userMsg: string, attempts = 2): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const out = await this.chat([
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
