import { describe, expect, it } from 'vitest';
import { pickSourceEntry } from '../src/getnote/source-cred.js';

/**
 * 「批量任务该用谁的凭证」判据的契约测试。
 *
 * 背景：管理员跑批量任务（保存原始音频 / 重新收取正文）时，他一个人要替所有同事
 * 去打上游详情接口。若选错凭证，上游会返回 `10008 权限不足` —— 而不是「无数据」，
 * 所以**看起来像上游不给你**，实际是自己拿错了 Key。
 *
 * 2026-09-18 实测指纹（很值得记住）：
 *   试点 5 条 → 成功 1 / 失败 4，**失败的全是别人的笔记**，
 *   成功的恰好是管理员自己那条（来源配置为空）。
 *   ⇒ 这个「错得极有规律」的分布，就是「凭证回退成了管理员自己的」的特征。
 *
 * 实况数据取自生产（`114.215.186.106` PG）。
 * 本文件**不连数据库、不改任何数据**（纯函数），可随时重跑。
 */

// ── 生产实况 ────────────────────────────────────────────────────
/** 郝瑞玲｜Rin（Rin Hao Get Note） */
const RIN_ID = 'rec_1e2e6eb0ac3d9a0a3d3d0d1b';
/** 蒋潘云｜Elsa（Elsa Jiang Get Note） */
const ELSA_ID = 'rec_6a3ae3ef775dc4da1d4b0c3f';
/** 吴洁｜Joyce（Joyce Wu Get Note）—— 注意：生产配置名末尾**带一个空格** */
const JOYCE_ID = 'rec_9bb174db0f9f3fb53f1f59b2';

const ENTRIES = [
  { recordId: RIN_ID, sourceName: 'Rin Hao Get Note', ownerName: '郝瑞玲｜Rin' },
  { recordId: ELSA_ID, sourceName: 'Elsa Jiang Get Note', ownerName: '蒋潘云｜Elsa' },
];

describe('pickSourceEntry（批量任务：这篇笔记该用谁的凭证）', () => {
  it('按「来源配置ID」精确命中', () => {
    const hit = pickSourceEntry(ENTRIES, { sourceRecordId: RIN_ID });
    expect(hit?.ownerName).toBe('郝瑞玲｜Rin');
  });

  it('🔴 ID 对不上时**必须继续按名称兜底**，不能直接返回 null', () => {
    // 历史上正文表的「来源配置ID」曾全为空（detail 漏回写），
    // 那时只剩「来源配置」名称这一条线索 —— 直接返回 null 会让人以为「这篇没主」，
    // 进而回退到管理员自己的凭证 ⇒ 10008。
    const hit = pickSourceEntry(ENTRIES, { sourceRecordId: '', sourceName: 'Elsa Jiang Get Note' });
    expect(hit?.ownerName).toBe('蒋潘云｜Elsa');
  });

  it('ID 是错的、名称是对的 ⇒ 仍按名称命中（老数据兜底路径）', () => {
    const hit = pickSourceEntry(ENTRIES, {
      sourceRecordId: 'rec_不存在的配置',
      sourceName: 'Rin Hao Get Note',
    });
    expect(hit?.ownerName).toBe('郝瑞玲｜Rin');
  });

  it('ID 优先于名称（两者不一致时以 ID 为准）', () => {
    const hit = pickSourceEntry(ENTRIES, {
      sourceRecordId: ELSA_ID,
      sourceName: 'Rin Hao Get Note',
    });
    expect(hit?.ownerName).toBe('蒋潘云｜Elsa');
  });

  it('两个线索都为空 ⇒ null（管理员自己的笔记，用自己的凭证）', () => {
    expect(pickSourceEntry(ENTRIES, {})).toBeNull();
    expect(pickSourceEntry(ENTRIES, { sourceRecordId: '', sourceName: '' })).toBeNull();
    expect(pickSourceEntry(ENTRIES, { sourceRecordId: '  ', sourceName: '  ' })).toBeNull();
  });

  it('匹配不上任何人 ⇒ null（不猜、不模糊匹配名字）', () => {
    expect(pickSourceEntry(ENTRIES, { sourceRecordId: 'rec_xxx', sourceName: 'Nobody Get Note' })).toBeNull();
  });

  it('名称必须**完全相同**才算命中（防「张三」误配「张三丰」式的人名包含）', () => {
    expect(pickSourceEntry(ENTRIES, { sourceName: 'Rin Hao' })).toBeNull();
    expect(pickSourceEntry(ENTRIES, { sourceName: 'Rin Hao Get Note ' })).not.toBeNull(); // 两侧 trim
  });

  it('🔴 **两侧都要 trim**：配置名末尾带空格（生产实况）也必须命中', () => {
    // 生产数据里真有这种配置：吴洁那条 `配置名称` 实测是 'Joyce Wu Get Note '（len=18，末位空格）。
    // 若只 trim 查询值、不 trim 配置值 ⇒ 17 vs 18 ⇒ 永不相等 ⇒ 那批笔记全部回落成
    // 管理员自己的凭证 ⇒ 上游 10008 权限不足。2026-09-18 试点 10 条里就这 2 条失败。
    const withSpace = [{ recordId: JOYCE_ID, sourceName: 'Joyce Wu Get Note ', ownerName: '吴洁｜Joyce' }];
    expect(pickSourceEntry(withSpace, { sourceName: 'Joyce Wu Get Note' })?.ownerName).toBe('吴洁｜Joyce');
    // 反向：配置干净、库里的值带空格（也真实存在）
    expect(pickSourceEntry(withSpace, { sourceName: 'Joyce Wu Get Note  ' })?.ownerName).toBe('吴洁｜Joyce');
    // 带空格的 ID 同样要能命中
    const spaceId = [{ recordId: ' rec_x ', sourceName: 'X Get Note', ownerName: '某人' }];
    expect(pickSourceEntry(spaceId, { sourceRecordId: 'rec_x' })?.ownerName).toBe('某人');
  });

  it('配置列表为空 ⇒ null（不会抛错）', () => {
    expect(pickSourceEntry([], { sourceRecordId: RIN_ID })).toBeNull();
  });
});
