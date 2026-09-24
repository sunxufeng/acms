import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「我的跟进」（招生管理 › 我的跟进）的硬口径 —— 2026-09-24 新增。
 *
 * 这是一个**跨四张表的聚合视图**：联系人（主体）+ 卫瓴跟进记录 + 招生跟进 + 邮件归档。
 * 下面每一条都是「写错了不会报错、只会静默少数据 / 静默失灵」的类型，所以用源码级守卫钉住。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const svc = read('api', 'src', 'my-followups', 'my-followups.service.ts');
const ctrl = read('api', 'src', 'my-followups', 'my-followups.controller.ts');
const page = read('web', 'app', 'my-followups', 'page.tsx');

describe('我的跟进 · 后端聚合', () => {
  it('🔴 关联字段（招生跟进 / 邮件）必须用 idsOf 解析，不能当普通字段比', () => {
    // 「关联联系人」是飞书单向关联字段：原始值是 record id 数组（JSON 文本），
    // 等值 / contains 对它一律无效 —— 必须 idsOf 解析后按成员归到联系人头上。
    expect(svc).toContain("idsOf(r['关联联系人'])");
    expect(svc).toContain('sourceRows');
    expect(svc).toContain('mailRows');
  });

  it('🔴 时间一律走 toEpochMs（三类时间形态不同：毫秒戳 / ISO / UTC 串）', () => {
    expect(svc).toContain('function toEpochMs');
    expect(svc).toContain("toEpochMs(r['跟进时间'])");
    expect(svc).toContain("toEpochMs(r['发送时间'])");
    // 直接 Number() 会让整条记录被当成"没有时间"
    expect(svc).not.toMatch(/at:\s*Number\(/);
  });

  it('权限复用联系人读权限（不新增权限点，否则除管理员外谁都没有）', () => {
    expect(svc).toContain("requireModule(user, 'weilingContacts', 'read')");
    expect(ctrl).toContain('SessionGuard');
  });

  it('归属人兜底：按「姓 + 英文名近似」打分（复合串 + 错拼，精确匹配全失败）', () => {
    // 生产实测卫瓴侧是 `致极学院-曹老师｜Dainel|1510`，与系统里 `曹德强｜Daniel` 对不上。
    // ⚠️ 这是**兜底**路径；权威来源是归属人映射表（见上一条断言）。
    expect(svc).toContain('function personTokens');
    expect(svc).toContain('function ownerTokens');
    expect(svc).toContain('function enLike');
    expect(svc).toContain('levenshtein');
    expect(svc).toContain('inferOwner');
  });

  it('🔴 识别不出归属人时返回空列表（绝不退化成不加筛条件 → 把全站联系人当成「我的」）', () => {
    expect(svc).toContain('if (!owner)');
    expect(svc).toContain('ownerUnresolved: true');
  });

  it('联系人数上限按「批量线索池」估（实测单个归属人 1510 条，按几十条估会截断）', () => {
    expect(svc).toContain('const MAX_CONTACTS = 3000');
  });

  it('索引带 TTL 缓存（全表扫约万行，不能每次翻页都重扫）', () => {
    expect(svc).toContain('INDEX_TTL_MS');
    expect(svc).toContain('this.index && Date.now() - this.index.at < INDEX_TTL_MS');
  });

  it('🔴 归属人优先取「归属人映射表」（不再只靠姓名猜）', () => {
    // 2026-09-24 改版：映射表是权威来源，姓名打分只是映射缺失时的兜底
    expect(svc).toContain('TABLES.ownerMapping.tableId');
    expect(svc).toContain('mappingIndex');
    expect(svc).toContain("ownerSource = 'mapping'");
    expect(svc).toContain("ownerSource = 'name'");
  });

  it('🔴 明细**全量**返回（峰哥要求展开就能看全，不再"You can only see 3"）', () => {
    // 上限只用于防极端数据，正常联系人的明细全给
    expect(svc).toContain('const DETAIL_CAP = 200');
    expect(svc).not.toContain('DETAIL_PER_KIND');
  });

  it('三个勾选框：勾上的必须**都有**该类互动（AND），全不勾则不限', () => {
    expect(svc).toContain("query.kindProgress === '1'");
    expect(svc).toContain("query.kindSource === '1'");
    expect(svc).toContain("query.kindMail === '1'");
    expect(svc).toContain('anyWant');
  });

  it('筛选用「用户」而不是「归属人」（user 参数 → 查映射）', () => {
    expect(svc).toContain("String(query.user ?? '')");
    expect(svc).toContain('userOptions');
  });
});

describe('我的跟进 · 前端交互', () => {
  it('行内直接给「最近一条摘要」（0 次点击看进展）', () => {
    expect(page).toContain("t('lastPrefix')");
    expect(page).toContain('lastSummary');
  });

  it('展开是就地展开（不跳新页面），且状态写进地址栏', () => {
    expect(page).toContain('readOpenFromUrl');
    expect(page).toContain('writeOpenToUrl');
    expect(page).toContain('toggle(it.id)');
  });

  it('hover 预览只在支持悬停的设备上开（手机不做）', () => {
    expect(page).toContain("matchMedia('(hover: hover)')");
    expect(page).toContain('canHover');
  });

  it('翻页用全站统一组件（Pagination），不再自写「上一页 / 下一页」', () => {
    expect(page).toContain("import Pagination from '../../components/Pagination'");
    expect(page).toContain('<Pagination');
    expect(page).not.toContain("t('prevPage')");
  });

  it('招生跟进 / 邮件点开**弹窗**看详情（不跳页，连着看多条才不折腾）', () => {
    expect(page).toContain('SourceFollowupModal');
    expect(page).toContain('MailDetailModal');
    expect(page).toContain('setSourceModal');
    expect(page).toContain('setMailModal');
  });

  it('三个勾选框把对应参数传给后端（勾上 = 只留有该项的）', () => {
    expect(page).toContain('kindProgress');
    expect(page).toContain('kindSource');
    expect(page).toContain('kindMail');
  });

  it('筛选下拉是「用户」（不是归属人）', () => {
    expect(page).toContain("t('userLabel')");
    expect(page).toContain('userLabels');
  });

  it('🔴 非系统管理员**只能看自己**：`user` 参数一律忽略（服务端硬锁，不信前端）', () => {
    // 「我的跟进」名义上是"我的" —— 若能切到别的招生老师，等于把别人的客户跟进
    // （联系方式 / 沟通明细 / 邮件）开放给所有持联系人读权限的人。
    expect(svc).toContain('function canSeeOthers');
    expect(svc).toContain("roles?.includes('系统管理员')");
    expect(svc).toContain('scopeAll && asked ? asked : myId');
  });

  it('用户下拉对非管理员**只回本人**（下拉本身就是越权入口）', () => {
    expect(svc).toContain('if (!canSeeOthers(user))');
  });

  it('响应带 selfOnly，前端把「用户」下拉换成「仅本人」标签', () => {
    expect(svc).toContain('selfOnly: !scopeAll');
    expect(page).toContain('data?.selfOnly ?');
    expect(page).toContain("t('selfOnly')");
    // 非管理员下不能渲染用户下拉（否则又给出"能切"的错觉）
    expect(page).toMatch(/data\?\.selfOnly \?[\s\S]{0,400}?\) : \(\s*<FilterSelect/);
  });
});
