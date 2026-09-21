import { describe, expect, it } from 'vitest';
import { defaultFollowupOwner } from '@acms/contracts';

/**
 * 「跟进人 / 负责人」在笔记转换新建时的默认值口径（2026-09-21 峰哥定档）。
 *
 * 招生跟进 / 校友长期跟进 / 实践活动 三个模块共用这一份判据 ——
 * 用测试锁住它，免得日后有人在某个模块里"顺手改一下"，
 * 变成「同一个动作在两个模块归属到不同人」这种线上查不出来的错。
 */

describe('defaultFollowupOwner（笔记转换时负责人记谁）', () => {
  it('自己录的笔记 ⇒ 记当前登录用户', () => {
    expect(defaultFollowupOwner({ userName: '孙旭峰', noteOwner: '孙旭峰' })).toBe('孙旭峰');
  });

  it('🔴 代转别人的笔记（笔记归属人 ≠ 登录用户）⇒ 记**笔记归属人**', () => {
    // 峰哥 2026-09-21 明确的口径：管理员/同事代转时，负责人不能写成自己
    expect(defaultFollowupOwner({ userName: '孙旭峰', noteOwner: '吴洁｜Joyce' })).toBe('吴洁｜Joyce');
  });

  it('笔记归属人取不到（历史笔记没打 _owner）⇒ 回退登录用户', () => {
    expect(defaultFollowupOwner({ userName: '孙旭峰', noteOwner: '' })).toBe('孙旭峰');
    expect(defaultFollowupOwner({ userName: '孙旭峰' })).toBe('孙旭峰');
  });

  it('两者都取不到 ⇒ 空串（不编造人名）', () => {
    expect(defaultFollowupOwner({})).toBe('');
    expect(defaultFollowupOwner({ userName: '', noteOwner: '' })).toBe('');
    // 前后空格不算不同的人
    expect(defaultFollowupOwner({ userName: ' 孙旭峰 ', noteOwner: '孙旭峰' })).toBe('孙旭峰');
  });

  it('只有归属人、没有登录用户信息 ⇒ 用归属人（宁可记别人，也不要空着）', () => {
    expect(defaultFollowupOwner({ noteOwner: '吴洁｜Joyce' })).toBe('吴洁｜Joyce');
  });
});
