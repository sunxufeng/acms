// @ts-nocheck
import { Injectable, Logger, ForbiddenException, NotFoundException, Inject } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize } from '@acms/domain';
import { BaseClient, toText } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { TABLES } from '@acms/contracts';
import { routeChat } from '../ai/lib/gateway/router.js';

/** 家校沟通「AI 总结」：附件内容抽取 → 生成 MD 沟通明细 + 沟通总结，回写飞书表 */
@Injectable()
export class HomeSchoolCommsService {
  private readonly logger = new Logger('HomeSchoolComms');
  /** 调用时由 aiSummarize 注入的当前用户（routeChat 需 openId 选模型） */
  private currentUser: SessionUser | null = null;

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly fileUpload: FileUploadService,
  ) {}

  private toPrincipal(user: SessionUser) {
    return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
  }

  /** 解析附件字段值（表单态数组 或 飞书存储态 JSON 字符串） */
  private parseAttachments(v: unknown): { file_token: string; name: string }[] {
    let arr: unknown = v;
    if (typeof v === 'string' && v.trim()) {
      try {
        arr = JSON.parse(v);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(arr)) return [];
    return arr
      .map((it) => (typeof it === 'string' ? { file_token: '', name: it } : it) as { file_token?: string; name?: string })
      .filter((it) => it && it.file_token)
      .map((it) => ({ file_token: it.file_token as string, name: it.name || it.file_token as string }));
  }

  /** 从下载的文件中抽取纯文本：文本类直接解码；疑似二进制（含 NUL 或不可读比例过高）则给出说明 */
  private extractText(buf: Buffer, name: string): string {
    const lower = (name || '').toLowerCase();
    const textExts = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml'];
    if (!textExts.some((x) => lower.endsWith(x))) {
      // 非文本类（docx/pdf 等）当前无解析库，跳过但给出提示
      return `（附件「${name}」为二进制格式，暂不支持自动解析，请在「沟通内容」中补充要点）`;
    }
    // 探测 NUL 字节：文本文件不应包含
    if (buf.includes(0)) {
      return `（附件「${name}」疑似二进制，跳过自动解析）`;
    }
    try {
      return buf.toString('utf-8');
    } catch {
      return '';
    }
  }

  async aiSummarize(user: SessionUser, id: string) {
    if (!authorize(this.toPrincipal(user), 'student:write').allowed) {
      throw new ForbiddenException('FORBIDDEN:student:write');
    }
    this.currentUser = user;
    const tableId = TABLES.homeSchoolComm.tableId;
    const rec = await this.base.get(tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');

    const f = rec.fields;
    const attachments = this.parseAttachments(f['沟通附件清单']);

    // 1) 抽取附件文本
    let corpus = '';
    let okCount = 0;
    for (const a of attachments) {
      try {
        const resp = await this.fileUpload.downloadFile(a.file_token);
        if (!resp.ok) {
          this.logger.warn(`附件下载失败 ${a.name} HTTP ${resp.status}`);
          continue;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        const text = this.extractText(buf, a.name);
        if (text) {
          corpus += `\n\n--- 附件来源：${a.name} ---\n${text}`;
          okCount++;
        }
      } catch (e) {
        this.logger.warn(`附件解析失败 ${a.name}: ${(e as Error).message}`);
      }
    }

    // 2) 无附件时，回退到「沟通内容」字段文本
    if (!corpus.trim()) {
      const content = toText(f['沟通内容']);
      if (content) corpus = `\n\n--- 沟通内容 ---\n${content}`;
    }

    // 3) 组装记录元信息（供模型理解上下文）
    const meta = [
      `关联学生：${toText(f['关联学生']) || '—'}`,
      `家长：${toText(f['家长']) || '—'}`,
      `沟通人：${toText(f['沟通人']) || '—'}`,
      `沟通方式：${toText(f['沟通方式']) || '—'}`,
      `沟通主题：${toText(f['沟通主题']) || '—'}`,
      `沟通时间：${toText(f['沟通时间']) || '—'}`,
    ].join('\n');

    if (!corpus.trim()) {
      throw new NotFoundException('NO_SOURCE:该记录既没有附件，也没有「沟通内容」文本，无法生成总结');
    }

    // 4) 生成 MD 沟通明细（对话记录）
    const detailMd = await this.generateDetail(meta, corpus);
    // 5) 基于明细生成沟通总结（报告）
    const summary = await this.generateSummary(meta, detailMd);

    // 6) 回写飞书表
    await this.base.update(tableId, id, {
      沟通明细: detailMd,
      沟通总结: summary,
    });

    return {
      ok: true,
      沟通明细: detailMd,
      沟通总结: summary,
      parsedAttachments: okCount,
      totalAttachments: attachments.length,
    };
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
