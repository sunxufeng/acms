import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ARETE_ENROLL_YEAR_FIELD,
  ENROLL_MONTH_FIELD,
  ENROLL_YEAR_FIELD,
} from '@acms/contracts';

/**
 * 「自动带出」**接线**的守卫测试（源码级）。
 *
 * 规则本身由 `student-enroll.test.ts` 覆盖；这份文件锁的是**接线**：
 * 规则算得再对，只要没挂在「入学年月」这个字段的 onChange 上，界面上就是**静默不生效**
 * （2026-09-22 当天刚踩过一次同源事故：招生跟进「选联系人带出学生姓名」的 patch
 * 被写在了「学生姓名」列上 ⇒ 功能自上线起从未生效，而 typecheck / 接口 / 构建全不报错）。
 *
 * 为什么用「读源码 + 断言关键字」这种粗糙手法：这条接线要真验需要真人在浏览器里点一下
 * （下拉 onChange），仓库里没有浏览器测试环境；而它能失效的方式很有限 ——
 * 常量被改、分支被删、字段定义被挪走。三个都在这份断言里。
 * ⚠️ 它只能证明「接线还在」，不能替代人工点一次。
 */

const FORM = resolve(__dirname, '../../../apps/web/components/StudentForm.tsx');
const src = readFileSync(FORM, 'utf-8');

describe('StudentForm 的自动带出接线', () => {
  it('🔴 「入学年月」的字段定义上挂了 hintKey（用户能看到"会自动带出"的说明）', () => {
    const def = new RegExp(
      `key:\\s*'${ENROLL_MONTH_FIELD}'[^}]*hintKey:\\s*'enrollAutoHint'`,
    );
    expect(src).toMatch(def);
  });

  it('🔴 select 的 onChange 里按「入学年月」分支，并调用 deriveEnrollFields', () => {
    expect(src).toMatch(new RegExp(`f\\.key\\s*===\\s*ENROLL_MONTH_FIELD`));
    expect(src).toContain('deriveEnrollFields(');
  });

  it('🔴 用常量而不是手写字符串比较（手写会和字段定义脱钩）', () => {
    // 反面：onChange 里直接写 '入学年月' 字面量比较 —— 字段改名后会静默失效
    expect(src).not.toMatch(/f\.key\s*===\s*'入学年月'/);
    // 三个字段名常量都必须从 contracts 导入
    for (const c of ['ENROLL_MONTH_FIELD', 'ENROLL_YEAR_FIELD', 'ARETE_ENROLL_YEAR_FIELD']) {
      expect(src).toContain(c);
    }
  });

  it('🔴 带出的两个字段都真的被 setField（只算不写 = 白算）', () => {
    expect(src).toMatch(new RegExp(`setField\\(\\s*ENROLL_YEAR_FIELD`));
    expect(src).toMatch(new RegExp(`setField\\(\\s*ARETE_ENROLL_YEAR_FIELD`));
  });

  it('字段名常量与字典/表单口径一致', () => {
    expect(ENROLL_MONTH_FIELD).toBe('入学年月');
    expect(ENROLL_YEAR_FIELD).toBe('入学年份');
    expect(ARETE_ENROLL_YEAR_FIELD).toBe('Arete入学年');
  });
});
