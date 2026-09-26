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

describe('「导入笔记」的接线（2026-09-26 二次改版：建记录 + 挂笔记）', () => {
  it('导入 = 逐条建「IDP沟通」记录，并把笔记挂到那条新记录上', () => {
    // 记录类型必须是 IDP沟通（常量，不是裸字符串 —— 类型名改了要跟着变）
    expect(drawer).toMatch(/记录类型:\s*IDP_COMM_RECORD_TYPE/);
    expect(drawer).toMatch(/沟通方式:\s*way/);
    // 关联目标是**新建记录**（不是 IDP 明细行）：entityType=IDP沟通、entityId=新记录 id
    expect(drawer).toMatch(/replaceGetnoteLinks\(IDP_COMM_RECORD_TYPE,\s*rid/);
    // 沟通时间用笔记时间（毫秒），没有就退回现在
    expect(drawer).toMatch(/沟通时间:\s*note\?\.createdAt\s*\|\|\s*Date\.now\(\)/);
  });

  it('抽屉不再内联 NotePanel，也不再把笔记挂到「IDP学生」明细行', () => {
    // 改版后：点整行 → 记录详情弹窗（自建列表），NotePanel 与 detailId 都应消失
    expect(drawer).not.toMatch(/<NotePanel/);
    expect(drawer).not.toMatch(/replaceGetnoteLinks\(\s*'IDP学生'/);
    // 两个入口也不再传 detailId
    expect(idpConfigs).not.toMatch(/detailId:/);
    expect(myIdp).not.toMatch(/detailId:/);
  });

  it('「已导入的不再列出」：候选按后端现算的 linkedNoteIds 过滤', () => {
    // 判据必须与写入侧同源（后端按 实体类型=IDP沟通 + 该生记录 id 算），前端不另算一套
    expect(drawer).toMatch(/new Set\(cur\.linkedNoteIds\s*\?\?\s*\[\]\)/);
    expect(drawer).toMatch(/!linkedIds\.has\(n\.noteId\)/);
    expect(getnoteSvc.length).toBeGreaterThan(0);
  });

  it('附件写回要**合并已有**（数组字段是整体替换，只发新的会抹掉旧附件）', () => {
    expect(drawer).toMatch(/\[\.\.\.files,\s*\.\.\.added\]/);
    expect(drawer).toMatch(/\[\.\.\.already,\s*\.\.\.added\]/);
    expect(drawer).toMatch(/沟通附件清单/);
  });

  it('时间线不再铺开沟通总结（只留元信息那一行）', () => {
    // 旧版有 `r.summary.length > 120 ? ... slice` 的预览段，改版后去掉
    expect(drawer).not.toMatch(/r\.summary\.length > 120/);
    expect(drawer).toMatch(/r\.files\.length > 0/);
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
    // 🔴 mine 的判据 = 本人凭证 + **归属人是我自己**的知识库配置。
    //    只认同人凭证会让"凭证挂在配置上"的老师恒为 0 条（曹德强）；整个用可见配置又会
    //    把同事账号的笔记带进来（sourceVisibleTo 还认"关联用户含我"）。
    expect(body.slice(mineAt, mineAt + 900)).toMatch(/collectAllNotes\(user,\s*mineIds\)/);
    expect(body.slice(mineAt, mineAt + 900)).toMatch(/e\.ownerOpenId === myOpenId/);
  });
});
