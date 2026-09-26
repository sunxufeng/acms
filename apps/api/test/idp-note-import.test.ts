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
    // 两个入口也不再传 detailId（关联目标改成「新记录」了，不再挂 IDP 明细行）
    // ⚠️ 只查「传给抽屉的那一处的值」——`detailId: string` 这种形参声明不该被判成违规
    expect(idpConfigs).not.toMatch(/detailId:\s*r\.id/);
    expect(myIdp).not.toMatch(/detailId:\s*s\.id/);
  });

  it('「已导入的不再列出」：候选按后端现算的 linkedNoteIds 过滤', () => {
    // 判据必须与写入侧同源（后端按 实体类型=IDP沟通 + 该生记录 id 算），前端不另算一套
    expect(drawer).toMatch(/new Set\(cur\.linkedNoteIds\s*\?\?\s*\[\]\)/);
    expect(drawer).toMatch(/!linkedIds\.has\(n\.noteId\)/);
    expect(getnoteSvc.length).toBeGreaterThan(0);
  });

  it('附件写回要**合并已有**（数组字段是整体替换，只发新的会抹掉旧附件）', () => {
    // 全站只剩这一处写附件（记录详情弹窗已删）⇒ `[...files, ...added]` 那种写法不该再出现
    expect(drawer).toMatch(/\[\.\.\.already,\s*\.\.\.added\]/);
    expect(drawer).toMatch(/沟通附件清单/);
  });

  it('时间线不再铺开沟通总结（只留元信息那一行）', () => {
    // 旧版有 `r.summary.length > 120 ? ... slice` 的预览段，改版后去掉
    expect(drawer).not.toMatch(/r\.summary\.length > 120/);
    // 附件（名称 · 时间 · 删除）挂在元信息行**最右侧**：渲染在 rightCluster 那一簇里，
    // 不再单独占一行（峰哥 2026-09-26：红框那行不要了）。
    // 录音那一支排在它前面（播放按钮），见下面「录音附件」那组断言
    expect(drawer).toMatch(/<span style=\{rightClusterStyle\}>[\s\S]{0,900}plainFilesOf\(r\)\.map/);
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

/**
 * 「我的 IDP」行内展开（2026-09-26 三次改版）。
 *
 * 这次改动的每一条都是"漏了不报错、只是长得不对"的类别：
 *  · 展开区用错变体 ⇒ 内容嵌在表格行里却套了一层全屏遮罩，别处点不动；
 *  · 行 key 不带 configId ⇒ 同一学生在两个批次展开会互相串（收一个另一个也动）；
 *  · 点标题的判据用错层级（顶层并集 vs 行级）⇒ 点 A 记录弹出 B 记录的笔记；
 *  · 关闭按钮回退成文字 ⇒ 全站弹窗定式又被破坏。
 */
describe('「我的 IDP」行内展开（2026-09-26 三次改版）', () => {
  it('学生行可展开，展开区用 inline 变体（不再弹抽屉）', () => {
    expect(myIdp).toMatch(/variant="inline"/);
    expect(myIdp).toMatch(/<IdpCommDrawer/);
    // 「继续操作 · 继续沟通」整列已去掉：同一个入口不摆两处
    expect(myIdp).not.toContain("t('colOps')");
    expect(myIdp).not.toContain("t('continueComm')");
    expect(myIdp).not.toContain("t('startComm')");
  });

  it('展开行的 key 带 configId（同一学生会在多个批次出现，只用明细 id 会串）', () => {
    expect(myIdp).toMatch(/stuKey\s*=\s*\(configId: string, detailId: string\)/);
    expect(myIdp).toMatch(/`\$\{configId\}::\$\{detailId\}`/);
  });

  it('点标题：有关联笔记 ⇒ 笔记详情；没有 ⇒ 这条记录自己的总结 / 明细', () => {
    // 判据是**行级** linkedNoteIds（后端按记录现算），不是整个学生的并集
    expect(drawer).toMatch(/recNotes\s*=\s*rec\?\.linkedNoteIds\s*\?\?\s*\[\]/);
    expect(drawer).toMatch(/rec && noteId \?/);
    expect(drawer).toContain('RecordSummaryModal');
  });

  it('总结 / 明细用**全站统一**的 Markdown 组件（可录入、可浏览、可从 .md 导入）', () => {
    expect(drawer).toMatch(/from '\.\/MarkdownField'/);
    // 表单 2 处（可编辑）+ 查看弹窗 1 处（只读浏览）
    expect(drawer.match(/<MarkdownField/g) ?? []).toHaveLength(3);
    expect(drawer).toMatch(/label=\{t\('fSummary'\)\}[\s\S]{0,140}onChange=\{setSummary\}/);
    expect(drawer).toMatch(/label=\{t\('fDetail'\)\}[\s\S]{0,140}onChange=\{setDetail\}/);
  });

  it('关闭一律用右上角的 ×（全站弹窗定式），不再有文字「关闭」按钮', () => {
    expect(drawer).not.toMatch(/>\s*\{t\('close'\)\}\s*</);
  });

  it('笔记详情弹窗只有**一份实现**：「我的笔记」页与 IDP 共用同一个组件', () => {
    const getnotePage = read('web', 'app', 'getnote', 'page.tsx');
    expect(getnotePage).toContain("from '../../components/GetnoteNoteModal'");
    expect(getnotePage).toContain('<GetnoteNoteModal');
    expect(drawer).toContain("from './GetnoteNoteModal'");
  });

  it('后端按**记录**给关联笔记（行级），并集仍留给「已导入」过滤', () => {
    const svc = read('api', 'src', 'idp', 'idp.service.ts');
    expect(svc).toMatch(/private async linkedNoteMapOf\(/);
    expect(svc).toMatch(/linkedNoteIds:\s*linkMap\.get\(c\.id\)\s*\?\?\s*\[\]/);
    expect(svc).toMatch(/const linkedNoteIds = \[\.\.\.new Set\(\[\.\.\.linkMap\.values\(\)\]\.flat\(\)\)\]/);
    // 行级 / 并集必须来自**同一次**读表：分两次读会漂移（一边有、一边没有）
    expect(svc.match(/new Map<string, string\[\]>\(\)/g) ?? []).toHaveLength(1);
  });
});

/**
 * 录音附件（2026-09-26 深夜 追加）。
 *
 * 背景：IDP 沟通记录里的 `.ogg` 是**录音**（「我的笔记」转出或老师上传时写进
 * 「沟通附件清单」的）。峰哥的要求：显示成**播放按钮**、**不允许删除**，
 * 并且点标题弹出的框里也要能播。
 *
 * 漏了的症状：只给一个 📎 下载链接 + × —— 同事得下载到本地用播放器听，还容易手滑删掉
 * 这条记录唯一的原始素材。
 */
describe('录音附件：播放按钮 + 不可删除', () => {
  it('附件带 type，行内播放与学生记录列表用**同一套**判据与 hook', () => {
    const svc = read('api', 'src', 'idp', 'idp.service.ts');
    expect(svc).toMatch(/type: String\(x\.type \?\? ''\)/);
    expect(drawer).toMatch(/import \{[^}]*isAudioFile[^}]*\} from '\.\.\/lib\/rowAudio'/);
    expect(drawer).toMatch(/useRowAudio\(audioSrcOf\)/);
    // 播放地址走通用附件接口（录音文件是 loc_ 存的，不是笔记专用接口）
    expect(drawer).toMatch(/attachmentAudioSrc\(/);
  });

  it('录音只渲染播放按钮，**不允许删除**；普通附件照旧可删', () => {
    const audioBlock = drawer.slice(
      drawer.indexOf('audiosOf(r).length'),
      drawer.indexOf('plainFilesOf(r)'),
    );
    expect(audioBlock).toContain('toggleAudio');
    expect(audioBlock).not.toContain('removeAttach');
    // 普通附件那一支仍要能删（别把整行的删除一起去掉了）
    expect(drawer).toMatch(/plainFilesOf\(r\)\.map[\s\S]{0,900}removeAttach/);
  });

  it('点标题的弹窗（无关联笔记那条路径）里也有播放器', () => {
    const recBlock = drawer.slice(drawer.indexOf('function RecordSummaryModal'));
    expect(recBlock).toMatch(/<audio/);
    expect(recBlock).toMatch(/attachmentAudioSrc\(audio\.file_token\)/);
  });
});
