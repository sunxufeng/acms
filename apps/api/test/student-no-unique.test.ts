/**
 * 学籍号唯一性（2026-09-30 峰哥：「学籍号不能重复，学生档案保存时需要有提醒」）的守卫测试。
 *
 * 🔴 本文件钉住四类东西：
 *   ① **字段名逐字一致** —— 学籍号的真名是 `学籍号（脱敏）`（带全角括号）。
 *      写成 `学籍号` 会**恒为空且不报错**，本仓已经有**两处**这样的老 bug
 *      （`ai/lib/tools/studentQuery.ts`、`app/portal/page.tsx`），本文件连这两处一起守。
 *   ② 后端在**写库前**查重，且改学籍号时**排除自己**（否则没改这一栏也会自撞）。
 *   ③ 查重发生在 `stripProtected` **之后**（低密级用户那一栏会被静默删除，
 *      这种写入根本不碰学籍号，不该报重复）。
 *   ④ 前端只做"早提醒"，闸门在后端（接口可直连）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..', '..');
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');

/** 学籍号字段的准确中文名（前后端两份声明都必须等于它） */
const FIELD = '学籍号（脱敏）';

/** 剥注释后再断言（本仓反复踩到"命中的是自己注释里的反例写法"） */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/[^\n]*/g, '');

const rawSvc = read('apps', 'api', 'src', 'student', 'student.service.ts');
const svc = strip(rawSvc);
const ctl = strip(read('apps', 'api', 'src', 'student', 'student.controller.ts'));
const form = strip(read('apps', 'web', 'components', 'StudentForm.tsx'));
const api = strip(read('apps', 'web', 'lib', 'api.ts'));

describe('学籍号 · 字段名一致性', () => {
  it('后端常量 == 前端常量 == `学籍号（脱敏）`（逐字，含全角括号）', () => {
    expect(svc).toContain(`export const STUDENT_NO_FIELD = '${FIELD}';`);
    expect(form).toContain(`const STUDENT_NO_FIELD = '${FIELD}';`);
  });

  it('🔴 真正读学生字段的那批文件里不得再出现 `学籍号` 当字段名（两处老 bug 不许复活）', () => {
    // ⚠️ 这里刻意**不是全仓扫描**：本机沙箱读一个文件约 160ms，全仓 550 个文件要 ~90 秒，
    //    放进单测会让全量测试慢到没人愿意跑（接着就会被绕过）。
    //    全仓扫描在 `scripts/field_name_lint.mjs`（提交前跑），本用例扫"真正读学生字段的那批目录"。
    const DIRS = [
      'apps/api/src/student',
      'apps/api/src/ai/lib/tools',
      'apps/api/src/portal',
      'apps/api/src/student-auth',
      'apps/api/src/parent',
      'apps/api/src/mini-program',
      'apps/api/src/wechat-binding',
      'apps/api/src/weiling',
    ];
    const SINGLES = [
      'apps/web/app/portal/page.tsx',
      'apps/web/components/StudentForm.tsx',
      'apps/web/lib/api.ts',
    ];
    // 判据与本仓的 `scripts/field_name_lint.mjs` 一致（窄、零误报）：
    // ① 带引号的字段名 ② 点号属性访问。**不查** `学籍号: xxx` —— 那与"展示标签"无法区分。
    const bad = [/['"]学籍号['"]/, /\.学籍号(?!（)/];
    const offenders: string[] = [];
    for (const d of DIRS) {
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(path.join(ROOT, d), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !/\.(ts|tsx)$/.test(e.name)) continue;
        const rel = path.join(d, e.name);
        const lines = strip(read(rel)).split('\n');
        lines.forEach((l, i) => {
          if (bad.some((re) => re.test(l))) offenders.push(`${rel}:${i + 1}  ${l.trim().slice(0, 120)}`);
        });
      }
    }
    for (const f of SINGLES) {
      const lines = strip(read(f)).split('\n');
      lines.forEach((l, i) => {
        if (bad.some((re) => re.test(l))) offenders.push(`${f}:${i + 1}  ${l.trim().slice(0, 120)}`);
      });
    }
    expect(
      offenders,
      `这些地方把「学籍号」当字段名了（真名是「${FIELD}」，取不到值且不报错）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('全仓扫描脚本存在（覆盖上面那批之外的目录，提交前跑）', () => {
    const script = read('scripts', 'field_name_lint.mjs');
    expect(script).toContain('field_name_lint');
    for (const d of ['apps/api/src', 'apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages']) {
      expect(script, `lint 脚本没覆盖 ${d}`).toContain(d);
    }
    expect(script).toContain(FIELD);
  });
});

describe('学籍号 · 后端硬拦', () => {
  it('create 与 update **都会**查重', () => {
    expect(svc).toContain('assertStudentNoUnique(fields)');
    expect(svc).toContain('assertStudentNoUnique(fields, id)');
  });

  it('🔴 查重在写库**之前**（失败时库里不能已经多了一条）', () => {
    const body = svc.slice(svc.indexOf('async create(user: SessionUser, dto: CreateStudentDto)'));
    const iCheck = body.indexOf('assertStudentNoUnique(fields)');
    const iWrite = body.indexOf('this.base.create(TABLE, fields)');
    expect(iCheck).toBeGreaterThan(-1);
    expect(iWrite).toBeGreaterThan(-1);
    expect(iCheck, '查重必须在 base.create 之前').toBeLessThan(iWrite);
  });

  it('🔴 查重在 `stripProtected` **之后**（低密级用户那一栏会被删掉，不该报重复）', () => {
    const body = svc.slice(svc.indexOf('async create(user: SessionUser, dto: CreateStudentDto)'));
    const iStrip = body.indexOf('stripProtected');
    const iCheck = body.indexOf('assertStudentNoUnique(fields)');
    expect(iStrip).toBeGreaterThan(-1);
    expect(iStrip).toBeLessThan(iCheck);
  });

  it('update 排除自己（否则"保存时没改这一栏"也会自撞）', () => {
    const body = svc.slice(svc.indexOf('async update(user: SessionUser, id: string'));
    expect(body).toContain('assertStudentNoUnique(fields, id)');
  });

  it('查重失败返回 **400**（不是 500）', () => {
    const body = strip(svc.slice(svc.indexOf('private async assertStudentNoUnique(')));
    expect(body).toContain('BadRequestException');
    expect(body).toContain('DUPLICATE_STUDENT_NO');
    expect(body).not.toContain('throw new Error(');
  });

  it('🔴 空学籍号不报重复（不是必填字段，多人不填是合法状态）', () => {
    const body = strip(svc.slice(svc.indexOf('private async assertStudentNoUnique(')));
    expect(body).toContain("if (!target) return;");
  });

  it('对「前后空白」宽容（库里存量值来自手填/CSV，不保证被 trim 过）', () => {
    const body = strip(svc.slice(svc.indexOf('async findByStudentNo(')));
    expect(body).toContain('.trim()');
    // 等值查询会漏判 `"A001 "` vs `"A001"` ⇒ 注释里必须说明为什么是扫表
    // ⚠️ 这条断言读**原始**源码：`svc` 是剥过注释的，查注释里的字必须用原文
    expect(rawSvc).toContain('全表扫');
  });
});

describe('学籍号 · 接口', () => {
  it('🔴 预检路由是**静态路由**，排在 `@Get(\':id\')` 之前（否则被当成学生 id）', () => {
    const iRoute = ctl.indexOf("@Get('student-no-taken')");
    const iId = ctl.indexOf("@Get(':id')");
    expect(iRoute, '没有预检路由').toBeGreaterThan(-1);
    expect(iId).toBeGreaterThan(-1);
    expect(iRoute).toBeLessThan(iId);
  });

  it('预检只判 `students:read`，且只回占用者姓名/编号（**不回学籍号本身**）', () => {
    const body = strip(svc.slice(svc.indexOf('async checkStudentNo(')));
    expect(body).toContain("requireModule(user, 'students', 'read')");
    expect(body).toContain('holder');
    // 返回值里不得出现学籍号字段本身的值
    expect(body).not.toContain('studentNoValue');
  });

  it('前端路径与后端一致，且带 excludeId', () => {
    expect(api).toContain("`/students/student-no-taken?value=");
    expect(api).toContain('excludeId=');
  });
});

describe('学籍号 · 前端提醒（闸门在后端，前端只管早说）', () => {
  it('表单查的是服务端（不在前端拿列表比对 —— 低密级用户拿到的是 ●●●）', () => {
    expect(form).toContain('api.checkStudentNo(noValue, studentId)');
  });

  it('有防抖（不然每敲一个字符就打一次接口）', () => {
    const body = strip(form.slice(form.indexOf('const noValue = String(values[STUDENT_NO_FIELD]')));
    expect(body).toContain('setTimeout');
    expect(body).toContain('clearTimeout');
    expect(body).toContain('500');
  });

  it('提交时拦住（`noState.reason` 非空不给提交）', () => {
    const body = strip(form.slice(form.indexOf('const handleSubmit = async (e: React.FormEvent)')));
    expect(body).toContain('noState.reason');
    expect(body.indexOf('return;')).toBeLessThan(body.indexOf('setSaving(true)'));
  });

  it('只读态不查（详情页是只读的，查了也没用）', () => {
    const body = strip(form.slice(form.indexOf('const noValue = String(values[STUDENT_NO_FIELD]')));
    expect(body).toContain('if (readOnly)');
  });

  it('预检接口失败**不拦人**（别拿服务端小故障挡住录入；真正的闸门在后端）', () => {
    const body = strip(form.slice(form.indexOf('const noValue = String(values[STUDENT_NO_FIELD]')));
    expect(body).toContain('catch');
  });

  it('文案 key 已加（漏 key 时 next-intl 不报错，会把 key 原样显示）', () => {
    const zh = JSON.parse(read('apps', 'web', 'messages', 'zh.json')) as Record<string, Record<string, string>>;
    const en = JSON.parse(read('apps', 'web', 'messages', 'en.json')) as Record<string, Record<string, string>>;
    expect(zh['students']?.['studentNoChecking']).toBeTruthy();
    expect(en['students']?.['studentNoChecking']).toBeTruthy();
    expect(form).toContain("ts('studentNoChecking')");
  });
});
