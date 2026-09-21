/**
 * 导出：三合一记录表的「按记录类型分别导出」判据测试（2026-09-21）。
 *
 * 起因：导出页给的是「三个表键 = 三类记录」，而三合一是**一张表 + 一个记录类型字段** ⇒
 * 「日常跟进」导出整张表（5 类全在里面）、「家校沟通 / 学生观察」指向合并前的旧表
 * （生产实测 0 行，导出来只有表头）。
 *
 * 这里锁三件事，任何一条写错都会静默出错：
 *   ① 表键 → 表 + 默认类型（历史键必须映射到**新表**）；
 *   ② 空「记录类型」的行按 defaultType 归属（否则合并前的老记录在导出里集体消失）；
 *   ③ 导出的类型范围 **不宽于** 列表（类型权限判一次）。
 */
import { describe, expect, it } from 'vitest';
import { STUDENT_RECORD_EXPORT_KEY, STUDENT_RECORD_TYPE_VALUES } from '@acms/contracts';
import {
  RECORD_EXPORT_TABLE,
  pickRecordRows,
  resolveRecordExport,
  rowRecordType,
} from '../src/export/export-filter.js';

const DEFAULT_TYPE = '日常跟进';

describe('resolveRecordExport：表键 → 表 + 记录类型', () => {
  it('无参数：三个历史键各自落到三合一表 + 自己的默认类型', () => {
    expect(resolveRecordExport('dailyFollowup')).toEqual({
      kind: 'records',
      tableKey: 'dailyFollowup',
      type: '日常跟进',
      all: false,
    });
    // 🔴 家校沟通 / 学生观察原先指向**合并前的旧表**（0 行）—— 必须映射到新表
    expect(resolveRecordExport('homeSchoolComm')).toEqual({
      kind: 'records',
      tableKey: 'dailyFollowup',
      type: '家校沟通',
      all: false,
    });
    expect(resolveRecordExport('studentObservation')).toEqual({
      kind: 'records',
      tableKey: 'dailyFollowup',
      type: '学生观察',
      all: false,
    });
  });

  it('新增类型不用加表键：用「记录类型」参数指定', () => {
    expect(resolveRecordExport('dailyFollowup', 'IDP沟通')).toEqual({
      kind: 'records',
      tableKey: RECORD_EXPORT_TABLE,
      type: 'IDP沟通',
      all: false,
    });
    expect(resolveRecordExport('dailyFollowup', '学生沟通')).toEqual({
      kind: 'records',
      tableKey: RECORD_EXPORT_TABLE,
      type: '学生沟通',
      all: false,
    });
  });

  it('「全部」= 该用户有权看到的全部类型（不是"无限制"）', () => {
    expect(resolveRecordExport('dailyFollowup', '全部')).toEqual({
      kind: 'records',
      tableKey: RECORD_EXPORT_TABLE,
      type: '',
      all: true,
    });
  });

  it('未知的记录类型 ⇒ bad-type（否则会导出一个空文件，用户以为没数据）', () => {
    expect(resolveRecordExport('dailyFollowup', '日常跟')).toEqual({ kind: 'bad-type', value: '日常跟' });
    expect(resolveRecordExport('dailyFollowup', '家校沟通 ')).toMatchObject({ kind: 'records' }); // 前后空格容忍
  });

  it('普通表不受影响（plain，且忽略记录类型参数）', () => {
    expect(resolveRecordExport('studentProfile')).toEqual({ kind: 'plain' });
    expect(resolveRecordExport('studentProfile', '日常跟进')).toEqual({ kind: 'plain' });
    expect(resolveRecordExport('academicGrade')).toEqual({ kind: 'plain' });
  });

  it('导出键常量与类型清单是同一份来源（新增类型自动可导）', () => {
    expect(RECORD_EXPORT_TABLE).toBe(STUDENT_RECORD_EXPORT_KEY);
    for (const t of STUDENT_RECORD_TYPE_VALUES) {
      expect(resolveRecordExport(RECORD_EXPORT_TABLE, t)).toMatchObject({ kind: 'records', type: t });
    }
  });
});

const row = (type?: string) => ({ fields: type === undefined ? {} : { 记录类型: type } });

describe('rowRecordType：空类型按 defaultType 归属', () => {
  it('空串 / 全空格 / 缺字段都算 defaultType（与列表同源）', () => {
    expect(rowRecordType({}, DEFAULT_TYPE)).toBe(DEFAULT_TYPE);
    expect(rowRecordType({ 记录类型: '' }, DEFAULT_TYPE)).toBe(DEFAULT_TYPE);
    expect(rowRecordType({ 记录类型: '   ' }, DEFAULT_TYPE)).toBe(DEFAULT_TYPE);
    expect(rowRecordType({ 记录类型: '家校沟通' }, DEFAULT_TYPE)).toBe('家校沟通');
  });
});

describe('pickRecordRows：只导目标类型，且不宽于类型权限', () => {
  const rows = [row('日常跟进'), row(), row('家校沟通'), row('学生观察')];

  it('目标 = 日常跟进 ⇒ 含「未打类型」的历史记录（不是只有明确标了的那条）', () => {
    const out = pickRecordRows(rows, null, { type: '日常跟进', all: false }, DEFAULT_TYPE);
    expect(out).toHaveLength(2);
  });

  it('目标 = 家校沟通 ⇒ 只有家校沟通，历史的空类型记录不掺进来', () => {
    const out = pickRecordRows(rows, null, { type: '家校沟通', all: false }, DEFAULT_TYPE);
    expect(out).toHaveLength(1);
    expect(out[0]?.fields['记录类型']).toBe('家校沟通');
  });

  it('「全部类型」⇒ 有权范围内的所有类型都导（含空类型）', () => {
    const out = pickRecordRows(rows, ['日常跟进', '家校沟通', '学生观察'], { type: '', all: true }, DEFAULT_TYPE);
    expect(out).toHaveLength(4);
  });

  it('🔴 类型权限收窄：没有家校沟通权限的人，即使显式指定也一条都不给', () => {
    const out = pickRecordRows(rows, ['学生观察'], { type: '家校沟通', all: false }, DEFAULT_TYPE);
    expect(out).toHaveLength(0);
  });

  it('🔴 「全部类型」也只在有权范围内（名单外的类型不出现）', () => {
    const out = pickRecordRows(rows, ['学生观察'], { type: '', all: true }, DEFAULT_TYPE);
    expect(out).toHaveLength(1);
    expect(out[0]?.fields['记录类型']).toBe('学生观察');
  });

  it('无类型权限（空数组）⇒ 一条都不导（不是"全给"）', () => {
    expect(pickRecordRows(rows, [], { type: '日常跟进', all: false }, DEFAULT_TYPE)).toHaveLength(0);
    expect(pickRecordRows(rows, [], { type: '', all: true }, DEFAULT_TYPE)).toHaveLength(0);
  });

  it('allowed=null（管理员/豁免角色）⇒ 不按类型权限收窄，但仍按目标类型筛', () => {
    expect(pickRecordRows(rows, null, { type: '家校沟通', all: false }, DEFAULT_TYPE)).toHaveLength(1);
    expect(pickRecordRows(rows, null, { type: '', all: true }, DEFAULT_TYPE)).toHaveLength(4);
  });
});
