import { describe, expect, it } from 'vitest';
import {
  NOTE_STATUS_ACTIVE,
  NOTE_STATUS_ALL,
  NOTE_STATUS_ARCHIVED,
  NOTE_STATUS_FILTER_OPTIONS,
  hiddenArchivedCount,
  isArchivedNote,
  normalizeNoteStatus,
  noteStatusMatches,
} from '@acms/contracts';

/**
 * 「我的笔记」状态（有效 / 归档）判据的契约测试（2026-09-21）。
 *
 * 为什么这些判据值得单独锁死：状态是**纯 ACMS 侧的标记**，历史笔记在上线时
 * 一条状态行都没有 —— 只要判据写成「等于有效」，历史笔记就会被整体筛掉，
 * 界面症状是「筛了『有效』之后一条笔记都没有」，而服务端不报任何错。
 * 前端（列表页的客户端内存筛选分支）与本文件用的是同一份实现，
 * 所以这里锁的是**前后端共用的口径**。
 *
 * 本文件不连数据库、不改任何数据（纯函数），可随时重跑。
 */

describe('normalizeNoteStatus（只有明确「归档」才算归档）', () => {
  it('🔴 历史笔记：undefined / 空串 / 缺字段 ⇒ 一律「有效」', () => {
    // 上线时没有任何状态行，列表接口读到的是 undefined —— 必须归成「有效」
    expect(normalizeNoteStatus(undefined)).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus(null)).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus('')).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus('   ')).toBe(NOTE_STATUS_ACTIVE);
  });

  it('「归档」原样返回；未知值（含历史脏值）保守归成「有效」', () => {
    expect(normalizeNoteStatus(NOTE_STATUS_ARCHIVED)).toBe(NOTE_STATUS_ARCHIVED);
    expect(normalizeNoteStatus(' 归档 ')).toBe(NOTE_STATUS_ARCHIVED);
    // 未知值不隐藏笔记：宁可让它显出来（用户能自己再归档一次），也不要静默藏起来
    expect(normalizeNoteStatus('作废')).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus(NOTE_STATUS_ACTIVE)).toBe(NOTE_STATUS_ACTIVE);
  });
});

describe('isArchivedNote（列表行标记、按钮互斥、转换闸门共用）', () => {
  it('只有归档为真', () => {
    expect(isArchivedNote(NOTE_STATUS_ARCHIVED)).toBe(true);
    expect(isArchivedNote(NOTE_STATUS_ACTIVE)).toBe(false);
    expect(isArchivedNote(undefined)).toBe(false);
    expect(isArchivedNote('')).toBe(false);
  });
});

describe('noteStatusMatches（筛选：不传 = 不限制）', () => {
  it('want 为空 / 未传 / 「全部」⇒ 不限制', () => {
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, undefined)).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, '')).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, NOTE_STATUS_ALL)).toBe(true);
  });

  it('🔴 筛「有效」时，没有状态行的历史笔记必须**留下**（写成等值就会被全筛掉）', () => {
    expect(noteStatusMatches(undefined, NOTE_STATUS_ACTIVE)).toBe(true);
    expect(noteStatusMatches('', NOTE_STATUS_ACTIVE)).toBe(true);
    expect(noteStatusMatches('作废', NOTE_STATUS_ACTIVE)).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ACTIVE, NOTE_STATUS_ACTIVE)).toBe(true);
    // 真正的归档笔记才被挡掉
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, NOTE_STATUS_ACTIVE)).toBe(false);
  });

  it('筛「归档」只出归档的笔记', () => {
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, NOTE_STATUS_ARCHIVED)).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ACTIVE, NOTE_STATUS_ARCHIVED)).toBe(false);
    expect(noteStatusMatches(undefined, NOTE_STATUS_ARCHIVED)).toBe(false);
  });
});

/**
 * 2026-09-21 自查发现：提示条「已隐藏 N 条**已归档**笔记」里的 N，
 * 原先拿的是「被挡掉的条数」—— 切到「归档」视图时被挡掉的是**有效**笔记，
 * 提示就变成「已隐藏 664 条已归档笔记」（数字对、话错）。口径钉成「挡掉 ∧ 归档」。
 */
describe('hiddenArchivedCount（提示条的 N）', () => {
  const mixed = [NOTE_STATUS_ARCHIVED, NOTE_STATUS_ACTIVE, undefined, '作废'];

  it('筛「有效」⇒ 只数归档的（历史笔记不算）', () => {
    expect(hiddenArchivedCount(mixed, NOTE_STATUS_ACTIVE)).toBe(1);
  });

  it('筛「归档」⇒ 0（被挡掉的是有效笔记，不该报成「已隐藏 N 条已归档」）', () => {
    expect(hiddenArchivedCount(mixed, NOTE_STATUS_ARCHIVED)).toBe(0);
  });

  it('「全部」/ 空 ⇒ 0（没挡任何东西，不显示提示）', () => {
    expect(hiddenArchivedCount(mixed, NOTE_STATUS_ALL)).toBe(0);
    expect(hiddenArchivedCount(mixed, '')).toBe(0);
    expect(hiddenArchivedCount(mixed, undefined)).toBe(0);
  });

  it('全是归档时，筛有效把每一条都算上', () => {
    expect(hiddenArchivedCount([NOTE_STATUS_ARCHIVED, NOTE_STATUS_ARCHIVED], NOTE_STATUS_ACTIVE)).toBe(2);
  });
});

describe('筛选下拉候选', () => {
  /**
   * 🔴 候选里**不能有「全部」**（2026-09-21 峰哥报障：下拉里出现两个「全部」）：
   * 通用筛选控件 `FilterSelect` 自己就会在最前面渲染一项「全部」（值是空串 = 不筛），
   * 候选里再放一个同名的就成了两项。判据侧仍认「全部」（见上面的 noteStatusMatches 用例）。
   */
  it('只列真实状态值（「全部」由筛选控件自己提供）', () => {
    expect([...NOTE_STATUS_FILTER_OPTIONS]).toEqual([NOTE_STATUS_ACTIVE, NOTE_STATUS_ARCHIVED]);
    expect([...NOTE_STATUS_FILTER_OPTIONS]).not.toContain(NOTE_STATUS_ALL);
  });
});

/**
 * 🔴 「归档」独立成权限点（v15，2026-10-02 峰哥：「笔记删除和归档权限需要分开」）。
 *
 * 改前：归档借用 `module:getnote:update`（能编辑 = 能归档）。
 * 改后：归档 = `module:getnoteArchive:update`，删除 = `module:getnote:delete`，
 *       两者可分别勾选。
 *
 * 这里钉住三件事，任何一条漏了都会出事：
 *   ① 新资源**必须继承「编辑」**（`legacyRead`）—— 否则抬版本后原本能归档的教职工角色
 *      全部失去能力，而且**没有任何报错**（按钮消失 + 点了 403）；
 *   ② 判据必须 `update`（只声明 read 的话这个点不在 PERMISSIONS 目录里，矩阵里勾不到）；
 *   ③ 前后端用**同一个点**（不同点是"按钮能点但接口 403"的经典成因）。
 */
describe('🔴 归档独立权限点（v15）', () => {
  it('资源已登记：subOf getnote / actions 含 update / legacyRead 继承「编辑」', async () => {
    const { MODULE_RESOURCES, MODULE_RESOURCE_INTRODUCED_VERSION, ROLE_PERMISSION_VERSION } = await import(
      '@acms/contracts'
    );
    const res = MODULE_RESOURCES.find((r) => r.key === 'getnoteArchive');
    expect(res, '未登记 getnoteArchive 资源').toBeTruthy();
    expect(res!.subOf).toBe('getnote');
    expect(res!.actions).toContain('update');
    expect(res!.legacyRead).toBe('module:getnote:update');
    expect(res!.menuPermission).toBeNull();
    expect(res!.actions).not.toContain('enter');
    // 引入版本固定为 15 且不超过当前版本（否则那段增量迁移覆盖不到）
    expect(MODULE_RESOURCE_INTRODUCED_VERSION.getnoteArchive).toBe(15);
    expect(MODULE_RESOURCE_INTRODUCED_VERSION.getnoteArchive).toBeLessThanOrEqual(ROLE_PERMISSION_VERSION);
  });

  it('🔴 path 不能与父资源同值（moduleByPath 靠数组顺序，重排即串位）', async () => {
    const { MODULE_RESOURCES } = await import('@acms/contracts');
    const child = MODULE_RESOURCES.find((r) => r.key === 'getnoteArchive');
    const parent = MODULE_RESOURCES.find((r) => r.key === 'getnote');
    expect(child!.path).not.toBe(parent!.path);
  });

  it('源码守卫：归档与删除各自断言**不同的**权限点', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(here, '..', 'src', 'getnote', 'getnote.controller.ts'), 'utf8');
    /**
     * 🔴 `not.toContain` 之前**必须剥注释**：这次就踩了 ——
     *    实现里的注释写着「改前借用 `module:getnote:update`」，于是"不得含旧写法"
     *    这条断言恒红，而代码其实是对的。
     */
    const ctrl = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // 归档/激活：窗口**必须切到下一个方法为止** ——
    //   紧跟其后的 `@Put('notes/:id')`（编辑）本来就该用 `module:getnote:update`，
    //   窗口放宽到固定字符数会把那个方法框进来 ⇒ 假红。
    const statusAt = ctrl.indexOf("'notes/:id/status'");
    const nextAt = ctrl.indexOf("@Put('notes/:id')", statusAt);
    expect(statusAt).toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(statusAt);
    const statusBody = ctrl.slice(statusAt, nextAt);
    expect(statusBody).toContain('module:getnoteArchive:update');
    expect(statusBody).not.toContain("'module:getnote:update'");
    // 删除：仍用原来的 delete 点（归档独立出去**不影响**删除的授权口径）
    const delAt = ctrl.indexOf("@Delete('notes/:id')");
    expect(delAt).toBeGreaterThan(-1);
    expect(ctrl.slice(delAt, delAt + 300)).toContain('module:getnote:delete');
  });

  it('源码守卫：前端按钮门控与后端同一个点', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = readFileSync(
      path.join(here, '..', '..', 'web', 'app', 'getnote', 'page.tsx'),
      'utf8',
    );
    expect(page).toContain("perms.includes('module:getnoteArchive:update')");
    // 不能还留着旧的借用写法
    expect(page).not.toContain("perms.includes('module:getnote:update')");
  });
});
