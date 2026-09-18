import { describe, expect, it } from 'vitest';
import { buildWriteFields, toFlatRecord } from '../src/shared/record.util.js';
import { formatReadValue } from '../src/sql-store/field-type.js';

/**
 * `toFlatRecord` 的附件保留契约。
 *
 * 背景（2026-09-18 实测）：`toFlatRecord` 对**所有**字段统一走 `toText`，而 `toText`
 * 是按富文本数组实现的（取每项的 `.text` 再拼接）。附件项是 `{file_token,name,size,type}`
 * 没有 `.text` ⇒ **非空附件被拍成空字符串**，界面上附件列表恒为空、音频播放器渲染不出来。
 * 直接后果：「笔记转出带录音」写进业务记录的 `会议附件 / 沟通附件清单` 在页面上看不见。
 *
 * 本文件把判据钉死：附件数组原样返回，富文本数组照旧拍平。
 * 纯函数、不连数据库，可随时重跑。
 */

const ATT = [
  {
    file_token: 'loc_83922a92a14ea5165782d54dmu653a1uabe9c496',
    name: '1920961856572391512.ogg',
    size: 1234567,
    type: 'audio/ogg',
  },
];

describe('toFlatRecord：附件字段必须原样保留', () => {
  it('单个附件数组原样返回（不被 toText 拍成空串）', () => {
    const out = toFlatRecord({ recordId: 'rec_1', fields: { 会议附件: ATT } }, new Set(), new Set());
    expect(out['会议附件']).toEqual(ATT);
  });

  it('多个附件也保留（顺序不变）', () => {
    const two = [ATT[0], { file_token: 'loc_b', name: 'b.mp3', size: 2, type: 'audio/mpeg' }];
    const out = toFlatRecord({ recordId: 'rec_1', fields: { 沟通附件清单: two } }, new Set(), new Set());
    expect(out['沟通附件清单']).toEqual(two);
  });

  it('即便字段被登记为多选 / 只读，附件仍保持数组（优先于 multi/readonly 分支）', () => {
    const out = toFlatRecord(
      { recordId: 'rec_1', fields: { 会议附件: ATT } },
      new Set(['会议附件']), // readonly
      new Set(['会议附件']), // multi
    );
    expect(out['会议附件']).toEqual(ATT);
  });

  it('富文本数组照旧拍成纯文本（不能因为新增附件分支而退化）', () => {
    const out = toFlatRecord(
      { recordId: 'rec_1', fields: { 会议总结: [{ text: '第一段' }, { text: '第二段' }] } },
      new Set(),
      new Set(),
    );
    expect(out['会议总结']).toBe('第一段第二段');
  });

  it('普通字符串 / 数字 / 空数组行为不变', () => {
    const out = toFlatRecord(
      { recordId: 'rec_1', fields: { 主题: '周会', 时长: 30, 会议附件: [] } },
      new Set(),
      new Set(),
    );
    expect(out['主题']).toBe('周会');
    expect(out['时长']).toBe('30');
    // 空附件数组仍退化成空串（无附件与「有附件」用真假值就能区分，够用）
    expect(out['会议附件']).toBe('');
  });

  it('缺 file_token 的普通对象数组不会被误判为附件', () => {
    const out = toFlatRecord(
      { recordId: 'rec_1', fields: { 附件: [{ text: 'a' }, { text: 'b' }] } },
      new Set(),
      new Set(),
    );
    expect(out['附件']).toBe('ab');
  });

  it('link 字段仍注入 __link（附件分支不能挤掉它）', () => {
    const out = toFlatRecord(
      {
        recordId: 'rec_1',
        fields: { 关联学生: [{ record_ids: ['recv123'], table_id: 'tbl1', text: null }] },
      },
      new Set(),
      new Set(),
      new Set(['关联学生']),
    );
    expect(out['关联学生']).toBe('recv123');
    expect(out['关联学生__link']).toEqual(['recv123']);
  });
});

describe('buildWriteFields：写入侧与读侧对称', () => {
  it('附件数组原样写出（不被 toWriteMulti 拆成空数组）', () => {
    const fields = buildWriteFields({ 会议附件: ATT }, new Set(), new Set());
    expect(fields['会议附件']).toEqual(ATT);
  });

  it('附件以 JSON 字符串提交（前端 CrudPage 的实际路径）时原样保留', () => {
    const raw = JSON.stringify(ATT);
    const fields = buildWriteFields({ 会议附件: raw }, new Set(), new Set());
    expect(fields['会议附件']).toBe(raw);
  });

  it('普通多选字段仍走字符串数组', () => {
    const fields = buildWriteFields({ 标签: [{ text: 'A' }, { text: 'B' }] }, new Set(), new Set());
    expect(fields['标签']).toEqual(['A', 'B']);
  });
});

/**
 * 拍平的**第一现场**在 `SqlStore.normalize` → `formatReadValue`：
 * 「沟通附件清单」在历史建表时被登记成文本字段（type=1），按 type=1 走 toText
 * 就会把附件数组拍成空串 —— 这是 2026-09-18「转出的录音在页面上看不见」的真正根因
 * （会议纪要的「会议附件」没有字段元数据，反而没被拍平，所以只有它看起来是好的）。
 */
describe('formatReadValue：附件数组优先于字段类型', () => {
  it('type=1（文本）也不能把附件拍成空串', () => {
    expect(formatReadValue(ATT, { type: 1 })).toEqual(ATT);
  });

  it('无字段元数据时同样保留', () => {
    expect(formatReadValue(ATT, undefined)).toEqual(ATT);
  });

  it('其余类型行为不变：富文本按 type=1 归一化', () => {
    expect(formatReadValue([{ text: '甲' }, { text: '乙' }], { type: 1 })).toBe('甲乙');
  });

  it('日期（type=5）照旧格式化', () => {
    expect(formatReadValue(1789716670936, { type: 5 })).toMatch(/^2026-09-\d{2}$/);
  });

  it('多选（type=4）保持数组', () => {
    expect(formatReadValue(['A', 'B'], { type: 4 })).toEqual(['A', 'B']);
  });
});
