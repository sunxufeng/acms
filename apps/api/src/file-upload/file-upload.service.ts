import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';

/**
 * 还原被 multer/busboy 误判为 latin1 的中文文件名。
 *
 * multer 默认把 multipart 的 filename 参数按 latin1 解码，导致中文变乱码
 * （如 心居.md → å¿ƒå±¿.md，即 UTF-8 字节被当 latin1 字符读回）。
 * 这里把同样的字符按 latin1 取回原始字节，再用 UTF-8 重新解码还原。
 * 若原串本身已含合法中文（说明未来 busboy 已修正解码，无需还原），则跳过，
 * 避免二次转码。
 */
export function decodeOriginalFilename(name: string): string {
  if (!name) return name;
  try {
    const recovered = Buffer.from(name, 'latin1').toString('utf8');
    if (recovered !== name && /[一-鿿]/.test(recovered)) return recovered;
  } catch {
    /* 解码失败则保持原样 */
  }
  return name;
}

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

  /**
   * 用后端 token 请求飞书下载接口，返回原始 Response 供 Controller 透传。
   * fetch 默认 follow redirect，因此会追到底层 CDN 文件流。
   *
   * 注意：当多维表格开启了「高级权限」时，drive 素材下载必须携带额外的 extra
   * 鉴权参数，否则返回 400/403。仅用 file_token 直连 download 接口在此场景下会失败，
   * 应使用 {@link getBitableTmpDownloadUrl} 先换取带鉴权的临时下载链接。
   */
  async downloadFile(file_token: string): Promise<Response> {
    const token = await this.getToken();
    if (!token) throw new Error('FEISHU_TOKEN_FAILED');
    return fetch(`https://open.feishu.cn/open-apis/drive/v1/medias/${file_token}/download`, {
      headers: { Authorization: 'Bearer ' + token },
    });
  }

  /**
   * 获取带「高级权限」鉴权的临时下载链接（有效期约 24h，可直接访问、无需 token）。
   *
   * 多维表格开启高级权限后，素材下载需要在 extra 里声明归属：
   *   { "bitablePerm": { "tableId": <表ID>, "attachments": { <字段ID>: { <记录ID>: [file_token...] } } } }
   * 缺少该参数时 batch_get_tmp_download_url 会返回空数组（等效下载失败）。
   *
   * @param tableId  多维表格的表 ID（如 tbl8Isr46G3BRQ52）
   * @param recordId 记录 ID（如 recvsKfEY4LU0v）
   * @param fieldId  附件所在字段 ID（如 fld18MYZ2u；用于归属鉴权，可与实际附件字段不同）
   * @param fileToken 素材 file_token
   */
  async getBitableTmpDownloadUrl(
    tableId: string,
    recordId: string,
    fieldId: string,
    fileToken: string,
  ): Promise<string> {
    const token = await this.getToken();
    if (!token) throw new Error('FEISHU_TOKEN_FAILED');
    const extra = {
      bitablePerm: {
        tableId,
        attachments: { [fieldId]: { [recordId]: [fileToken] } },
      },
    };
    const qs = new URLSearchParams();
    qs.append('file_tokens', fileToken);
    qs.set('extra', JSON.stringify(extra));
    const r = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?${qs.toString()}`,
      { headers: { Authorization: 'Bearer ' + token } },
    );
    const j = (await r.json()) as {
      code?: number;
      msg?: string;
      data?: { tmp_download_urls?: Array<{ file_token: string; tmp_download_url: string }> };
    };
    if (j.code !== 0) throw new Error(`TMP_URL_FAILED:${j.code}:${j.msg}`);
    const url = j.data?.tmp_download_urls?.[0]?.tmp_download_url;
    if (!url) throw new Error('TMP_URL_EMPTY');
    return url;
  }

  /**
   * 批量获取临时下载链接（浏览器可直接访问，无需 token，约 4 小时有效）。
   * @param fileTokens 文件 token 列表
   * @param extra 飞书要求的 bitablePerm 参数（从附件对象 url 字段的 query 中提取）
   */
  async getBatchTmpDownloadUrls(fileTokens: string[], extra: string): Promise<Record<string, string>> {
    if (fileTokens.length === 0) return {};
    const token = await this.getToken();
    if (!token) throw new Error('FEISHU_TOKEN_FAILED');

    const qs = new URLSearchParams();
    for (const t of fileTokens) qs.append('file_tokens', t);
    qs.set('extra', extra);

    const r = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?${qs.toString()}`,
      { headers: { Authorization: 'Bearer ' + token } },
    );
    const text = await r.text();
    let j: { code?: number; msg?: string; data?: { tmp_download_urls?: Array<{ file_token: string; tmp_download_url: string }> } };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      throw new Error(`BATCH_TMP_URL_BAD_RESPONSE:${r.status}:${text.slice(0, 100)}`);
    }
    if (j.code !== 0) throw new Error(`BATCH_TMP_URL_FAILED:${j.code}:${j.msg}`);
    const map: Record<string, string> = {};
    for (const it of j.data?.tmp_download_urls ?? []) map[it.file_token] = it.tmp_download_url;
    return map;
  }
}
