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
  it('🔴 判空必须用 idsOf（`{"link_record_ids": null}` 壳值会让字符串判空失效）', () => {
    // 生产实测 816/6383 封的「关联学生」是这个壳值：看着有值、解析后为空。
    expect(svc).toContain('function isShellLinkValue');
    expect(svc).toContain("idsOf(fields['关联学生'])");
    expect(svc).toContain("idsOf(fields['关联联系人'])");
    // 反例守卫：不能写成"字符串非空就算已关联"
    expect(svc).not.toMatch(/String\(\s*f(?:ields)?\[['"]关联学生['"]\]\s*\?\?\s*['"]['"]\s*\)\s*!==\s*['"]['"]/);
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
    expect(svc).toContain("if (!Object.keys(patch).length) return false;");
    expect(svc).toContain('if (!r.changed && !shell) continue;');
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
