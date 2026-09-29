import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkIds } from '../src/shared/record.util.js';

/**
 * 学生「证件与文件」附件链路的守卫测试（2026-09-29 修）。
 *
 * ## 为什么要锁住
 *
 * `attachDoc` 的旧注释写着「双向关联自动回填学生的「证件与文件」」—— 那是**飞书 Base 的行为**。
 * 生产 `SQL_TABLES=*` 全部走 PG，**没有这个回填** ⇒ 上传成功、关联表建了行，
 * 但学生档案里一个附件都看不到（详情接口返回 0 条），**不报错、不崩**。
 * 同时读侧只认飞书 `[{ record_ids: [...] }]` 形态，而 PG 落库的是**字符串 id 数组**
 * ⇒ 即使回填了也读不出来。
 *
 * 这两处都是「静默失效」，所以用测试钉住：
 *   ① 读侧必须用宽容解析 `linkIds()`
 *   ② 写侧必须自己维护学生侧的关联（PG 不会替他做）
 *
 * 本文件读源码文本 + 真跑纯函数，不连数据库、不改数据。
 */

function read(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf8');
}

const SVC = read('apps', 'api', 'src', 'student', 'student.service.ts');

describe('A. 关联字段的宽容解析（真跑 linkIds）', () => {
  it('吃 PG 落库的字符串数组（本次修的核心形态）', () => {
    expect(linkIds(['rec1', 'rec2'])).toEqual(['rec1', 'rec2']);
  });

  it('吃飞书的 {link_record_ids} 与 [{record_ids}] 两种形态', () => {
    expect(linkIds({ link_record_ids: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(linkIds([{ record_ids: ['c'] }])).toEqual(['c']);
    expect(linkIds([{ record_id: 'd' }])).toEqual(['d']);
  });

  it('空壳与异常值都返回空数组（`{"link_record_ids": null}` 是"空关联"不是"有值"）', () => {
    expect(linkIds({ link_record_ids: null })).toEqual([]);
    expect(linkIds(null)).toEqual([]);
    expect(linkIds(undefined)).toEqual([]);
    expect(linkIds('')).toEqual([]);
  });
});

describe('B. 读侧：resolveDocFiles / removeDoc 必须用 linkIds', () => {
  it('🔴 不再拿单一形态 `arr[0]?.record_ids` 去解析（那正是"附件恒为 0"的原因）', () => {
    expect(SVC).not.toContain('arr[0]?.record_ids');
    expect(SVC).not.toContain('link[0]?.record_ids');
  });

  it('resolveDocFiles 用 linkIds 解析后按 id 列表查关联表', () => {
    const i = SVC.indexOf('private async resolveDocFiles');
    expect(i).toBeGreaterThan(-1);
    const seg = SVC.slice(i, i + 900);
    expect(seg).toContain('linkIds(link)');
    expect(seg).toContain('recordIds.map((rid) => this.base.get(DOC_TABLE, rid)');
  });

  it('removeDoc 也用 linkIds，并在删除后同步摘掉学生侧引用（与回填对称）', () => {
    const i = SVC.indexOf('async removeDoc');
    const seg = SVC.slice(i, i + 2000);
    expect(seg).toContain("linkIds(rec?.fields?.['证件与文件'])");
    expect(seg).toContain('证件与文件: recordIds.filter((x) => x !== removedId)');
  });
});

describe('C. 写侧：attachDoc 必须自己回填学生侧的关联', () => {
  const i = SVC.indexOf('async attachDoc');
  const seg = SVC.slice(i, i + 1800);

  it('🔴 建完关联行后必须 update 学生表（PG 没有"双向关联自动回填"）', () => {
    expect(i).toBeGreaterThan(-1);
    expect(seg).toContain('await this.base.update(TABLE, studentId');
    expect(seg).toContain('证件与文件: [...cur, docId]');
  });

  it('回填是幂等的（已在列表里就不重复写）', () => {
    expect(seg).toContain('if (!cur.includes(docId))');
  });

  it('关联行的三个字段齐全（文件附件 / 文件名称 / 关联学生）', () => {
    expect(seg).toContain('文件附件: [{ file_token: fileToken }]');
    expect(seg).toContain('文件名称: name');
    expect(seg).toContain('关联学生: [studentId]');
  });

  it('`证件与文件` 仍在 READONLY_FIELDS 里（前端保存学生跳过它 ⇒ 手工维护不会被覆盖）', () => {
    const j = SVC.indexOf('const READONLY_FIELDS');
    const block = SVC.slice(j, SVC.indexOf(']', j));
    expect(block).toContain("'证件与文件'");
  });
});
