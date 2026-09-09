import { Injectable, NotFoundException } from '@nestjs/common';
import { FileStorageService } from '../file-storage/file-storage.service.js';

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
 * 附件服务（云盘内化完成态）。
 *
 * 历史：附件曾写入飞书 Drive，下载需 tenant_access_token，且多维表格开启高级权限后
 *      还要用 bitablePerm 声明素材归属换取预签名链接，否则返回 400。
 * 现状：2026-09-09 存量素材（1838 个 token，覆盖 79 张表 494 行）已全量迁移到本地磁盘，
 *      全库已无非 loc_ 前缀 token；新附件直接落本地。飞书上传与临时链接实现已整体移除。
 * 约定：业务字段仍叫 file_token，loc_ 前缀 = 本地文件；非 loc_ 一律视为迁移前遗留的失效标记。
 */
@Injectable()
export class FileUploadService {
  constructor(private readonly storage: FileStorageService) {}

  /**
   * 上传附件：直接落本地磁盘，返回带 loc_ 前缀的 file_token。
   * @param timeoutMs 仅为兼容旧调用方签名保留；本地写盘无网络请求，忽略该参数。
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
    mimeType: string,
    timeoutMs?: number,
  ): Promise<{ file_token: string }> {
    void timeoutMs;
    const id = await this.storage.save(buffer, filename, mimeType);
    return { file_token: id };
  }

  /** 本站代理直链：浏览器 <img>/<a> 可直接访问，无需 Authorization */
  static viewUrl(token: string): string {
    return `/api/v1/files/${encodeURIComponent(token)}`;
  }

  /**
   * 解析附件的可访问 URL（供「换下载链接」类接口使用）。
   * 非 loc_ 前缀说明是迁移前遗留的失效标记，直接 404，不再尝试飞书。
   */
  async resolveViewUrl(token: string): Promise<string> {
    if (!FileStorageService.isLocal(token)) {
      throw new NotFoundException('LEGACY_FILE_TOKEN:迁移前遗留的素材标记，已失效');
    }
    return FileUploadService.viewUrl(token);
  }

  /** 服务端读取附件内容（AI 总结等需要拿到字节流的场景） */
  async readLocal(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string; mime: string }> {
    const f = await this.storage.read(token);
    if (!f) throw new NotFoundException('FILE_NOT_FOUND');
    return f;
  }
}
