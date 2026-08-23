import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { BaseClient } from '@acms/base-adapter';
import { TABLES, USER_TABLE } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import {
  DICTIONARIES,
  BASE_FIELD_SYNC,
  SINGLE_SELECT,
  MULTI_SELECT,
  PROVINCE_CITIES,
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

  /** 省 → 市 级联映射（前端级联下拉用） */
  getProvinceCities(): Record<string, string[]> {
    return PROVINCE_CITIES;
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
  async syncToBase(): Promise<SyncResult[]> {
    const results = await Promise.all([
      this.syncTable(this.TABLE, BASE_FIELD_SYNC),
      this.syncTable(USER_TABLE.tableId, this.USER_FIELD_SYNC),
    ]);
    // 确保学生表新增的「文本类」字段存在（Arete毕业届 / 证件信息），否则写入会被飞书静默丢弃
    results.push(await this.ensureStudentTextFields());
    // 确保用户表「教师类型」单选字段存在（新建用户时下拉选择），否则写入会被飞书静默丢弃
    results.push(await this.ensureUserTeacherTypeField());
    // 将人员类字段（招生负责老师/班主任/数据负责人）从飞书 User 类型(11) 转为 Text 类型(1)。
    // 原因：该租户下这些 open_id 无法通过飞书 User 字段校验（UserFieldConvFail），
    // 且应用侧已自行用 open_id↔姓名 映射展示，Text 存储 open_id 即可稳定读写。
    results.push(await this.ensureUserFieldsAsText());
    // 学生档案：新建单/多选字段（省/市/入学年份/实际学制）、重命名 当前年级→入学年级、
    // 将 学生标签 文本列转为多选标签列、新建 特长标签 多选列。
    results.push(await this.ensureStudentSelectFields());
    // 生源跟进记录表：确保字典下拉字段存在且选项与字典一致（含新增的 原学校类型/合同状态/付款状态/家庭关键决策点/原学校/奖学金金额）
    results.push(await this.ensureFollowupFields());
    // 教师档案表：确保「教师类别/授课学段/授课科目类型/授课科目/合作开始时间/收款主体」等
    // 字典下拉字段存在且选项与字典一致；并补齐文本类字段（微信号/常驻城市/个人描述/附件等）。
    results.push(await this.ensureTeacherFields());
    // 家校沟通表：确保「沟通方式/家长反馈态度/闭环状态/信息敏感级别」单选字段与字典一致；
    // 补齐文本字段（关联学生/家长/沟通人/沟通主题/沟通明细/沟通总结/沟通附件清单）。
    results.push(await this.ensureHomeSchoolCommFields());
    // 日常跟进表：确保「沟通方式/闭环状态/信息敏感级别」单选字段与字典一致；
    // 补齐文本字段（关联学生/沟通人/沟通人备注/沟通明细/沟通总结/沟通附件清单/待办事项/责任人/待办负责人）。
    results.push(await this.ensureDailyFollowupFields());
    return results;
  }

  /**
   * 确保「生源跟进记录表」的字段存在且选项与字典一致：
   * - 单选字段（活动类型/跟进状态/跟进方式/意向等级/闭环状态/原学校类型/合同状态/付款状态/家庭关键决策点/家长反馈态度）：
   *   不存在则创建（type=3，带字典选项）；已存在单选则追加缺失选项；已存在非单选则跳过（不删字段，避免丢数据）。
   * - 文本字段（原学校/奖学金金额/关联学生/家长/沟通主题/沟通明细/沟通总结/沟通附件清单）：不存在则创建文本字段(type=1)。
   * - 跟进日期 → 跟进时间：重命名并启用「显示时间」(HH:mm)，与家校沟通一致。
   */
  private async ensureFollowupFields(): Promise<SyncResult> {
    const tableId = TABLES.sourceFollowup.tableId;
    const result: SyncResult = { table: tableId, synced: [], skipped: [], errors: [] };
    try {
      const fields = await this.base.listFields(tableId);
      const byName = new Map(fields.map((f) => [f.name, f]));

      const singles: { name: string; dictKey: string }[] = [
        { name: '活动类型', dictKey: '活动类型' },
        { name: '跟进状态', dictKey: '跟进状态' },
        { name: '跟进方式', dictKey: '跟进方式' },
        { name: '意向等级', dictKey: '意向等级' },
        { name: '闭环状态', dictKey: '闭环状态' },
        { name: '原学校类型', dictKey: '原学校类型' },
        { name: '合同状态', dictKey: '合同状态' },
        { name: '付款状态', dictKey: '付款状态' },
        { name: '家庭关键决策点', dictKey: '家庭关键决策点' },
        { name: '家长反馈态度', dictKey: '家长反馈态度' },
      ];
      for (const { name, dictKey } of singles) {
        const options = (this.store[dictKey] ?? []).map((o) => ({ name: o }));
        const def = byName.get(name);
        if (!def) {
          await this.base.createField(tableId, { field_name: name, type: SINGLE_SELECT, property: { options } });
          result.synced.push(`${name}（已创建单选）`);
          continue;
        }
        if (def.type !== SINGLE_SELECT) {
          result.skipped.push(`${name}（已存在但非单选 type=${def.type}，跳过以免丢数据）`);
          continue;
        }
        const existing = new Set((def.property.options ?? []).map((o) => o.name));
        const toAdd = options.filter((o) => !existing.has(o.name));
        if (toAdd.length) {
          const merged = [
            ...(def.property.options ?? []).map((o) => ({ name: o.name })),
            ...toAdd,
          ];
          await this.base.updateField(tableId, def.id, {
            field_name: def.name,
            type: SINGLE_SELECT,
            property: { options: merged },
          });
          result.synced.push(`${name}（+${toAdd.length}）`);
        } else {
          result.skipped.push(`${name}（已是最新）`);
        }
      }

      // 文本字段（自由输入）
      for (const name of ['原学校', '奖学金金额', '关联学生', '家长', '沟通主题', '沟通明细', '沟通总结', '沟通附件清单']) {
        if (!byName.has(name)) {
          await this.base.createField(tableId, { field_name: name, type: 1 });
          result.synced.push(`${name}（已创建文本）`);
        } else {
          result.skipped.push(`${name}（已存在）`);
        }
      }

      // 跟进日期 → 跟进时间（启用时分）
      const oldDate = byName.get('跟进日期');
      const newTime = byName.get('跟进时间');
      if (newTime && newTime.type === 5) {
        const fmt = (newTime.property && newTime.property.date_formatter) || '';
        if (!/H{1,2}/.test(fmt)) {
          await this.base.updateField(tableId, newTime.id, {
            field_name: '跟进时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' },
          });
          result.synced.push('跟进时间 已启用时分 (HH:mm)');
        } else {
          result.skipped.push('跟进时间 已带时分，跳过');
        }
      } else if (oldDate && oldDate.type === 5) {
        await this.base.updateField(tableId, oldDate.id, {
          field_name: '跟进时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' },
        });
        result.synced.push('跟进日期 → 跟进时间（已重命名并启用时分）');
      } else if (!newTime) {
        await this.base.createField(tableId, { field_name: '跟进时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' } });
        result.synced.push('跟进时间（已新建日期时间字段）');
      }
    } catch (e) {
      result.errors.push(`ensureFollowupFields: ${(e as Error).message}`);
    }
    return result;
  }

  /**
   * 幂等确保教师档案表的字典下拉字段与文本字段存在且选项与字典一致：
   * - 教师类别（单选，已存在）：用字典「全职/兼职」整体替换原选项（覆盖旧的 专职教师 等）。
   * - 授课学段 / 授课科目类型 / 合作开始时间 / 收款主体（单选，带字典选项）：不存在则创建。
   * - 授课科目（多选，带字典选项）：不存在则创建。
   * - 文本/多行字段（微信号/常驻城市/开课人数说明/个人描述/附件/教师合作等级/教学评估）：不存在则创建。
   */
  private async ensureTeacherFields(): Promise<SyncResult> {
    const tableId = TABLES.teacherProfile.tableId;
    const result: SyncResult = { table: tableId, synced: [], skipped: [], errors: [] };
    const opt = (key: string) => (this.store[key] ?? []).map((name) => ({ name }));
    try {
      const fields = await this.base.listFields(tableId);
      const byName = new Map(fields.map((f) => [f.name, f]));

      // 1) 教师类别：整体替换为 全职/兼职
      const catDef = byName.get('教师类别');
      if (!catDef) {
        await this.base.createField(tableId, {
          field_name: '教师类别', type: SINGLE_SELECT, property: { options: opt('教师类别') },
        });
        result.synced.push('教师类别（已创建单选）');
      } else if (catDef.type === SINGLE_SELECT) {
        await this.base.updateField(tableId, catDef.id, {
          field_name: '教师类别', type: SINGLE_SELECT, property: { options: opt('教师类别') },
        });
        result.synced.push('教师类别（选项更新为 全职/兼职）');
      } else {
        result.skipped.push(`教师类别（已存在但非单选 type=${catDef.type}，跳过）`);
      }

      // 2) 主要学科：单选（下拉）。原为多选字段，改为单选下拉需重建字段类型。
      const majorDef = byName.get('主要学科');
      if (!majorDef) {
        await this.base.createField(tableId, {
          field_name: '主要学科', type: SINGLE_SELECT, property: { options: opt('主要学科') },
        });
        result.synced.push('主要学科（已创建单选）');
      } else if (majorDef.type !== SINGLE_SELECT) {
        // 多选/文本等非单选 → 删除重建为单选（字段数据会丢失，符合「改为单选下拉」需求）
        await this.base.deleteField(tableId, majorDef.id);
        await this.base.createField(tableId, {
          field_name: '主要学科', type: SINGLE_SELECT, property: { options: opt('主要学科') },
        });
        result.synced.push('主要学科（多选→单选重建）');
      } else {
        const existing = new Set((majorDef.property.options ?? []).map((o) => o.name));
        const toAdd = opt('主要学科').filter((o) => !existing.has(o.name));
        if (toAdd.length) {
          await this.base.updateField(tableId, majorDef.id, {
            field_name: '主要学科', type: SINGLE_SELECT,
            property: { options: [...(majorDef.property.options ?? []).map((o) => ({ name: o.name })), ...toAdd] },
          });
          result.synced.push(`主要学科（+${toAdd.length}）`);
        } else {
          result.skipped.push('主要学科（已是最新）');
        }
      }

      // 2.5) 新增单选字段（带字典选项）
      const singles: { name: string; dictKey: string }[] = [
        { name: '授课学段', dictKey: '授课学段' },
        { name: '授课科目类型', dictKey: '授课科目类型' },
        { name: '合作开始时间', dictKey: '合作开始时间' },
        { name: '收款主体', dictKey: '收款主体' },
        { name: '性别', dictKey: '性别' },
        { name: '学历/学位', dictKey: '学历/学位' },
      ];
      for (const { name, dictKey } of singles) {
        if (byName.has(name)) { result.skipped.push(`${name}（已存在）`); continue; }
        await this.base.createField(tableId, {
          field_name: name, type: SINGLE_SELECT, property: { options: opt(dictKey) },
        });
        result.synced.push(`${name}（已创建单选）`);
      }

      // 3) 授课科目：多选
      if (!byName.has('授课科目')) {
        await this.base.createField(tableId, {
          field_name: '授课科目', type: MULTI_SELECT, property: { options: opt('授课科目') },
        });
        result.synced.push('授课科目（已创建多选）');
      } else {
        result.skipped.push('授课科目（已存在）');
      }

      // 3.5) 数字字段（飞书 type 2；课时/课酬类）
      const numbers: string[] = [
        '标准课时(每周)',
        '学期预计总课时',
        '每学期预计课酬总额',
        '实际课酬总额',
      ];
      for (const name of numbers) {
        if (byName.has(name)) { result.skipped.push(`${name}（已存在）`); continue; }
        await this.base.createField(tableId, { field_name: name, type: 2 });
        result.synced.push(`${name}（已创建数字）`);
      }

      // 4) 文本字段（飞书 type 1 即文本，可存多行内容；type 2 是数字，切勿误用）
      const texts: { name: string; type: number }[] = [
        { name: '微信号', type: 1 },
        { name: '常驻城市', type: 1 },
        { name: '开课人数说明', type: 1 },
        { name: '个人描述', type: 1 },
        { name: '附件', type: 1 },
        { name: '教师合作等级', type: 1 },
        { name: '教学评估', type: 1 },
        // ── 教师档案新增文本字段（含原先仅在后端 DTO、未暴露到表单的字段） ──
        { name: '外聘归属类型', type: 1 },
        { name: '毕业大学', type: 1 },
        { name: '内部对接人', type: 1 },
        { name: '入职或首次合作日期', type: 1 },
        { name: '离职或终止日期', type: 1 },
        { name: '备注', type: 1 },
      ];
      for (const { name, type } of texts) {
        if (byName.has(name)) { result.skipped.push(`${name}（已存在）`); continue; }
        await this.base.createField(tableId, { field_name: name, type });
        result.synced.push(`${name}（已创建）`);
      }
    } catch (e) {
      result.errors.push(`ensureTeacherFields: ${(e as Error).message}`);
    }
    return result;
  }

  /**
   * 确保某个字段为「文本字段(type=1)」。
   * 飞书不支持通过 updateField 直接改字段类型，因此若已存在但类型不符
   * （例如 沟通主题 建表时被误设为多选 type=4，应用侧按自由文本写入会 500），
   * 则删除后重建为文本，再写入自由文本即可成功。当前 沟通主题 无存量数据，重建安全。
   */
  private async ensureTextField(
    tableId: string,
    byName: Map<string, { id: string; name: string; type: number; property: Record<string, unknown> }>,
    result: SyncResult,
    name: string,
  ): Promise<void> {
    const def = byName.get(name);
    if (!def) {
      await this.base.createField(tableId, { field_name: name, type: 1 });
      result.synced.push(`${name}（已创建文本）`);
      byName.set(name, { name, id: '', type: 1, property: {} });
      return;
    }
    if (def.type !== 1) {
      await this.base.deleteField(tableId, def.id);
      await this.base.createField(tableId, { field_name: name, type: 1 });
      result.synced.push(`${name}（${def.type}→Text，已重建）`);
      byName.set(name, { name, id: '', type: 1, property: {} });
      return;
    }
    result.skipped.push(`${name}（已是文本）`);
  }

  /**
   * 家校沟通 / 日常跟进 通用字段迁移（幂等）：
   *  - 把「沟通内容」重命名为「沟通人备注」（数据保留，仅改字段名）。
   *  - 给「沟通时间」(type=5) 启用「显示时间」(formatter 含 HH:mm)，使前端可录入/展示时分。
   *  - 补齐数值字段「沟通时长(分钟)」（飞书 type=2）。
   * 以上均按字段是否存在判定，重复执行安全。
   */
  private async ensureCommCommonFields(
    tableId: string,
    byName: Map<string, { id: string; name: string; type: number; property: Record<string, unknown> }>,
    result: SyncResult,
  ): Promise<void> {
    // 1) 沟通内容 → 沟通人备注（重命名，数据保留）
    const oldContent = byName.get('沟通内容');
    if (oldContent && !byName.has('沟通人备注')) {
      await this.base.updateField(tableId, oldContent.id, { field_name: '沟通人备注', type: 1, property: oldContent.property ?? {} });
      result.synced.push('沟通内容→沟通人备注（已重命名）');
      byName.delete('沟通内容');
      byName.set('沟通人备注', { ...oldContent, name: '沟通人备注' });
    }
    // 2) 沟通时间 启用「显示时间」(HH:mm)
    const timeField = byName.get('沟通时间');
    if (timeField && timeField.type === 5) {
      const fmt = (timeField.property && (timeField.property as { date_formatter?: string }).date_formatter) || '';
      if (!/H{1,2}/.test(fmt)) {
        await this.base.updateField(tableId, timeField.id, { field_name: '沟通时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' } });
        result.synced.push('沟通时间（已启用时分）');
      }
    }
    // 3) 沟通时长(分钟) 数值字段（飞书 type=2）
    if (!byName.has('沟通时长(分钟)')) {
      await this.base.createField(tableId, { field_name: '沟通时长(分钟)', type: 2 });
      result.synced.push('沟通时长(分钟)（已创建数值）');
      byName.set('沟通时长(分钟)', { name: '沟通时长(分钟)', id: '', type: 2, property: {} });
    }
  }

  /**
   * 幂等确保家校沟通表的字典下拉字段存在且选项与字典一致：
   * - 单选字段（沟通方式/家长反馈态度/闭环状态/信息敏感级别）：不存在则创建（type=3，带字典选项）；
   *   已存在单选则追加缺失选项；已存在非单选则跳过（不删字段，避免丢数据）。
   * - 文本字段（关联学生/家长/沟通人/沟通明细/沟通总结/沟通附件清单）：不存在则创建文本字段(type=1)。
   *   其中 沟通明细 / 沟通总结 用于存放 MD 格式的沟通记录与总结，长度可能很长，飞书文本字段(1)可容纳。
   * - 沟通主题：必须是文本(type=1)，自由文本主题；若是多选(type=4)则重建为文本。
   */
  private async ensureHomeSchoolCommFields(): Promise<SyncResult> {
    const tableId = TABLES.homeSchoolComm.tableId;
    const result: SyncResult = { table: tableId, synced: [], skipped: [], errors: [] };
    const opt = (key: string) => (this.store[key] ?? []).map((name) => ({ name }));
    try {
      const fields = await this.base.listFields(tableId);
      const byName = new Map(fields.map((f) => [f.name, f]));

      // 0) 通用迁移：沟通内容→沟通人备注 / 沟通时间启用时分 / 补齐沟通时长(分钟)
      await this.ensureCommCommonFields(tableId, byName, result);

      // 0) 沟通人：原为飞书 User(11) 类型，本租户无法写入姓名（UserFieldConvFail）；
      // 删除后重建为 Text(1)，由应用侧用 open_id↔姓名 映射展示，前端 person 选择器写入姓名。
      const commPerson = byName.get('沟通人');
      if (commPerson && commPerson.type !== 1) {
        await this.base.deleteField(tableId, commPerson.id);
        await this.base.createField(tableId, { field_name: '沟通人', type: 1 });
        result.synced.push('沟通人（User→Text）');
        byName.set('沟通人', { name: '沟通人', type: 1, property: {} } as typeof commPerson);
      }

      // 1) 单选字段（带字典选项）
      const singles: { name: string; dictKey: string }[] = [
        { name: '沟通方式', dictKey: '沟通方式' },
        { name: '家长反馈态度', dictKey: '家长反馈态度' },
        { name: '闭环状态', dictKey: '家校闭环状态' },
        { name: '信息敏感级别', dictKey: '信息敏感级别' },
      ];
      for (const { name, dictKey } of singles) {
        const options = opt(dictKey);
        const def = byName.get(name);
        if (!def) {
          await this.base.createField(tableId, { field_name: name, type: SINGLE_SELECT, property: { options } });
          result.synced.push(`${name}（已创建单选）`);
          continue;
        }
        if (def.type !== SINGLE_SELECT) {
          result.skipped.push(`${name}（已存在但非单选 type=${def.type}，跳过以免丢数据）`);
          continue;
        }
        const existing = new Set((def.property.options ?? []).map((o) => o.name));
        const toAdd = options.filter((o) => !existing.has(o.name));
        if (toAdd.length) {
          const merged = [
            ...(def.property.options ?? []).map((o) => ({ name: o.name })),
            ...toAdd,
          ];
          await this.base.updateField(tableId, def.id, {
            field_name: def.name,
            type: SINGLE_SELECT,
            property: { options: merged },
          });
          result.synced.push(`${name}（+${toAdd.length}）`);
        } else {
          result.skipped.push(`${name}（已是最新）`);
        }
      }

      // 1.5) 沟通主题：必须为文本(type=1)，自由文本主题；若为多选(type=4)则重建
      await this.ensureTextField(tableId, byName, result, '沟通主题');

      // 2) 文本字段（飞书 type=1 即文本，可存多行/长内容）
      const texts: string[] = [
        '关联学生', '家长', '沟通人', '沟通明细', '沟通总结', '沟通附件清单', '责任人', '沟通人备注',
      ];
      for (const name of texts) {
        if (byName.has(name)) {
          result.skipped.push(`${name}（已存在）`);
          continue;
        }
        await this.base.createField(tableId, { field_name: name, type: 1 });
        result.synced.push(`${name}（已创建文本）`);
      }
    } catch (e) {
      result.errors.push(`ensureHomeSchoolCommFields: ${(e as Error).message}`);
    }
    return result;
  }

  /**
   * 幂等确保「日常跟进表」的字典下拉字段存在且选项与字典一致（与家校沟通表同源，删除家长相关字段）：
   * - 单选字段（沟通方式/闭环状态/信息敏感级别）：不存在则创建（type=3，带字典选项）；
   *   已存在单选则追加缺失选项；已存在非单选则跳过（不删字段，避免丢数据）。
   * - 文本字段（关联学生/沟通人/沟通人备注/沟通明细/沟通总结/沟通附件清单/待办事项/责任人/待办负责人）：
   *   不存在则创建文本字段(type=1)。
   * - 沟通主题：必须是文本(type=1)，自由文本主题；建表时误设为多选(type=4)则重建为文本。
   */
  private async ensureDailyFollowupFields(): Promise<SyncResult> {
    const tableId = TABLES.dailyFollowup.tableId;
    const result: SyncResult = { table: tableId, synced: [], skipped: [], errors: [] };
    const opt = (key: string) => (this.store[key] ?? []).map((name) => ({ name }));
    try {
      const fields = await this.base.listFields(tableId);
      const byName = new Map(fields.map((f) => [f.name, f]));

      // 0) 通用迁移：沟通内容→沟通人备注 / 沟通时间启用时分 / 补齐沟通时长(分钟)
      await this.ensureCommCommonFields(tableId, byName, result);

      // 1) 单选字段（带字典选项）
      const singles: { name: string; dictKey: string }[] = [
        { name: '沟通方式', dictKey: '沟通方式' },
        { name: '闭环状态', dictKey: '家校闭环状态' },
        { name: '信息敏感级别', dictKey: '信息敏感级别' },
      ];
      for (const { name, dictKey } of singles) {
        const options = opt(dictKey);
        const def = byName.get(name);
        if (!def) {
          await this.base.createField(tableId, { field_name: name, type: SINGLE_SELECT, property: { options } });
          result.synced.push(`${name}（已创建单选）`);
          continue;
        }
        if (def.type !== SINGLE_SELECT) {
          result.skipped.push(`${name}（已存在但非单选 type=${def.type}，跳过以免丢数据）`);
          continue;
        }
        const existing = new Set((def.property.options ?? []).map((o) => o.name));
        const toAdd = options.filter((o) => !existing.has(o.name));
        if (toAdd.length) {
          const merged = [
            ...(def.property.options ?? []).map((o) => ({ name: o.name })),
            ...toAdd,
          ];
          await this.base.updateField(tableId, def.id, {
            field_name: def.name,
            type: SINGLE_SELECT,
            property: { options: merged },
          });
          result.synced.push(`${name}（+${toAdd.length}）`);
        } else {
          result.skipped.push(`${name}（已是最新）`);
        }
      }

      // 1.5) 沟通主题：必须为文本(type=1)，自由文本主题；若为多选(type=4)则重建
      await this.ensureTextField(tableId, byName, result, '沟通主题');

      // 2) 文本字段（飞书 type=1）
      const texts: string[] = [
        '关联学生', '沟通人', '沟通人备注', '沟通明细', '沟通总结', '沟通附件清单', '待办事项', '责任人', '待办负责人',
      ];
      for (const name of texts) {
        if (byName.has(name)) {
          result.skipped.push(`${name}（已存在）`);
          continue;
        }
        await this.base.createField(tableId, { field_name: name, type: 1 });
        result.synced.push(`${name}（已创建文本）`);
      }
    } catch (e) {
      result.errors.push(`ensureDailyFollowupFields: ${(e as Error).message}`);
    }
    return result;
  }

  /**
   * 幂等创建学生档案新增的单选/多选字段，并完成：
   * - 重命名 当前年级 → 入学年级（数据保留）。
   * - 创建 现居住省 / 城市 / 入学年份 / 实际学制（单选，type=3，带选项）。
   * - 将 学生标签 由文本(1) 转为多选(4) 标签列（一次性迁移，原自由文本标签可能丢失）。
   * - 创建 特长标签（多选，type=4）。
   */
  private async ensureStudentSelectFields(): Promise<SyncResult> {
    const result: SyncResult = { table: this.TABLE, synced: [], skipped: [], errors: [] };
    const opt = (key: string) => (this.store[key] ?? []).map((name) => ({ name }));
    try {
      const fields = await this.base.listFields(this.TABLE);
      const byName = new Map(fields.map((f) => [f.name, f]));

      // 1) 重命名 当前年级 → 入学年级
      const oldGrade = byName.get('当前年级');
      if (oldGrade && !byName.has('入学年级')) {
        await this.base.updateField(this.TABLE, oldGrade.id, {
          field_name: '入学年级',
          type: oldGrade.type,
          property: { options: (oldGrade.property.options ?? []).map((o) => ({ name: o.name })) },
        });
        result.synced.push('当前年级 → 入学年级（已重命名）');
        byName.set('入学年级', { ...oldGrade, name: '入学年级' });
        byName.delete('当前年级');
      }

      // 2) 单选字段（带固定选项）
      const singles: { name: string; dictKey: string }[] = [
        { name: '现居住省', dictKey: '现居住省' },
        { name: '城市', dictKey: '城市' },
        { name: '入学年份', dictKey: '入学年份' },
        { name: '实际学制', dictKey: '实际学制' },
        { name: '原学校类型', dictKey: '原学校类型' },
        { name: '合同状态', dictKey: '合同状态' },
        { name: '付款状态', dictKey: '付款状态' },
        { name: '家庭关键决策点', dictKey: '家庭关键决策点' },
        // 入学测试
        { name: '英语标化类型', dictKey: '英语标化类型' },
        { name: '综合评定等级', dictKey: '综合评定等级' },
        // 学术表现
        { name: 'GPA成绩类型', dictKey: 'GPA成绩类型' },
        { name: '语言标化类型', dictKey: '语言标化类型' },
        { name: '学术标化类型', dictKey: '学术标化类型' },
        // 家庭情况（是否类单选）
        { name: '是否企业家庭', dictKey: '是否' },
        { name: '是否工坊企业', dictKey: '是否' },
        { name: '是否多胎家庭', dictKey: '是否' },
        // 升学阶段
        { name: '签证情况', dictKey: '签证情况' },
      ];
      for (const { name, dictKey } of singles) {
        if (byName.has(name)) {
          result.skipped.push(`${name}（已存在）`);
          continue;
        }
        await this.base.createField(this.TABLE, {
          field_name: name,
          type: SINGLE_SELECT,
          property: { options: opt(dictKey) },
        });
        result.synced.push(`${name}（已创建单选）`);
      }

      // 3) 学生标签：文本(1) → 多选(4)
      const tagField = byName.get('学生标签');
      if (!tagField) {
        await this.base.createField(this.TABLE, { field_name: '学生标签', type: MULTI_SELECT, property: { options: [] } });
        result.synced.push('学生标签（已创建多选）');
      } else if (tagField.type !== MULTI_SELECT) {
        await this.base.deleteField(this.TABLE, tagField.id);
        await this.base.createField(this.TABLE, { field_name: '学生标签', type: MULTI_SELECT, property: { options: [] } });
        result.synced.push('学生标签（文本 → 多选，原文本标签可能丢失）');
      } else {
        result.skipped.push('学生标签（已是多选）');
      }

      // 4) 特长标签：多选(4)，候选项来自字典（固定下拉）
      const tagDef = byName.get('特长标签');
      if (!tagDef) {
        await this.base.createField(this.TABLE, {
          field_name: '特长标签',
          type: MULTI_SELECT,
          property: { options: opt('特长标签') },
        });
        result.synced.push('特长标签（已创建多选）');
      } else if (tagDef.type === MULTI_SELECT) {
        const existing = new Set((tagDef.property.options ?? []).map((o) => o.name));
        const toAdd = (this.store['特长标签'] ?? []).filter((o) => !existing.has(o));
        if (toAdd.length) {
          const merged = [
            ...(tagDef.property.options ?? []).map((o) => ({ name: o.name })),
            ...toAdd.map((name) => ({ name })),
          ];
          await this.base.updateField(this.TABLE, tagDef.id, {
            field_name: '特长标签',
            type: MULTI_SELECT,
            property: { options: merged },
          });
          result.synced.push(`特长标签（+${toAdd.length} 选项）`);
        } else {
          result.skipped.push('特长标签（已是最新）');
        }
      } else {
        result.skipped.push(`特长标签（已存在但非多选 type=${tagDef.type}，跳过）`);
      }
    } catch (e) {
      result.errors.push(`ensureStudentSelectFields: ${(e as Error).message}`);
    }
    return result;
  }

  /**
   * 确保指定多选/单选字段包含给定候选项（追加缺失项）。
   * 用于标签字段：用户在前端输入新标签保存时，先把选项写回飞书字段，
   * 否则写入会因「选项不在枚举内」而失败。
   */
  async ensureOptions(tableId: string, fieldName: string, values: string[]): Promise<void> {
    const wanted = Array.from(new Set((values ?? []).map((v) => (v ?? '').trim()).filter(Boolean)));
    if (!wanted.length) return;
    try {
      const fields = await this.base.listFields(tableId);
      const def = fields.find((f) => f.name === fieldName);
      if (!def) return;
      if (def.type !== SINGLE_SELECT && def.type !== MULTI_SELECT) return;
      const existing = new Set((def.property.options ?? []).map((o) => o.name));
      const toAdd = wanted.filter((v) => !existing.has(v));
      if (!toAdd.length) return;
      const merged = [
        ...(def.property.options ?? []).map((o) => ({ name: o.name })),
        ...toAdd.map((name) => ({ name })),
      ];
      await this.base.updateField(tableId, def.id, {
        field_name: def.name,
        type: def.type,
        property: { options: merged },
      });
    } catch (e) {
      this.logger.warn(`ensureOptions(${fieldName}) 失败：${(e as Error).message}`);
    }
  }

  /**
   * 幂等将学生表的人员字段由 User(11) 转为 Text(1)。
   * - 已为 Text：跳过。
   * - 仍为 User：删除后重建为同名的 Text 字段（这些字段当前无数据，删除安全）。
   */
  private async ensureUserFieldsAsText(): Promise<SyncResult> {
    const result: SyncResult = { table: this.TABLE, synced: [], skipped: [], errors: [] };
    const userFields = ['招生负责老师', '班主任', '数据负责人', '升学导师'];
    try {
      for (const name of userFields) {
        const fields = await this.base.listFields(this.TABLE);
        const def = fields.find((f) => f.name === name);
        if (!def) {
          // 字段不存在则直接创建为 Text
          await this.base.createField(this.TABLE, { field_name: name, type: 1 });
          result.synced.push(`${name}（新建为文本）`);
          continue;
        }
        if (def.type === 1) {
          result.skipped.push(`${name}（已是文本）`);
          continue;
        }
        // 非文本（如 User=11）：删除后重建为 Text
        await this.base.deleteField(this.TABLE, def.id);
        await this.base.createField(this.TABLE, { field_name: name, type: 1 });
        result.synced.push(`${name}（User→Text）`);
        this.logger.log(`字典同步：${name} 由 User 转为 Text`);
      }
    } catch (e) {
      result.errors.push(`ensureUserFieldsAsText: ${(e as Error).message}`);
    }
    return result;
  }

  /**
   * 幂等创建学生表新增的文本字段（type=1）。
   * 这些字段不是单选/多选，无法走 syncTable 的选项合并，需单独建字段。
   */
  private async ensureStudentTextFields(): Promise<SyncResult> {
    const result: SyncResult = { table: this.TABLE, synced: [], skipped: [], errors: [] };
    const needed = [
      'Arete毕业届', '证件信息', '原学校', '奖学金金额',
      // 入学测试
      '数学笔试成绩', '英语笔试成绩', '英语标化成绩', '英语口语评分',
      '家长面谈情况', '学生面试情况', '作品集/附加材料评价',
      // 学术表现
      'GPA成绩', '预警科目', '提升成果', '语言标化成绩', '学术标化成绩',
      '出勤率', '作业完成率', '核心课程表现',
      // 成长表现
      '社团表现', '社区服务表现', '企业参访表现', '创新创业PBL表现', 'AI LAB项目表现',
      '亮点行动', '交付物', '项目导师评语/成长改进建议', 'IDP导师评语/成长改进建议',
      // 家庭情况
      '父亲姓名', '父亲单位', '父亲职位', '父亲电话', '父亲邮箱',
      '母亲姓名', '母亲单位', '母亲职位', '母亲电话', '母亲邮箱',
      '家庭地址', '家长期待',
      // 升学阶段
      '初始留学意向', '目标国家', '目标院校', '意向专业', '录取offer', '最终入读院校',
      // 健康与安全
      '既往病史', '心理状态',
      // 基本信息
      '日常禁忌', '宗教信仰',
    ];
    try {
      const fields = await this.base.listFields(this.TABLE);
      const existing = new Set(fields.map((f) => f.name));
      for (const name of needed) {
        if (existing.has(name)) {
          result.skipped.push(`${name}（已存在）`);
          continue;
        }
        try {
          await this.base.createField(this.TABLE, { field_name: name, type: 1 });
          result.synced.push(`${name}（已创建）`);
          this.logger.log(`字典同步：创建学生表文本字段 ${name}`);
        } catch (e) {
          result.errors.push(`${name}: ${(e as Error).message}`);
          this.logger.warn(`创建字段失败 ${name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      result.errors.push(`listFields failed: ${(e as Error).message}`);
    }
    return result;
  }

  /** 用户表需要同步字典选项的字段（校区下拉框候选项来自字典「校区」；教师类型为单选） */
  private get USER_FIELD_SYNC(): { field: string; dictKey: string }[] {
    return [
      { field: '默认校区', dictKey: '校区' },
      { field: '教师类型', dictKey: '教师类型' },
    ];
  }

  /**
   * 幂等创建用户表的「教师类型」单选字段（type=3）。
   * 该字段用于区分班主任 / 招生老师，新建用户时下拉选择；
   * 选项随后由 syncTable(USER_FIELD_SYNC) 与字典「教师类型」保持一致。
   */
  private async ensureUserTeacherTypeField(): Promise<SyncResult> {
    const result: SyncResult = { table: USER_TABLE.tableId, synced: [], skipped: [], errors: [] };
    const name = '教师类型';
    try {
      const fields = await this.base.listFields(USER_TABLE.tableId);
      const def = fields.find((f) => f.name === name);
      if (def) {
        result.skipped.push(`${name}（已存在，type=${def.type}）`);
        return result;
      }
      await this.base.createField(USER_TABLE.tableId, {
        field_name: name,
        type: SINGLE_SELECT,
        property: { options: (this.store['教师类型'] ?? []).map((o) => ({ name: o })) },
      });
      result.synced.push(`${name}（已创建单选字段）`);
      this.logger.log(`字典同步：创建用户表单选字段 ${name}`);
    } catch (e) {
      result.errors.push(`ensureUserTeacherTypeField: ${(e as Error).message}`);
    }
    return result;
  }

  private async syncTable(
    tableId: string,
    syncs: { field: string; dictKey: string }[],
  ): Promise<SyncResult> {
    const result: SyncResult = { table: tableId, synced: [], skipped: [], errors: [] };
    let fields: { id: string; name: string; type: number; property: { options?: { name: string; id?: string }[] } }[];
    try {
      fields = await this.base.listFields(tableId);
    } catch (e) {
      result.errors.push(`listFields failed: ${(e as Error).message}`);
      return result;
    }
    const fieldByName = new Map(fields.map((f) => [f.name, f]));

    for (const { field, dictKey } of syncs) {
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
        await this.base.updateField(tableId, def.id, {
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
