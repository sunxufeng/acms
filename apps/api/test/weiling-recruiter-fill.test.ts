/**
 * 「联系人归属人 → 学生档案招生负责老师」默认值的口径守卫（2026-09-26 峰哥需求）。
 *
 * 需求原话：「联系人和学生档案关联时，已经知道招生老师是谁了，这个联系人映射的 acms 的用户
 * 就是招生老师，默认关联联系人和学生的时候，学生档案里的招生老师就默认填写这个值，用户可修改」。
 *
 * 链路（两跳，都用既有数据，不新增表）：
 *   联系人.`归属人`（文本，值形如「致极学院-曹老师｜Dainel」）
 *     ── 按**完全相同**的文本 ──▶ 「归属人映射」`ACMS用户`（用户表 record id）──▶ 用户表 `飞书 Open ID`
 *     ──▶ 学生档案 `招生负责老师`（**存的就是 open_id 文本**，见 `StudentService.toWriteFields`）
 *
 * 这一整套是「静默生效 / 静默不生效」型的需求，所以用断言钉住四条硬口径：
 *   ① 只补空（老师可以自由改，不覆盖用户在 UI 上的选择）
 *   ② 自动同步只在新建立关联时补（否则老师手工清空后会被同步填回来 —— "数据自己变"）
 *   ③ 归属人用精确匹配（模糊匹配会把「刘老师」错配到「刘老师 | Yvonne」）
 *   ④ 同一学生被多个联系人指向时结果**确定可复现**（纯函数 `preferRecruiterCandidate`）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preferRecruiterCandidate, type RecruiterCandidate } from '../src/weiling/weiling.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const svc = read('api', 'src', 'weiling', 'weiling.service.ts');
const ctrl = read('api', 'src', 'weiling', 'weiling.controller.ts');
const apiTs = read('web', 'lib', 'api.ts');
const contactsPage = read('web', 'app', 'weiling-contacts', 'page.tsx');

const cand = (openId: string, score: number, contactId: string): RecruiterCandidate => ({
  openId,
  score,
  contactId,
});

describe('preferRecruiterCandidate（同一学生多联系人时怎么选）', () => {
  it('没有候选时直接用新的', () => {
    expect(preferRecruiterCandidate(undefined, cand('ou_a', 70, 'c1'))).toBe(true);
  });

  it('置信度高者胜（父母各一条线索时取可信的那条）', () => {
    expect(preferRecruiterCandidate(cand('ou_a', 70, 'c1'), cand('ou_b', 90, 'c2'))).toBe(true);
    expect(preferRecruiterCandidate(cand('ou_a', 90, 'c1'), cand('ou_b', 70, 'c2'))).toBe(false);
  });

  it('🔴 置信度并列时按 contactId 定序 —— 保证每次同步结果一致（否则"招生负责老师自己变了"）', () => {
    expect(preferRecruiterCandidate(cand('ou_a', 80, 'c9'), cand('ou_b', 80, 'c1'))).toBe(true);
    expect(preferRecruiterCandidate(cand('ou_a', 80, 'c1'), cand('ou_b', 80, 'c9'))).toBe(false);
    // 同一个联系人重复出现（分页重叠等）不算替换
    expect(preferRecruiterCandidate(cand('ou_a', 80, 'c1'), cand('ou_a', 80, 'c1'))).toBe(false);
  });
});

describe('接线守卫：补招生负责老师', () => {
  it('① 只补空：学生已有值就跳过（不覆盖老师改过的）', () => {
    expect(svc).toContain("const cur = String(f['招生负责老师'] ?? '').trim();");
    expect(svc).toContain('if (cur) continue; // 只补空');
  });

  it('② 自动同步默认只在新建立关联时补；显式维护动作才扫存量', () => {
    expect(svc).toContain("opts: { fillRecruiter?: 'new' | 'always' } = {}");
    expect(svc).toContain("const fillMode = opts.fillRecruiter ?? 'new';");
    expect(svc).toContain('const isNewLink = prevStudentId !== hit.id;');
    expect(svc).toContain("if (ownerOpenId && (isNewLink || fillMode === 'always')) {");
    // 同步流程里不带参 ⇒ 走 'new'
    expect(svc).toContain('void this.matchStudents();');
  });

  it('③ 归属人按**完全相同**的文本匹配，且终点是 open_id 而不是用户 record id', () => {
    expect(svc).toContain("ownerOpenIds.get(String(f['归属人'] ?? '').trim())");
    expect(svc).toContain('const ownerOpenIds = await this.ownerOpenIdIndex();');
    // 两跳：用户表拿 open_id、映射表拿记录 id
    expect(svc).toContain("String(f['飞书 Open ID'] ?? '').trim()");
    expect(svc).toContain("linkIds(f['ACMS用户'])[0]");
    expect(svc).toContain("const owner = String(f['卫瓴归属人'] ?? '').trim();");
  });

  it('④ 写库目标就是学生档案的「招生负责老师」，且值相同时不写（避免无意义的 updated_at）', () => {
    expect(svc).toContain("sql.update(TABLES.studentProfile.tableId, studentId, { 招生负责老师: hit.openId })");
    expect(svc).toContain('if (cur === hit.openId) continue;');
  });

  it('控制器有 fill-recruiter 路由，且权限与其它维护动作一致', () => {
    const i = ctrl.indexOf("@Post('fill-recruiter')");
    expect(i, "找不到 @Post('fill-recruiter')").toBeGreaterThan(-1);
    const seg = ctrl.slice(i, i + 900);
    expect(seg).toContain("'module:weilingContacts:update'");
    expect(seg).toContain("this.svc.matchStudents({ fillRecruiter: 'always' })");
    expect(seg).not.toContain('HttpStatus.OK'); // 别把权限判丢了
  });

  it('前端：api 有 fillWeilingRecruiter，页面有按钮与结果提示', () => {
    expect(apiTs).toContain("'/weiling/fill-recruiter'");
    expect(apiTs).toContain('fillWeilingRecruiter');
    expect(contactsPage).toContain('api.fillWeilingRecruiter()');
    expect(contactsPage).toContain('补招生负责老师');
    expect(contactsPage).toContain('{frMsg ?');
  });
});
