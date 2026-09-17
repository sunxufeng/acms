import { describe, expect, it } from 'vitest';
import { noteInScopedSources, sourceVisibleTo } from '../src/getnote/source-cred.js';

/**
 * 「我的笔记」可见性判据的契约测试（非管理员路径）。
 *
 * 数据取自**生产实况**（2026-09-17 从 `114.215.186.106` 的 PG 导出）：
 * 刘佳音｜Joy 的配置 `Joy Liu Get Note` 与她的用户表记录。
 *
 * 本文件**不连数据库、不改任何数据**（纯函数），可随时重跑。
 */

// ── 生产实况数据 ────────────────────────────────────────────────
/** 刘佳音｜Joy 的 openId（用户表「飞书 Open ID」） */
const JOY_OPEN_ID = 'ou_43f84e25945974e5556e041b401fcf82';
/** 她在用户表里的 record id（「关联用户」字段存的就是它，不是 openId） */
const JOY_USER_ID = 'recvrktwfxtlrf';
/** 她那条知识库配置的 record id */
const JOY_SOURCE_ID = 'rec_5d196a7e26ca5d239c4c8ba4';
/** 另一位同事（钟慧婷｜Alice）的配置，用于验证「别人的源我看不到」 */
const OTHER_SOURCE_ID = 'rec_5b657f0a52f6a82eae686262';

/** 她的配置行的可见性字段（原样取自生产） */
const JOY_SOURCE = { ownerOpenId: JOY_OPEN_ID, linkedUserIds: [JOY_USER_ID] };

describe('noteInScopedSources（笔记是否属于我可见的源）', () => {
  it('🔴 recordId 为空 ⇒ **可见**（本人凭证那一路；丢掉它会让人「自己的笔记一条都看不到」）', () => {
    // 2026-09-17 刘佳音报障的根因：她在向导页填过个人凭证，且该凭证与她那条配置是同一份 Key
    // ⇒ collectAllNotes 里个人凭证源先入列并占住 seenKey ⇒ 配置源被跳过 ⇒ 她的 15 条笔记
    //   全部挂在空 recordId 上 ⇒ 旧实现（严格白名单）一个都不命中 ⇒ 列表恒为空。
    expect(noteInScopedSources({ _sourceRecordId: '' }, [JOY_SOURCE_ID])).toBe(true);
  });

  it('🔴 recordId 缺失（undefined）同样按空串处理 ⇒ 可见', () => {
    expect(noteInScopedSources({}, [JOY_SOURCE_ID])).toBe(true);
    expect(noteInScopedSources({ _sourceRecordId: undefined }, [JOY_SOURCE_ID])).toBe(true);
  });

  it('命中我的可见配置 ⇒ 可见', () => {
    expect(noteInScopedSources({ _sourceRecordId: JOY_SOURCE_ID }, [JOY_SOURCE_ID])).toBe(true);
  });

  it('属于**别人**的配置 ⇒ 不可见（不能因为列表里混进了别人的源就放行）', () => {
    expect(noteInScopedSources({ _sourceRecordId: OTHER_SOURCE_ID }, [JOY_SOURCE_ID])).toBe(false);
  });

  it('多条可见配置时，命中任意一条即可见', () => {
    const mine = [JOY_SOURCE_ID, OTHER_SOURCE_ID];
    expect(noteInScopedSources({ _sourceRecordId: JOY_SOURCE_ID }, mine)).toBe(true);
    expect(noteInScopedSources({ _sourceRecordId: OTHER_SOURCE_ID }, mine)).toBe(true);
  });

  it('大小写敏感：recordId 大小写不一致时不误判为命中', () => {
    // 飞书 record id 混合大小写（生产实测 `recvrktwfxK9I1` / `recvtZoT841lPy`）
    // ⇒ 不能做 lower-case 归一化，否则会把两个不同的记录判成同一个
    expect(noteInScopedSources({ _sourceRecordId: JOY_SOURCE_ID.toUpperCase() }, [JOY_SOURCE_ID]))
      .toBe(false);
  });

  it('空 recordId 与「白名单为空」是两件事：前者恒可见，后者不影响该判断', () => {
    // 说明：调用方（listScopedBySources）只在「我至少关联了一条配置」时才会进来，
    // 所以这里不存在「白名单为空却全放行」的风险；空 recordId 代表的是「本人凭证源」。
    expect(noteInScopedSources({ _sourceRecordId: '' }, [])).toBe(true);
    expect(noteInScopedSources({ _sourceRecordId: JOY_SOURCE_ID }, [])).toBe(false);
  });
});

describe('sourceVisibleTo（这条知识库配置我能不能看）', () => {
  const joy = { openId: JOY_OPEN_ID, roles: ['Phase1'] };

  it('归属人ID === 我的 openId ⇒ 可见（单人归属时代的存量语义）', () => {
    expect(sourceVisibleTo(JOY_SOURCE, joy, JOY_USER_ID)).toBe(true);
  });

  it('关联用户含我的 record id ⇒ 可见（多用户关联）', () => {
    expect(sourceVisibleTo({ ownerOpenId: '', linkedUserIds: [JOY_USER_ID] }, joy, JOY_USER_ID))
      .toBe(true);
  });

  it('两者都不命中 ⇒ 不可见（不静默放开）', () => {
    expect(sourceVisibleTo({ ownerOpenId: '', linkedUserIds: [] }, joy, JOY_USER_ID)).toBe(false);
    expect(
      sourceVisibleTo({ ownerOpenId: 'ou_someone_else', linkedUserIds: ['rec_other'] }, joy, JOY_USER_ID),
    ).toBe(false);
  });

  it('系统管理员豁免（否则列表里看不到别人的源）', () => {
    const admin = { openId: 'ou_admin', roles: ['系统管理员'] };
    expect(sourceVisibleTo({ ownerOpenId: '', linkedUserIds: [] }, admin, 'rec_admin')).toBe(true);
  });

  it('🔴 只认 openId / record id，不认姓名（重名必出事）', () => {
    // 拿姓名当 openId 传进来 —— 必须判为不可见
    expect(sourceVisibleTo(JOY_SOURCE, { openId: '刘佳音 | Joy', roles: [] }, '刘佳音 | Joy'))
      .toBe(false);
  });

  it('「关联用户」存的是 record id 而「归属人ID」是 openId —— 两者不可互换', () => {
    // 用她的 record id 去比归属人ID ⇒ 不命中；反之亦然
    expect(sourceVisibleTo({ ownerOpenId: JOY_USER_ID, linkedUserIds: [] }, joy, JOY_USER_ID))
      .toBe(false);
    expect(sourceVisibleTo({ ownerOpenId: '', linkedUserIds: [JOY_OPEN_ID] }, joy, JOY_USER_ID))
      .toBe(false);
  });
});
