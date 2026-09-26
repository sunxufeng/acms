/**
 * 「导入笔记」（我的 IDP 抽屉）的**接线守卫**（2026-09-26 新增）。
 *
 * 这个功能是三个"漏一处就静默出错"的接线拼起来的：
 *
 *  ① **关联目标必须是「IDP学生」明细行**：抽屉里 `entityType='IDP学生'`、
 *     `entityId=target.detailId`。两个入口（IDP 配置页 / 我的 IDP 页）都得把明细行 id 传进来，
 *     漏一个 ⇒ 那个入口点「导入笔记」按钮**禁用**（`detailId` 为空），用户只会以为"功能坏了"。
 *  ② **后端 `ENTITY_TAG` 要有「IDP学生」**：缺了不报错，但打在远端笔记上的标签会退化成
 *     `acms:IDP学生:recXXX`（中文），外部看很别扭。
 *  ③ **写入必须是全量覆盖式**：`PUT /getnote/links` 是"只认最终名单"的语义，
 *     提交时若只发新增（漏了 `imported`），**已有的关联会被静默清掉**。
 *     所以断言"导入"的分支里出现了 `imported.map`（把已有的一并带上）。
 *
 * ⚠️ 断言只写关系，不写死文案与行号 —— 以后调整 UI 不必回来改这里。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { idpStudentLabel } from '@acms/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const drawer = read('web', 'components', 'IdpCommDrawer.tsx');
const idpConfigs = read('web', 'app', 'idp-configs', 'page.tsx');
const myIdp = read('web', 'app', 'my-idp', 'page.tsx');
const getnoteSvc = read('api', 'src', 'getnote', 'getnote.service.ts');

describe('IDP 学生列展示（中文名｜英文名）', () => {
  it('中英文名都有时用全角竖线连接', () => {
    expect(idpStudentLabel('徐欣妍', 'Ella')).toBe('徐欣妍｜Ella');
  });

  it('英文名缺失时只出中文名（不留空竖线）', () => {
    expect(idpStudentLabel('徐欣妍', '')).toBe('徐欣妍');
    expect(idpStudentLabel('徐欣妍', null)).toBe('徐欣妍');
    expect(idpStudentLabel('徐欣妍', '   ')).toBe('徐欣妍');
  });

  it('中文名缺失时退回英文名；两边都空则是空串', () => {
    expect(idpStudentLabel('', 'Ella')).toBe('Ella');
    expect(idpStudentLabel(null, null)).toBe('');
  });

  it('两个页面都用同一个纯函数渲染学生列（各写一份必然漂移）', () => {
    for (const src of [idpConfigs, myIdp]) {
      expect(src).toContain("from '@acms/contracts'");
      expect(src).toMatch(/idpStudentLabel\(/);
    }
  });
});

describe('「导入笔记」的关联目标接线', () => {
  it('抽屉按「IDP学生」明细行关联，且用全量覆盖式写入', () => {
    // 关联目标：entityType 必须是 IDP学生，entityId 必须是明细行 id
    expect(drawer).toMatch(/replaceGetnoteLinks\(\s*'IDP学生'\s*,\s*detailId/);
    expect(drawer).toMatch(/listGetnoteLinks\('IDP学生',\s*detailId\)/);
    // 覆盖式：导入时必须把已有关联一并带上，否则旧关联被静默清掉
    expect(drawer).toMatch(/imported\.map\(\(l\)\s*=>\s*\(\{\s*noteId:\s*l\.noteId/);
  });

  it('两个入口都把明细行 id 传进抽屉（缺一个，那个入口的导入按钮就是灰的）', () => {
    expect(idpConfigs).toMatch(/detailId:\s*r\.id/);
    expect(myIdp).toMatch(/detailId:\s*s\.id/);
  });

  it('后端 ENTITY_TAG 登记了「IDP学生」（否则笔记标签退化成中文）', () => {
    expect(getnoteSvc).toMatch(/IDP学生:\s*'idpStudent'/);
  });

  it('「已导入的不再列出」：候选列表要按已关联的 noteId 过滤', () => {
    expect(drawer).toMatch(/linkedIds\s*=\s*new Set\(/);
    expect(drawer).toMatch(/!linkedIds\.has\(n\.noteId\)/);
  });

  it('候选列表限定「我自己的笔记」（mine=1，两处调用都要带）', () => {
    // 漏一处 = 那条路径会列出同事的笔记（默认口径是"该配置下所有人的笔记"）
    expect(drawer.match(/mine:\s*'1'/g) ?? []).toHaveLength(2);
    // 管理员不受 mine 影响：分支必须排在 listNotes 里的 isAdmin 之后
    // （在外层方法体上比对位置，不要在整文件里 indexOf —— 别处也有 isAdmin 调用）
    const body = getnoteSvc.slice(getnoteSvc.indexOf('private async listNotes('));
    const adminAt = body.indexOf('if (this.isAdmin(user))');
    const mineAt = body.indexOf('if (filters.mine)');
    expect(adminAt).toBeGreaterThan(-1);
    expect(mineAt).toBeGreaterThan(adminAt);
    // mine 分支必须真的用「只看本人凭证」的那一路（空数组是真值，见 collectAllNotes 注释）
    expect(body.slice(mineAt, mineAt + 400)).toMatch(/collectAllNotes\(user,\s*\[\]\)/);
  });
});
