/**
 * 「取消关联 / 手工关联」（v14）的守卫测试。
 *
 * 背景（2026-10-01 峰哥）:联系人「丁点儿-万美妗妈妈转介绍」被自动关联到了学生「万美妗」，
 * 但那其实是**妈妈的朋友**在推荐；且系统里**没有取消关联的功能**。
 * 同时要「联系人管理」页能像邮件归档那样**手工关联学生**。
 *
 * 🔴 本文件钉住五类东西（这些都是"写了但不会报错"的静默 bug）：
 *   ① 三态语义：未设置 ⇒ 自动（存量 3706 条都没有这个字段，返回空等于功能全废）
 *   ② 豁免**成对**：有 `isAutoMatchable` 就必须真在 `matchStudents()` 里被调用
 *      —— 只是定义不调用，界面会显示"已忽略"而同步照样覆盖回来
 *   ③ 「没命中不写」：`patch` 里不得再出现 `hit?.name ?? ''` 这种无条件覆盖
 *   ④ 写库门槛：55 分（昵称包含学生姓名）必须落在 advisory 而不是 write
 *   ⑤ 权限复用：不新造权限点（`module:weilingContacts:update` 已存在且成对）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINK_SOURCE,
  LINK_ACTED_AT_FIELD,
  LINK_ACTOR_FIELD,
  LINK_FIELDS,
  LINK_SOURCES,
  LINK_SOURCE_FIELD,
  MATCH_WRITE_MIN_SCORE,
  MODULE_RESOURCES,
  isAutoMatchable,
  linkCellState,
  linkSourceOf,
  matchDecisionOf,
  relinkPatch,
  restoreAutoPatch,
  unlinkPatch,
} from '@acms/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** ⚠️ 三级 `..`：here = `<repo>/apps/api/test` */
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', '..', ...p), 'utf8');

/**
 * 剥掉注释 —— 只给 `not.toContain` 用。
 *
 * 🔴 不剥会假红：新代码里为了解释"以前写的是 `关联学生: hit?.name ?? ''`"
 * 把旧写法**抄进了注释**，于是"不得出现"的断言立刻命中自己的说明文字。
 * （同类坑 2026-09-30 在源码守卫上踩过一轮，这里必须一开始就剥。）
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const SVC = read('apps', 'api', 'src', 'weiling', 'weiling.service.ts');
const SVC_CODE = stripComments(SVC);
const CTRL = read('apps', 'api', 'src', 'weiling', 'weiling.controller.ts');

describe('关联来源三态（默认值必须是"自动"）', () => {
  it('未设置 / 空 / 空白 ⇒ 自动（存量数据的唯一正确解释）', () => {
    expect(linkSourceOf({})).toBe('自动');
    expect(linkSourceOf({ [LINK_SOURCE_FIELD]: '' })).toBe('自动');
    expect(linkSourceOf({ [LINK_SOURCE_FIELD]: '   ' })).toBe('自动');
    expect(linkSourceOf(null)).toBe('自动');
    expect(linkSourceOf(undefined)).toBe('自动');
    expect(DEFAULT_LINK_SOURCE).toBe('自动');
  });

  it('非法值 ⇒ 回落自动，不抛错、不返回空', () => {
    expect(linkSourceOf({ [LINK_SOURCE_FIELD]: '随便写的' })).toBe('自动');
    expect(linkSourceOf({ [LINK_SOURCE_FIELD]: 123 })).toBe('自动');
  });

  it('显式三态原样读出', () => {
    for (const s of LINK_SOURCES) {
      expect(linkSourceOf({ [LINK_SOURCE_FIELD]: s })).toBe(s);
    }
  });

  it('🔴 只有「自动」可被自动匹配覆盖 —— 人工/已忽略一律跳过', () => {
    expect(isAutoMatchable({})).toBe(true);
    expect(isAutoMatchable({ [LINK_SOURCE_FIELD]: '自动' })).toBe(true);
    expect(isAutoMatchable({ [LINK_SOURCE_FIELD]: '人工' })).toBe(false);
    expect(isAutoMatchable({ [LINK_SOURCE_FIELD]: '已忽略' })).toBe(false);
  });
});

describe('写库门槛：55 分那档必须降级为"只提示不写库"', () => {
  it('门槛 = 70（不是 55）', () => {
    expect(MATCH_WRITE_MIN_SCORE).toBe(70);
  });

  it('三档边界', () => {
    expect(matchDecisionOf(98)).toBe('write');
    expect(matchDecisionOf(90)).toBe('write');
    expect(matchDecisionOf(70)).toBe('write');
    // 69 / 55 ⇒ 有候选但不写库
    expect(matchDecisionOf(69)).toBe('advisory');
    expect(matchDecisionOf(55)).toBe('advisory');
    expect(matchDecisionOf(1)).toBe('advisory');
  });

  it('0 / 空 / 非法 ⇒ none（没匹配上）', () => {
    expect(matchDecisionOf(0)).toBe('none');
    expect(matchDecisionOf('')).toBe('none');
    expect(matchDecisionOf(null)).toBe('none');
    expect(matchDecisionOf(undefined)).toBe('none');
    expect(matchDecisionOf('abc')).toBe('none');
    expect(matchDecisionOf(-1)).toBe('none');
  });

  it('🔴 「昵称包含学生姓名」= 55 分这一档**不再**进入 write', () => {
    // 与 weiling.service.ts 里 bestMatch 的 reason 逐字一致；对不上说明那边改了分数而没同步这里
    expect(SVC).toContain("consider(s, 55, '昵称包含学生姓名')");
    expect(matchDecisionOf(55)).toBe('advisory');
  });
});

describe('取消关联要写的字段', () => {
  const nowMs = 1_790_000_000_000;

  it('🔴 关联学生 与 关联学生ID **一起**清（只清一个 = 悬空壳值）', () => {
    const p = unlinkPatch({ nowMs, reason: '误关联', prevReason: '昵称包含学生姓名', prevScore: 55 });
    expect(p['关联学生']).toBe('');
    expect(p['关联学生ID']).toBe('');
    expect(p['匹配置信度']).toBe(0);
    expect(p[LINK_SOURCE_FIELD]).toBe('已忽略');
  });

  it('原依据保留在文本里（以后回看知道它当初靠什么匹配上的）', () => {
    const p = unlinkPatch({ nowMs, prevReason: '昵称包含学生姓名', prevScore: 55, reason: '妈妈的朋友转介绍' });
    const reason = String(p['匹配依据']);
    expect(reason).toContain('昵称包含学生姓名');
    expect(reason).toContain('55');
    expect(reason).toContain('妈妈的朋友转介绍');
  });

  it('原因缺省时兜底为「误关联」，不留空串', () => {
    const p = unlinkPatch({ nowMs });
    expect(String(p['匹配依据'])).toContain('误关联');
    expect(String(p['匹配依据'])).not.toContain('undefined');
    expect(String(p['匹配依据'])).not.toContain('null');
  });

  it('操作人取不到时写空串，不写 "undefined"', () => {
    const p = unlinkPatch({ nowMs });
    expect(p[LINK_ACTOR_FIELD]).toBe('');
    expect(p[LINK_ACTED_AT_FIELD]).toBe(nowMs);
  });

  it('⚠️ 不动 匹配时间（它的语义是"算法最后一次匹配"，人工操作写进去会变成第三种含义）', () => {
    const p = unlinkPatch({ nowMs });
    expect(Object.prototype.hasOwnProperty.call(p, '匹配时间')).toBe(false);
  });
});

describe('手工关联 / 改指要写的字段', () => {
  const nowMs = 1_790_000_000_000;

  it('写入 id + 展示名（PG 没有双向自动回填，两边都要写）', () => {
    const p = relinkPatch({ nowMs, studentId: 'recvtZbIHsNMxJ', studentName: '万美妗', actor: '峰哥' });
    expect(p['关联学生ID']).toBe('recvtZbIHsNMxJ');
    expect(p['关联学生']).toBe('万美妗');
    expect(p['匹配置信度']).toBe(100);
    expect(p['匹配依据']).toBe('人工指定');
    expect(p[LINK_SOURCE_FIELD]).toBe('人工');
    expect(p[LINK_ACTOR_FIELD]).toBe('峰哥');
  });

  it('手工指定后不会被自动匹配覆盖（来源=人工）', () => {
    const p = relinkPatch({ nowMs, studentId: 'x', studentName: 'Y' });
    expect(isAutoMatchable({ [LINK_SOURCE_FIELD]: p[LINK_SOURCE_FIELD] })).toBe(false);
  });
});

describe('恢复自动匹配（否则「已忽略」是单向门）', () => {
  it('只改来源，不动关联字段', () => {
    const p = restoreAutoPatch({ nowMs: 1_790_000_000_000, actor: '峰哥' });
    expect(p[LINK_SOURCE_FIELD]).toBe('自动');
    for (const f of LINK_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(p, f)).toBe(false);
    }
  });

  it('恢复之后重新可被自动匹配覆盖', () => {
    const p = restoreAutoPatch({ nowMs: 1 });
    expect(isAutoMatchable({ [LINK_SOURCE_FIELD]: p[LINK_SOURCE_FIELD] })).toBe(true);
  });
});

describe('列表单元格状态', () => {
  it('已忽略且无关联 ⇒ 显示"已忽略关联"（必须能看出"为什么一直没关联"）', () => {
    const st = linkCellState({ [LINK_SOURCE_FIELD]: '已忽略' });
    expect(st.ignored).toBe(true);
    expect(st.linked).toBe(false);
  });

  it('已关联 ⇒ linked', () => {
    const st = linkCellState({ 关联学生ID: 'rec1', 关联学生: '万美妗' });
    expect(st.linked).toBe(true);
    expect(st.ignored).toBe(false);
    expect(st.studentName).toBe('万美妗');
  });

  it('🔴 已忽略但**仍有关联**（先取消再改指失败的中间态）不算 ignored', () => {
    const st = linkCellState({ [LINK_SOURCE_FIELD]: '已忽略', 关联学生ID: 'rec1', 关联学生: '万美妗' });
    expect(st.linked).toBe(true);
    expect(st.ignored).toBe(false);
  });
});

describe('🔴 源码守卫：豁免判据必须真被调用（定义不调用 = 静默失效）', () => {
  it('matchStudents() 用同一份 isAutoMatchable 做跳过判据', () => {
    const from = SVC_CODE.indexOf('async matchStudents(');
    expect(from).toBeGreaterThan(-1);
    // 到下一个方法定义为止（⚠️ 用代码锚点切片，不用注释——注释已被 strip 掉）
    const to = SVC_CODE.indexOf('private async loadContactForLink(', from);
    const body = SVC_CODE.slice(from, to > from ? to : from + 9000);
    expect(body).toContain('isAutoMatchable(');
    /*
     * 跳过必须用 `continue`，**不能用 `return`** —— 这个循环跑的是全部 3700 条联系人，
     * `return` 会在第一条被豁免的联系人处**退出整个匹配**，后面全部不再更新
     * （而且不报错，只是"匹配数变少了"）。
     * ⚠️ 判据要容忍两种写法（`if (x) continue;` 与 `if (x) { …; continue; }`）：
     *    写成单行正则会在加一行日志之后就假红。
     */
    const at = body.indexOf('if (!isAutoMatchable(');
    expect(at, '必须存在 if (!isAutoMatchable(...)) 守卫').toBeGreaterThan(-1);
    const guard = body.slice(at, at + 200);
    expect(guard, '豁免分支里必须是 continue（不是 return）').toContain('continue');
    expect(guard, '豁免分支里不能是 return —— 那会退出整个匹配循环').not.toContain('return');
  });

  it('🔴 patch 里不得再出现 `hit?.name ?? \'\'` 这种无条件覆盖（没命中就不写）', () => {
    expect(SVC_CODE).not.toContain("关联学生: hit?.name ?? ''");
    expect(SVC_CODE).not.toContain("关联学生ID: hit?.id ?? ''");
  });

  it('取消/改指/恢复三个动作都落在同一个服务方法上（别在前端拼字段）', () => {
    expect(SVC_CODE).toContain('async unlinkContact(');
    expect(SVC_CODE).toContain('async relinkContact(');
    expect(SVC_CODE).toContain('async restoreAutoLink(');
  });

  it('controller 三个路由都存在，且**静态段不靠 :id 兜**（`:id/unlink` 形式，排在参数路由之后也不能被吃）', () => {
    expect(CTRL).toContain("'contacts/:id/unlink'");
    expect(CTRL).toContain("'contacts/:id/relink'");
    expect(CTRL).toContain("'contacts/:id/restore-auto'");
  });
});

describe('权限：复用「联系人管理」的编辑权限，不新造点', () => {
  it('module:weilingContacts:update 在模块目录里存在且含 update 动作', () => {
    const res = MODULE_RESOURCES.find((r) => r.key === 'weilingContacts');
    expect(res, 'weilingContacts 资源必须存在（取消关联复用它）').toBeTruthy();
    expect(res?.actions).toContain('update');
  });
});
