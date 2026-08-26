import { Injectable, Logger, Inject } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis.provider.js';

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

  /** Redis 缓存 key 前缀：file_token → tmp_download_url */
  private static readonly URL_CACHE_PREFIX = 'file_dl_url:';
  /** 缓存有效期 20 小时（飞书临时 URL 约 24h 有效，提前刷新） */
  private static readonly URL_CACHE_TTL = 20 * 3600;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

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

    const fileToken = j.data.file_token;

    // 上传后立即获取临时下载 URL 并缓存（此时文件与 app 的关联最新，bitablePerm 可能还未生效）
    this.cacheDownloadUrl(fileToken).catch((err) => {
      this.logger.warn(`上传后缓存下载 URL 失败 ${fileToken}: ${(err as Error).message}`);
    });

    return { file_token: fileToken };
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
   * 获取 Bitable 素材的临时下载链接（用于高级权限场景）。
   * 通过 bitablePerm 声明素材归属，换取预签名 CDN URL（约 24h 有效，可直接访问）。
   *
   * @param fileToken 飞书 file_token
   * @param tableId 多维表格 ID
   * @param recordId 表中任意记录 ID（用于权限上下文）
   * @param fieldId 表中任意字段 ID（用于权限上下文）
   */
  async getTmpDownloadUrl(
    fileToken: string,
    tableId: string,
    recordId: string,
    fieldId: string,
  ): Promise<string> {
    const token = await this.getToken();
    if (!token) throw new Error('FEISHU_TOKEN_FAILED');
    const extra = JSON.stringify({
      bitablePerm: { tableId, attachments: { [fieldId]: { [recordId]: [fileToken] } } },
    });
    const qs = new URLSearchParams();
    qs.append('file_tokens', fileToken);
    qs.set('extra', extra);
    const r = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?${qs.toString()}`,
      { headers: { Authorization: 'Bearer ' + token } },
    );
    const j = (await r.json()) as {
      code?: number;
      msg?: string;
      data?: { tmp_download_urls?: Array<{ file_token: string; tmp_download_url: string }> };
    };
    if (j.code !== 0) throw new Error(`TMP_DOWNLOAD_URL_FAILED:${j.code}:${j.msg}`);
    const url = j.data?.tmp_download_urls?.[0]?.tmp_download_url;
    if (!url) throw new Error('TMP_DOWNLOAD_URL_EMPTY');
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

  /** 上传后立即缓存下载 URL（文件与 app 关联最新时调用） */
  private async cacheDownloadUrl(fileToken: string): Promise<void> {
    try {
      const url = await this.getDownloadUrl(fileToken);
      if (url) {
        await this.redis.set(
          FileUploadService.URL_CACHE_PREFIX + fileToken,
          url,
          'EX',
          FileUploadService.URL_CACHE_TTL,
        );
        this.logger.debug(`已缓存下载 URL: ${fileToken.slice(0, 12)}...`);
      }
    } catch {
      // 缓存失败不影响上传成功
    }
  }

  /**
   * 获取素材下载 URL（供图片代理使用）。
   * 优先级：Redis 缓存 > bitablePerm 预签名 > getDownloadUrl 直连
   *
   * @param fileToken 飞书 file_token
   * @param bitablePermCtx 可选的 bitablePerm 上下文（用于已关联到记录的老文件）
   */
  async resolveDownloadUrl(
    fileToken: string,
    bitablePermCtx?: { tableId: string; recordId: string; fieldId: string },
  ): Promise<string> {
    // 1. 查 Redis 缓存（上传时写入，覆盖绝大多数场景）
    const cached = await this.redis.get(FileUploadService.URL_CACHE_PREFIX + fileToken);
    if (cached) return cached;

    let url: string | undefined;

    // 2. 尝试 bitablePerm（适用于已关联到记录的老文件）
    if (bitablePermCtx?.recordId && bitablePermCtx?.fieldId) {
      try {
        url = await this.getTmpDownloadUrl(
          fileToken,
          bitablePermCtx.tableId,
          bitablePermCtx.recordId,
          bitablePermCtx.fieldId,
        );
      } catch {
        // bitablePerm 失败，继续尝试直连
      }
    }

    // 3. 兜底：getDownloadUrl（部分场景可用）
    if (!url) {
      try {
        url = await this.getDownloadUrl(fileToken);
      } catch {
        /* 最后兜底也失败，抛出 */
      }
    }

    if (!url) throw new Error('DOWNLOAD_URL_UNAVAILABLE');

    // 成功获取到 URL → 写入缓存供后续请求直接使用
    await this.redis
      .set(FileUploadService.URL_CACHE_PREFIX + fileToken, url, 'EX', FileUploadService.URL_CACHE_TTL)
      .catch(() => {});

    return url;
  }

  /**
   * 从 JSON 配置中提取所有 file_token 并预缓存下载 URL。
   * 用于启动时修复已存在但未缓存的历史文件。
   */
  async precacheConfigImages(configJson: string): Promise<{ cached: number; failed: number }> {
    // 匹配飞书 file_token 格式（22位字母数字字符串）
    const tokens = configJson.match(/[a-zA-Z0-9]{22}/g) ?? [];
    const unique = [...new Set(tokens)];
    let cached = 0;
    let failed = 0;
    for (const token of unique) {
      try {
        const existing = await this.redis.get(FileUploadService.URL_CACHE_PREFIX + token);
        if (existing) { cached++; continue; }
        const url = await this.getDownloadUrl(token);
        if (url) {
          await this.redis.set(FileUploadService.URL_CACHE_PREFIX + token, url, 'EX', FileUploadService.URL_CACHE_TTL);
          cached++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    return { cached, failed };
  }
}
