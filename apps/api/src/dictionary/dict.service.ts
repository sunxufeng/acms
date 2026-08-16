import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import {
  DICTIONARIES,
  BASE_FIELD_SYNC,
  SINGLE_SELECT,
  MULTI_SELECT,
} from './dict.data.js';

export interface SyncResult {
  table: string;
  synced: string[];
  skipped: string[];
  errors: string[];
}

/** 字典持久化文件：编辑后写入，重启不丢（覆盖 dict.data.ts 种子） */
const DATA_DIR = process.env.ACMS_DATA_DIR ?? '/opt/acms/data';
const STORE_FILE = path.join(DATA_DIR, 'dictionaries.json');

@Injectable()
export class DictService {
  private readonly logger = new Logger(DictService.name);
  private readonly TABLE = TABLES.studentProfile.tableId;
  /** 运行时可变字典（种子 + 持久化文件合并），编辑后写入文件 */
  private store: Record<string, string[]>;

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {
    this.store = { ...DICTIONARIES };
    this.loadStore();
  }

  /** 启动时若存在持久化文件，则用其覆盖同名 key（保留种子中新增的 key） */
  private loadStore(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as Record<string, string[]>;
        this.store = { ...DICTIONARIES, ...saved };
      }
    } catch (e) {
      this.logger.warn(`字典加载失败，使用种子：${(e as Error).message}`);
    }
  }

  private persistStore(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch (e) {
      this.logger.warn(`字典持久化失败：${(e as Error).message}`);
    }
  }

  /** 全部字典 */
  getAll(): Record<string, string[]> {
    return this.store;
  }

  /** 单个字典 */
  get(key: string): string[] | undefined {
    return this.store[key];
  }

  /** 更新单个字典候选项：去重 + 去空白，写回内存并持久化 */
  update(key: string, options: string[]): { key: string; options: string[] } {
    const cleaned = Array.from(
      new Set((options ?? []).map((o) => (o ?? '').trim()).filter((o) => o.length > 0)),
    );
    this.store[key] = cleaned;
    this.persistStore();
    this.logger.log(`字典更新：${key}（${cleaned.length} 项）`);
    return { key, options: cleaned };
  }

  /**
   * 将字典候选项合并进飞书 Base 对应单选/多选字段（幂等）。
   * - 仅处理 type=3（单选）/ type=4（多选）字段；文本等其他类型跳过。
   * - 当前选项取自 listFields 的 property.options（飞书无单字段 GET 接口），
   *   已存在的选项保留（含其 id），仅追加缺失项，不删除任何选项。
   * - 单字段失败不影响其余字段；结果汇总返回，便于接口/日志查看。
   */
  async syncToBase(): Promise<SyncResult> {
    const result: SyncResult = { table: this.TABLE, synced: [], skipped: [], errors: [] };
    let fields: { id: string; name: string; type: number; property: { options?: { name: string; id?: string }[] } }[];
    try {
      fields = await this.base.listFields(this.TABLE);
    } catch (e) {
      result.errors.push(`listFields failed: ${(e as Error).message}`);
      return result;
    }
    const fieldByName = new Map(fields.map((f) => [f.name, f]));

    for (const { field, dictKey } of BASE_FIELD_SYNC) {
      const options = this.store[dictKey];
      if (!options?.length) continue;
      const def = fieldByName.get(field);
      if (!def) {
        result.skipped.push(`${field}（Base 无此字段）`);
        continue;
      }
      if (def.type !== SINGLE_SELECT && def.type !== MULTI_SELECT) {
        result.skipped.push(`${field}（非单选/多选，type=${def.type}，跳过）`);
        continue;
      }
      try {
        const existing = (def.property.options ?? []).map((o) => o.name);
        const toAdd = options.filter((o) => !existing.includes(o));
        if (toAdd.length === 0) {
          result.synced.push(`${field}（已是最新）`);
          continue;
        }
        const merged = [
          ...(def.property.options ?? []).map((o) => ({ name: o.name })),
          ...toAdd.map((name) => ({ name })),
        ];
        await this.base.updateField(this.TABLE, def.id, {
          field_name: def.name,
          type: def.type,
          property: { options: merged },
        });
        result.synced.push(`${field}（+${toAdd.length}）`);
        this.logger.log(`字典同步：${field} 追加 ${toAdd.length} 个选项`);
      } catch (e) {
        result.errors.push(`${field}: ${(e as Error).message}`);
        this.logger.warn(`字典同步失败 ${field}: ${(e as Error).message}`);
      }
    }
    return result;
  }
}
