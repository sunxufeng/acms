import { Injectable } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { DictService } from '../dictionary/dict.service.js';
import { applyFieldMask, rankOf, stripProtectedFields, type FieldLevel } from './field-mask.js';

/**
 * 字段密级脱敏服务（Stage 4b）。注入 DictService 读取字段密级表（运营可在字典页调整），
 * 对任意模块的 list/detail/导出 记录做展示脱敏，对 create/update 做防误写剔除。
 * 以 @Global() 模块注册，全站 service 可直接注入。
 */
@Injectable()
export class FieldMaskService {
  constructor(private readonly dict: DictService) {}

  /** 脱敏一条记录（module 为 null 或无可控字段时原样返回） */
  mask(user: SessionUser, module: string | null, record: Record<string, unknown>): Record<string, unknown> {
    return applyFieldMask(this.dict.getFieldLevels(), module, rankOf(user.maxDataLevel), record);
  }

  /** 批量脱敏 */
  maskMany(user: SessionUser, module: string | null, records: Record<string, unknown>[]): Record<string, unknown>[] {
    return records.map((r) => this.mask(user, module, r));
  }

  /** 创建/更新防误写：剔除密级不足且受控字段 */
  stripProtected(user: SessionUser, module: string | null, dto: Record<string, unknown>): Record<string, unknown> {
    return stripProtectedFields(this.dict.getFieldLevels(), module, rankOf(user.maxDataLevel), dto);
  }
}
