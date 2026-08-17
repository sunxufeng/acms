import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';

/**
 * 飞书文件上传服务：
 *  - 获取 tenant_access_token（复用 monitor 同款缓存逻辑）
 *  - 上传文件到飞书 Drive（upload_all 接口）
 *  - 返回 file_token 供写入 Bitable 附件字段
 */
@Injectable()
export class FileUploadService {
  private readonly logger = new Logger('FileUpload');
  private envCache: Record<string, string> | null = null;
  private tenantToken?: string;
  private tokenExp = 0;

  /** 读取环境变量 */
  private env(key: string): string | undefined {
    if (process.env[key] !== undefined) return process.env[key];
    if (!this.envCache) {
      this.envCache = {};
      try {
        for (const line of readFileSync('/opt/acms/.env', 'utf8').split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) this.envCache[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
      } catch {
        /* ignore */
      }
    }
    return this.envCache[key];
  }

  /** 取 tenant_access_token（带缓存，提前 60s 过期刷新） */
  private async getToken(): Promise<string | null> {
    const now = Date.now();
    if (this.tenantToken && now < this.tokenExp) return this.tenantToken;
    const id = this.env('FEISHU_APP_ID');
    const secret = this.env('FEISHU_APP_SECRET');
    if (!id || !secret) return null;
    try {
      const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: id, app_secret: secret }),
      });
      const j = (await r.json()) as { code?: number; tenant_access_token?: string; expire?: number };
      if (j.code !== 0 || !j.tenant_access_token) return null;
      this.tenantToken = j.tenant_access_token;
      this.tokenExp = now + (j.expire ?? 7200) * 1000 - 60_000;
      return this.tenantToken;
    } catch {
      return null;
    }
  }

  /**
   * 上传文件到飞书 Drive
   * @param buffer 文件内容
   * @param filename 原始文件名
   * @param mimeType MIME 类型
   * @returns file_token
   */
  async uploadFile(buffer: Buffer, filename: string, mimeType: string): Promise<{ file_token: string }> {
    const token = await this.getToken();
    if (!token) throw new Error('FEISHU_TOKEN_FAILED');

    // 使用 upload_all 上传（Node 原生 FormData，undici 自动编码 multipart）
    // 必填：file_name / parent_type=bitable_file / parent_node=多维表格 token / size / file
    const parentNode = this.env('FEISHU_BASE_TOKEN') ?? '';
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    form.append('file', blob, filename);
    form.append('file_name', filename);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', parentNode);
    form.append('size', String(buffer.length));

    const r = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
      } as Record<string, string>,
      body: form as unknown as Blob,
    });

    // 防御：飞书可能返回非 JSON 错误（如网关错误文本），先检查 HTTP 状态
    const text = await r.text();
    let j: { code?: number; msg?: string; data?: { file_token: string } };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      this.logger.error(`上传响应非 JSON [HTTP ${r.status}]: ${text.slice(0, 200)}`);
      throw new Error(`UPLOAD_BAD_RESPONSE:${r.status}`);
    }
    if (j.code !== 0 || !j.data?.file_token) {
      this.logger.error(`上传失败 code=${j.code} msg=${j.msg}`);
      throw new Error(`UPLOAD_FAILED:${j.code ?? 'UNKNOWN'}:${j.msg ?? text.slice(0, 100)}`);
    }

    return { file_token: j.data.file_token };
  }

  /**
   * 获取附件下载 URL（有效期约 4 小时）
   * @param file_token 飞书文件 token
   */
  async getDownloadUrl(file_token: string): Promise<string> {
    const token = await this.getToken();
    if (!token) throw new Error('FEISHU_TOKEN_FAILED');

    const r = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/${file_token}/download_url`,
      {
        headers: { Authorization: 'Bearer ' + token },
      },
    );
    const j = (await r.json()) as { code?: number; data?: { url: string } };
    if (j.code !== 0 || !j.data?.url) throw new Error(`DOWNLOAD_URL_FAILED:${j.code}`);
    return j.data.url;
  }
}
