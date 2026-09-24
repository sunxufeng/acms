import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 邮件归档「关联一致化」（联系人 ↔ 学生）的硬口径 —— 2026-09-24 新增。
 *
 * 需求（峰哥）：邮件关联了联系人后，该联系人匹配到的学生也要在邮件上关联；
 * 反向（邮件已有学生 → 补家长联系人）也做，因为在生产里几乎没人用「关联联系人」，
 * 只做正向等于没效果。
 *
 * 下面每条都是「写错了不报错、只会静默不生效 / 静默补错」的类型，用源码级守卫钉住。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const svc = read('api', 'src', 'mail-archive', 'mail-archive.service.ts');
const ctrl = read('api', 'src', 'mail-archive', 'mail-archive.controller.ts');
const page = read('web', 'app', 'mail-archive', 'page.tsx');

describe('邮件关联一致化 · 判据与门槛', () => {
  it('🔴 判空必须用 idsOf（`{"link_record_ids": null}` 这种"空关联"形态会让字符串判空失效）', () => {
    // 生产实测 816/6383 封的「关联学生」是这个形态：看着有值、解析后为空。
    // 它是「空关联」的正常表示之一（且清不掉：写回 [] 再读仍是它），
    // 所以判据只能靠 idsOf，不能靠字符串，也不要试图"清理"它。
    expect(svc).toContain("idsOf(fields['关联学生'])");
    expect(svc).toContain("idsOf(fields['关联联系人'])");
    // 反例守卫：不能写成"字符串非空就算已关联"
    expect(svc).not.toMatch(/String\(\s*f(?:ields)?\[['"]关联学生['"]\]\s*\?\?\s*['"]['"]\s*\)\s*!==\s*['"]['"]/);
  });

  it('🔴 不要"顺手清理"空关联形态（清不掉，会变成每次重算都白写一遍）', () => {
    // 第一版就有个 isShellLinkValue() 分支：写库条件带上它 ⇒ 重复点「重算关联」
    // 每次都报 cleaned=154 并重复写 154 条空记录（2026-09-24 生产实测）。
    expect(svc).not.toContain('isShellLinkValue');
    expect(svc).toContain('if (!r.changed) continue;');
    expect(svc).toContain('if (!r.changed) return false;');
  });

  it('🔴 只写**真的变了**的那一侧（避免无谓写）', () => {
    expect(svc).toContain('r.studentsChanged');
    expect(svc).toContain('r.contactsChanged');
    expect(svc).toContain("if (r.studentsChanged) patch['关联学生'] = r.students;");
    expect(svc).toContain("if (r.contactsChanged) patch['关联联系人'] = r.contacts;");
  });

  it('🔴 联系人→学生 必须用 `关联学生ID`（精确 id），不能用姓名（重名会挂错学生）', () => {
    expect(svc).toContain("String(f['关联学生ID'] ?? '').trim()");
    expect(svc).not.toContain("f['关联学生'] ?? '').trim()"); // 联系人的姓名文本不能当 id 用
  });

  it('🔴 置信度门槛：弱匹配（昵称包含学生姓名等）不得自动补，避免把邮件挂到错的学生', () => {
    expect(svc).toContain('const LINK_MIN_CONFIDENCE = 85');
    expect(svc).toContain('conf < LINK_MIN_CONFIDENCE');
    expect(svc).toContain("Number(f['匹配置信度'] ?? 0)");
  });

  it('两个方向都在：联系人→学生 与 学生→联系人（只做正向在生产里补不出东西）', () => {
    expect(svc).toContain('studentsByContact.get(c)');
    expect(svc).toContain('contactsByStudent.get(s)');
  });

  it('只补不覆盖：取并集（Set），不能把老师手工加的关联冲掉', () => {
    expect(svc).toContain("const students = new Set(idsOf(fields['关联学生']))");
    expect(svc).toContain("const contacts = new Set(idsOf(fields['关联联系人']))");
  });
});

describe('邮件关联一致化 · 触发与接口', () => {
  it('收口在 `link()`：服务端补，而不是前端联动（同步/导入都绕过前端）', () => {
    expect(svc).toContain('await this.reconcileRecord(recordId);');
  });

  it('无关联的邮件不写库（生产里绝大多数邮件是空的，避免无谓写）', () => {
    expect(svc).toContain('if (!r.changed) continue;');
    expect(svc).toContain('if (!r.changed) return false;');
  });

  it('重算接口要管理员级权限（扫全表 + 批量写，属维护动作）', () => {
    expect(ctrl).toContain("@Post('reconcile-links')");
    expect(ctrl).toContain("'module:mailArchive:update'");
  });

  it('前端有「重算关联」入口并展示结果（扫描/补全/清理）', () => {
    expect(page).toContain('reconcileMailLinks');
    expect(page).toContain("t('reconcileDone'");
  });
});
