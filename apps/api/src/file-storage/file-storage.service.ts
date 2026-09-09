import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const LOC_PREFIX = 'loc_';

/**
 * 本地附件存储（云盘内化）：
 * 新上传的附件直接落服务器磁盘（ACMS_ATTACHMENT_DIR，默认 /opt/acms/data/attachments），
 * 不再写入飞书 Drive。返回的 id 带 loc_ 前缀，与飞书 file_token 共用同一字段名，
 * 因此前端业务字段结构与历史 Drive 记录均无需改动。
 * 历史 Drive 素材已于 2026-09-09 全量迁移为本地文件（全库零非 loc_ 残留），
 * 飞书兼容回退已移除：非 loc_ 前缀一律视为迁移前的失效标记。
 */
@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly dir: string;

  constructor() {
    this.dir = process.env.ACMS_ATTACHMENT_DIR?.trim() || '/opt/acms/data/attachments';
  }

  static isLocal(token: string): boolean {
    return typeof token === 'string' && token.startsWith(LOC_PREFIX);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** 保存文件，返回 loc_ 前缀 id */
  async save(buffer: Buffer, filename: string, mime: string): Promise<string> {
    await this.ensureDir();
    // id = 内容sha1前缀 + 毫秒时间戳 + 随机分量（避免同内容同一毫秒并发上传撞 id 覆盖）
    const id =
      LOC_PREFIX +
      createHash('sha1').update(buffer).digest('hex').slice(0, 24) +
      Date.now().toString(36) +
      randomBytes(4).toString('hex');
    const safeName = (filename || 'file').replace(/[^\w.\-一-鿿]/g, '_');
    const meta = { filename: safeName, mime: mime || 'application/octet-stream', size: buffer.length };
    await fs.writeFile(join(this.dir, id + '.bin'), buffer);
    await fs.writeFile(join(this.dir, id + '.json'), JSON.stringify(meta));
    return id;
  }

  async read(id: string): Promise<{ buffer: Buffer; filename: string; mime: string } | null> {
    if (!FileStorageService.isLocal(id)) return null;
    try {
      const buffer = await fs.readFile(join(this.dir, id + '.bin'));
      const meta = JSON.parse(await fs.readFile(join(this.dir, id + '.json'), 'utf8')) as {
        filename: string;
        mime: string;
      };
      return { buffer, filename: meta.filename, mime: meta.mime };
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    if (!FileStorageService.isLocal(id)) return;
    await fs.rm(join(this.dir, id + '.bin'), { force: true }).catch(() => {});
    await fs.rm(join(this.dir, id + '.json'), { force: true }).catch(() => {});
  }
}
