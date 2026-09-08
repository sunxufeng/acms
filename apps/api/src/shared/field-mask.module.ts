import { Global, Module } from '@nestjs/common';
import { DictModule } from '../dictionary/dict.module.js';
import { FieldMaskService } from './field-mask.service.js';

/** 字段密级脱敏服务全局模块：注入 DictService，导出 FieldMaskService，全站可直接注入。 */
@Global()
@Module({ imports: [DictModule], providers: [FieldMaskService], exports: [FieldMaskService] })
export class FieldMaskModule {}
