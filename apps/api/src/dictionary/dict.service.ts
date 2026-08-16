import { Inject, Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class DictService {
  private readonly logger = new Logger(DictService.name);
  private readonly TABLE = TABLES.studentProfile.tableId;

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /** 全部字典 */
  getAll(): Record<string, string[]> {
    return DICTIONARIES;
  }

  /** 单个字典 */
  get(key: string): string[] | undefined {
    return DICTIONARIES[key];
  }

  /**
   * 将字典候选项合并进飞书 Base 对应单选/多选字段（幂等）。
   * - 仅处理 type=1（单选）/ type=3（多选）字段；文本字段跳过。
   * - 已存在的选项保留（含其 id），仅追加缺失项，不删除任何选项。
   * - 单字段失败不影响其余字段；结果汇总返回，便于接口/日志查看。
   */
  async syncToBase(): Promise<SyncResult> {
    const result: SyncResult = { table: this.TABLE, synced: [], skipped: [], errors: [] };
    let fields: { id: string; name: string; type: number }[];
    try {
      fields = await this.base.listFields(this.TABLE);
    } catch (e) {
      result.errors.push(`listFields failed: ${(e as Error).message}`);
      return result;
    }
    const fieldByName = new Map(fields.map((f) => [f.name, f]));

    for (const { field, dictKey } of BASE_FIELD_SYNC) {
      const options = DICTIONARIES[dictKey];
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
        const full = await this.base.getField(this.TABLE, def.id);
        const existing = (full.property.options ?? []).map((o) => o.name);
        const toAdd = options.filter((o) => !existing.includes(o));
        if (toAdd.length === 0) {
          result.synced.push(`${field}（已是最新）`);
          continue;
        }
        const merged = [
          ...(full.property.options ?? []).map((o) => ({ name: o.name })),
          ...toAdd.map((name) => ({ name })),
        ];
        await this.base.updateField(this.TABLE, def.id, {
          field_name: full.name,
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
