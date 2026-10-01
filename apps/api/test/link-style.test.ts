/**
 * 「表格内超链接统一（方案 B）」的源码守卫（2026-10-01 峰哥拍板）。
 *
 * 背景：全站「表格里可点的文字」曾有 **7 种实现 / 5 种长相**，其中 2 处是**伪链接**
 * （长得和真链接一模一样、却根本点不动），还有一份为这件事准备好的 CSS `.link-cell`
 * 从头到尾**没人引用**（死代码）。方案 B 就是把这套收口成一份。
 *
 * 🔴 本文件钉住的东西，都是「改错了也不会报错」的：
 *   ① `.link-cell` 必须活着且带 `:focus-visible`（否则换真 `<a>` 的收益全没了）
 *      —— 且**不得再有 `font-size`**（原定义是 12px，比表格正文 14px 小一圈）
 *   ② `openRecord` 列不能再渲染成裸 `<span>`（键盘够不着）
 *   ③ 已知的 2 处伪链接文件里不得再出现链接色
 *   ④ `studentLink` 列落点优先学生档案、样式收口到类名
 *   ⑤ 跳转箭头只有一个来源（`lib/uiGlyphs.ts`）
 *
 * ⚠️ 这里**只扫「真正相关的那批文件」**（8 个），不做全仓扫描 ——
 *    沙箱里 `grep -r` 扫 web 源码要 **1 分 20 秒**（2026-10-01 实测），
 *    放进单测必然偶发超时（退出码 137），而"守卫变噪音就会被绕过"。
 *    全仓唯一性检查（箭头 / .link-cell 是否真被用上）放在
 *    `scripts/link_style_lint.mjs`，提交前跑。
 *
 * ⚠️ 判据要**窄到零误报**：宽判据（比如"凡 var(--accent) 的 span 都算伪链接"）
 *    会命中合法的展示用法，然后天天红 ⇒ 加豁免 ⇒ 守卫失效。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..', '..');

const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');

/** 剥注释 —— 给 `not.toContain` 用（否则会命中我们自己写的说明文字） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 本次方案 B 涉及的全部文件（全仓扫描见 scripts/link_style_lint.mjs） */
const FILES = [
  'apps/web/components/CrudPage.tsx',
  'apps/web/components/WeilingEnrollModal.tsx',
  'apps/web/components/SourceFollowupModal.tsx',
  'apps/web/app/source-followups/columns.tsx',
  'apps/web/app/meeting-minutes/columns.tsx',
  'apps/web/app/student-support/page.tsx',
  'apps/web/app/weiling-contacts/page.tsx',
  'apps/web/lib/uiGlyphs.ts',
] as const;

describe('① .link-cell 必须活着，且不能带 font-size', () => {
  const css = read('apps', 'web', 'app', 'globals.css');

  it('定义了 .link-cell / :hover / :focus-visible 三条', () => {
    expect(css).toContain('.link-cell {');
    expect(css).toContain('.link-cell:hover');
    expect(css).toContain('.link-cell:focus-visible');
  });

  it('🔴 不得再有 font-size —— 它会让链接文字比同列的 14px 小一圈', () => {
    const from = css.indexOf('.link-cell {');
    const to = css.indexOf('}', from);
    const block = css.slice(from, to > from ? to : from + 400);
    expect(block).not.toContain('font-size');
  });

  it('🔴 :focus-visible 必须有可见轮廓（换真 <a> 的全部收益就在这）', () => {
    const at = css.indexOf('.link-cell:focus-visible');
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, at + 200);
    expect(block).toContain('outline');
  });

  it('必须是 accent 色 + 600 字重（方案 B 的两个关键取值）', () => {
    const from = css.indexOf('.link-cell {');
    const block = css.slice(from, from + 400);
    expect(block).toContain('var(--accent)');
    expect(block).toContain('font-weight: 600');
  });
});

describe('② openRecord 列必须渲染成真链接（不能是裸 span）', () => {
  const code = stripComments(read('apps', 'web', 'components', 'CrudPage.tsx'));

  /**
   * `c.openRecord` 在文件里出现**三次**：
   *   · 前两次是 `<td onClick={c.openRecord ? …}>` 与 `style={c.openRecord ? …}`（整格可点的热区）
   *   · **最后一次才是单元格内容的分支**（要查的就是它）
   *
   * 🔴 必须用 `lastIndexOf`：用 `indexOf` 会框住 `<td>` 那一段，
   *    于是断言**看着通过、其实查的是隔壁代码**（2026-10-01 实测：
   *    `stopPropagation` 那条就是被 `inlineSwitch` 里的同名字符串蒙过去的）。
   *    同类坑 2026-09-30 在查 `@Get` 时踩过一次，这里必须一开始就避开。
   */
  const cellAt = code.lastIndexOf('c.openRecord');
  const cellBlock = code.slice(cellAt, cellAt + 1800);

  it('定位正确：确实取到了单元格内容分支（而不是 td 的热区）', () => {
    expect(code.split('c.openRecord').length - 1).toBeGreaterThanOrEqual(2);
    // 切到的必须是"渲染单元格"那一段：它渲染 cellText，且不再是 td 的属性写法
    expect(cellBlock).toContain('cellText(');
    expect(cellBlock).not.toContain('onClick={c.openRecord');
    expect(cellBlock).toContain('link-cell');
  });

  it('🔴 不得再出现 openRecord 的裸 span 内联 accent+700', () => {
    // 这是"看着能点、键盘够不着"的指纹（2026-09-19 只是统一了长相，没统一语义）
    expect(code).not.toContain("style={{ color: 'var(--accent)', fontWeight: 700 }}>{cellText(");
  });

  it('openRecord 分支里有 className="link-cell" 的链接与按钮', () => {
    expect(cellBlock).toContain('link-cell');
    expect(cellBlock).toContain('<Link');
    // 没有 detailHref 的模块用 <button>（href="#" 会在状态栏显示假地址）
    expect(cellBlock).toContain('<button');
  });

  it('🔴 链接要 stopPropagation —— 否则格子的 onClick 会再跳一次（同一目标双导航）', () => {
    expect(cellBlock).toContain('stopPropagation');
  });

  it('🔴 studentLink 列不得再内联 accent+600（样式要收口到类名）', () => {
    expect(code).not.toContain("color: 'var(--accent)', fontWeight: 600");
  });

  it('studentLink 落点优先学生档案（`studentLinkTarget` 先看 __studentRefId）', () => {
    const at = code.indexOf('const studentLinkTarget = useCallback(');
    expect(at, '必须存在 studentLinkTarget（落点统一到学生档案）').toBeGreaterThan(-1);
    const block = code.slice(at, at + 500);
    expect(block).toContain('STUDENT_REF_KEY');
    expect(block).toContain('studentHref');
  });
});

describe('③ 已知的 2 处伪链接：链接色必须消失', () => {
  const cases: [string, string][] = [
    ['apps/web/app/source-followups/columns.tsx', '关联学生'],
    ['apps/web/app/meeting-minutes/columns.tsx', '可见部门'],
  ];

  for (const [file, what] of cases) {
    it(`🔴 ${file} 里不得再有 accent 色（${what} 点不动，上色就是伪链接）`, () => {
      expect(stripComments(read(...file.split('/')))).not.toContain('var(--accent)');
    });
  }
});

describe('④ 跳转箭头只有一个来源', () => {
  it('lib/uiGlyphs.ts 定义了 JUMP_ARROW / STEP_ARROW', () => {
    const g = read('apps', 'web', 'lib', 'uiGlyphs.ts');
    expect(g).toContain("export const JUMP_ARROW = '↗'");
    expect(g).toContain("export const STEP_ARROW = '→'");
  });

  it('🔴 涉及的文件里不得直接打 ↗ 字符（一律写 {JUMP_ARROW}）', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      if (f.endsWith('uiGlyphs.ts')) continue; // 常量定义自己当然有这个字符
      if (stripComments(read(...f.split('/'))).includes('↗')) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});

describe('⑤ .link-cell 真被用上（防它又变回死代码）', () => {
  it('CrudPage 与至少两个页面在用 className="link-cell"', () => {
    const users = FILES.filter((f) => read(...f.split('/')).includes('className="link-cell"'));
    expect(users).toContain('apps/web/components/CrudPage.tsx');
    expect(users.length).toBeGreaterThanOrEqual(3);
  });

  it('整行可点的看板：学生名也走 link-cell（否则名字纯黑、看不出能点）', () => {
    const p = stripComments(read('apps', 'web', 'app', 'student-support', 'page.tsx'));
    expect(p).toContain('className="link-cell"');
    // 整行可点的 tr 必须可聚焦（只会用键盘的人原本完全进不去）
    expect(p).toContain('tabIndex={0}');
  });
});
