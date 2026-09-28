import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「我的笔记 → 转换」改**行内就地**的守卫测试（2026-09-28 峰哥定稿）。
 *
 * ## 为什么要锁住这些东西
 *
 * 这次改动的核心价值是「不再跳页、表单与各模块自己的新建表单完全一致」。
 * 而这份一致性**靠复用**而不是靠检查 —— 一旦以后有人在转换面板里自己拼字段、
 * 或者把留痕挪回「点转换就写」，功能表面照常工作，只有用户会发现
 * 「转出来的记录少了几个字段」「已转次数虚高」。这类问题不报错、不崩，最难查，
 * 所以用测试钉住。
 *
 * 本文件只读源码文本，不连数据库、不改数据，可随时重跑。
 */

function read(...parts: string[]): string {
  // 测试运行时 cwd = apps/api，仓库根在两级之上
  return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf8');
}

const CRUD = read('apps', 'web', 'components', 'CrudPage.tsx');
const PANEL = read('apps', 'web', 'components', 'NoteConvertPanel.tsx');
const REGISTRY = read('apps', 'web', 'lib', 'convertForm.ts');
const GETNOTE_PAGE = read('apps', 'web', 'app', 'getnote', 'page.tsx');
const MEETING_PAGE = read('apps', 'web', 'app', 'meeting-minutes', 'page.tsx');
const MEETING_COLS = read('apps', 'web', 'app', 'meeting-minutes', 'columns.tsx');

describe('CrudPage 的 formOnly 模式（就地转换表单的宿主）', () => {
  it('暴露 formOnly / onFormChange / expandedRow，并且 formOnly 分支在列表之前 return', () => {
    expect(CRUD).toContain('formOnly?: {');
    expect(CRUD).toContain('onFormChange?: (form: Record<string, unknown>) => void;');
    expect(CRUD).toContain('expandedRow?: (row: Record<string, unknown>) => React.ReactNode;');
    // formOnly 必须**早于**主 return（否则会把列表也渲染出来，展开区里就多出一整张表）
    const iFormOnly = CRUD.indexOf('  if (formOnly) {');
    const iMainReturn = CRUD.lastIndexOf('\n  return (');
    expect(iFormOnly).toBeGreaterThan(-1);
    expect(iFormOnly).toBeLessThan(iMainReturn);
  });

  it('字段渲染只有一份：formOnly 与三种表单形态都走 formGridOf', () => {
    expect(CRUD).toContain('const formGridOf = (cols: CrudColumn[]) => (');
    // 同一份渲染被用在：主表单、折叠区（两段）、以及下面这次赋值
    expect(CRUD).toContain('const formFields = formGridOf(shownCols);');
    expect(CRUD.match(/formGridOf\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('「更多可选字段」的折叠判据 = 必填 ∨ 已预填 ∨ convertShow ∨ showIf', () => {
    expect(CRUD).toMatch(/const isFoldable = \(c: CrudColumn\) =>\s*!c\.required && !c\.showIf && !c\.convertShow && !hasSeed\(c\.key\)/);
    // 折叠只是视觉收纳：两段都进 form-grid，提交仍取 formCols（全量）
    expect(CRUD).toContain('const mainCols = shownCols.filter((c) => !isFoldable(c));');
    expect(CRUD).toContain('const moreCols = shownCols.filter(isFoldable);');
  });

  it('🔴 判「已自动填好」用挂载时的初值，不用实时 form（否则联动会让字段跳来跳去）', () => {
    expect(CRUD).toMatch(/const seed = formOnly\.initial \?\? \{\};/);
  });

  it('expandedRow 渲染成横跨整行的第二行（colSpan 用 colCount）', () => {
    expect(CRUD).toContain('const extra = expandedRow?.(row);');
    expect(CRUD).toMatch(/<td colSpan=\{colCount\}[^>]*>\s*\{extra\}/);
  });

  it('formOnly 下不拉列表（没给 list 也不报错）', () => {
    expect(CRUD).toMatch(/useEffect\(\(\) => \{ if \(!formOnly\) reload\(\); \}/);
    expect(CRUD).toContain('if (!apiRef.current.list) return;');
  });
});

describe('转换面板：三段式 + 保存成功才留痕', () => {
  it('面板把表单渲染交给 CrudPage 的 formOnly，自己不拼字段', () => {
    expect(PANEL).toContain('formOnly={{');
    expect(PANEL).toContain('columns={parts.columns}');
    expect(PANEL).toContain('api={parts.api}');
    // 面板里不该出现任何目标模块的字段名（出现了就说明在自造字段清单）
    for (const field of ['沟通总结', '沟通明细', '会议总结', '会议议题', '跟进负责人', '观察类型']) {
      expect(PANEL).not.toContain(field);
    }
  });

  it('🔴 留痕（logNoteConvert）只在 onSaved 之后调，选类型时不写', () => {
    const iLog = PANEL.indexOf('api.logNoteConvert');
    const iSaved = PANEL.indexOf('const handleSaved = useCallback');
    const iPicked = PANEL.indexOf('const pick = useCallback');
    expect(iLog).toBeGreaterThan(-1);
    // 调用点在 handleSaved 之内，而 handleSaved 在 pick 之后定义 ⇒ 选类型那一步不可能写到
    expect(iLog).toBeGreaterThan(iSaved);
    expect(iSaved).toBeGreaterThan(iPicked);
    // pick 里只允许「读详情 + 拼预填 + 铺表单」，不许出现留痕接口
    const pickBody = PANEL.slice(iPicked, iSaved);
    expect(pickBody).not.toContain('logNoteConvert');
  });

  it('保存后写齐三件：留痕 → 回填目标记录 id → 写笔记关联', () => {
    expect(PANEL).toContain('api.linkNoteConvert(logId, newId)');
    expect(PANEL).toContain('api.replaceGetnoteLinks(');
  });

  it('未登记页内表单的模块退回旧流程（跳页），不自己造表单', () => {
    expect(REGISTRY).toContain('export function convertFormFor');
    expect(PANEL).toContain('if (!convertFormFor(tg.key, { me: \'\' }))');
    expect(PANEL).toContain('onFallback(tg);');
  });

  it('学生记录的列定义随「记录类型」重建（措辞与显隐跟着变）', () => {
    // 列定义由**登记表**按 studentType 重建（面板自己不调 buildStudentRecordColumns，
    // 那会变成第二份「按类型生成列定义」的实现）
    expect(REGISTRY).toContain('buildStudentRecordColumns(ctx.studentType || undefined)');
    expect(PANEL).not.toContain('buildStudentRecordColumns');
    expect(PANEL).toContain('setStudentType(String(filled[STUDENT_RECORD_TYPE_FIELD] ?? \'\'));');
    expect(PANEL).toContain('onFormChange={handleFormChange}');
  });

  it('用「笔记 id + 模块 key」当 key，换目标模块整体重挂载（初值只读一次）', () => {
    expect(PANEL).toMatch(/key=\{`\$\{noteId\}::\$\{targetKey\}`\}/);
  });
});

describe('模块登记表：字段定义只有一份', () => {
  it('三个模块都从**各模块自己的 columns 文件**取列定义，登记表里没有字段清单', () => {
    expect(REGISTRY).toContain("from '../app/source-followups/columns'");
    expect(REGISTRY).toContain("from '../app/student-records/columns'");
    expect(REGISTRY).toContain("from '../app/meeting-minutes/columns'");
    // 登记表里出现**带引号的字段名**= 又开始各写一份了（注释里提一句不算）
    for (const field of ['沟通总结', '沟通明细', '会议议题', '参会人员', '跟进负责人']) {
      expect(REGISTRY).not.toContain(`'${field}'`);
    }
  });

  it('预填增强用的是各模块导出的那一份（不是转换面板自己写的解析）', () => {
    expect(REGISTRY).toContain('parseSourceFollowupFromSummary');
    expect(REGISTRY).toContain('parseStudentRecordFromSummary');
    expect(REGISTRY).toContain('parseMeetingFromSummary');
  });

  it('会议纪要的部门联动数据与列表页同源（都走 useDeptMembers）', () => {
    expect(MEETING_PAGE).toContain("from '../../lib/useDeptMembers'");
    expect(MEETING_PAGE).toContain('useDeptMembers()');
    expect(PANEL).toContain("from '../lib/useDeptMembers'");
    // 列表页里不该再有自己那份「部门树 → 成员」遍历（复制一份必然漂移）
    expect(MEETING_PAGE).not.toContain('collect(String(d.open_department_id)');
  });
});

describe('「我的笔记」列表：转换不再弹窗、不再跳页', () => {
  it('转换面板通过 expandedRow 就地渲染，且不再有候选模块弹窗', () => {
    expect(GETNOTE_PAGE).toContain('<NoteConvertPanel');
    expect(GETNOTE_PAGE).toContain('expandedRow={(row) => {');
    expect(GETNOTE_PAGE).not.toContain('convertModal');
    // 旧弹窗的标题文案还在 i18n 里（详情弹窗等复用），但页面里不该再引它
    expect(GETNOTE_PAGE).not.toContain("t('convertTitle')");
  });

  it('兜底跳转路径保留（未登记页内表单的模块仍能转）', () => {
    expect(GETNOTE_PAGE).toContain('void doConvert(tg)');
    expect(GETNOTE_PAGE).toContain('putConvertPayload({');
  });

  it('保存成功后刷新该笔记的「已转」计数', () => {
    expect(GETNOTE_PAGE).toContain('onLogged={(item) =>');
    expect(GETNOTE_PAGE).toMatch(/filter\(\(i\) => i\.moduleKey !== item\.moduleKey\)/);
  });
});

describe('转换精简表单里默认展开的字段（convertShow）', () => {
  const SOURCE_COLS = read('apps', 'web', 'app', 'source-followups', 'columns.tsx');
  const STU_COLS = read('apps', 'web', 'app', 'student-records', 'columns.tsx');

  /** 在 columns.tsx 里某字段定义的起点（找不到返回 -1） */
  const at = (src: string, key: string) => src.indexOf(`key: '${key}'`);

  it('招生跟进：活动类型 / 付款状态 / 家长 / 家长反馈态度 / 关联学生 默认展开', () => {
    for (const k of ['活动类型', '付款状态', '家长', '家长反馈态度', '关联学生']) {
      const i = at(SOURCE_COLS, k);
      expect(i, k).toBeGreaterThan(-1);
      // 标记写在该字段自己的定义块里（往后 900 字符内出现 convertShow 即算命中）
      expect(SOURCE_COLS.slice(i, i + 900), k).toContain('convertShow');
    }
  });

  it('🔴 招生跟进：学生姓名紧跟联系人、跟进状态紧跟跟进时间（峰哥 2026-09-28）', () => {
    for (const k of ['学生姓名', '跟进状态']) {
      const i = at(SOURCE_COLS, k);
      expect(i, k).toBeGreaterThan(-1);
      expect(SOURCE_COLS.slice(i, i + 900), k).toContain('convertShow');
    }
    // 表单按 `columns` 数组顺序渲染 ⇒ 「紧跟」= 数组里就挨着
    expect(at(SOURCE_COLS, '学生姓名')).toBeGreaterThan(at(SOURCE_COLS, '关联联系人'));
    expect(at(SOURCE_COLS, '学生姓名')).toBeLessThan(at(SOURCE_COLS, '关联学生'));
    expect(at(SOURCE_COLS, '跟进状态')).toBeGreaterThan(at(SOURCE_COLS, '跟进时间'));
    expect(at(SOURCE_COLS, '跟进状态')).toBeLessThan(at(SOURCE_COLS, '活动类型'));
  });

  it('🔴 学生记录：沟通方式紧跟「学生」（关联学生）且默认展开，各类型都有', () => {
    const i = at(STU_COLS, '沟通方式');
    expect(i).toBeGreaterThan(-1);
    expect(STU_COLS.slice(i, i + 900)).toContain('convertShow');
    expect(i).toBeGreaterThan(at(STU_COLS, '关联学生'));
    expect(i).toBeLessThan(at(STU_COLS, '观察类型'));
    // 不带 showIf ⇒ 所有记录类型都显示（峰哥：几种记录类型里都要有）
    // 只看**本字段自己的定义块**（到下一个 `key:` 为止），别把邻居的 showIf 算进来
    const next = STU_COLS.indexOf('key: ', i + 5);
    expect(STU_COLS.slice(i, next)).not.toContain('showIf');
  });

  it('会议纪要：峰哥点名的 9 个字段默认展开', () => {
    expect(MEETING_COLS.match(/convertShow: true/g)?.length).toBe(9);
    for (const field of ['会议地点', '开始时间', '结束时间', '参会人员', '缺席人员', '列席人员', '状态', '可见范围', '敏感级别']) {
      expect(MEETING_COLS).toContain(field);
    }
  });
});

describe('转换候选目标的顺序（🔴 按 order 排，不按菜单树）', () => {
  const NOTE_CONVERT = read('apps', 'web', 'lib', 'noteConvert.ts');

  it('候选 = enabled 的，且按 order 升序（纯函数只有一份）', () => {
    expect(NOTE_CONVERT).toContain('export function enabledConvertTargets');
    expect(NOTE_CONVERT).toMatch(/\.filter\(\(i\) => i\.enabled\)\s*\.sort\(\(a, b\) =>/);
  });

  it('页面必须用它取候选（不许自己 filter 一遍）', () => {
    expect(GETNOTE_PAGE).toContain('setConvertTargets(enabledConvertTargets(cfg.items));');
    // 旧写法（直接 filter、不排序）不许留
    expect(GETNOTE_PAGE).not.toMatch(/setConvertTargets\(\(cfg\.items \?\? \[\]\)\.filter/);
  });

  it('线上配置的 order 口径：招生跟进 80 < 学生记录 120 < 会议纪要 540 ⇒ 面板顺序如此', () => {
    // 这三条是「转换配置」里的实际值，改配置就等于改界面顺序；
    // 这里只锁「学生记录要排在会议纪要前面」这个结论能被 order 表达出来。
    const orders = { sourceFollowups: 80, studentRecords: 120, meetingMinutes: 540 };
    expect(orders.sourceFollowups).toBeLessThan(orders.studentRecords);
    expect(orders.studentRecords).toBeLessThan(orders.meetingMinutes);
  });
});

describe('会议纪要转换预填补齐（2026-09-28）', () => {
  it('会议议题 ← 笔记标题、会议时间 ← 笔记创建日期（只取日期，date 控件才不空框）', () => {
    expect(MEETING_COLS).toMatch(/if \(!has\('会议议题'\) && ctx\?\.noteTitle\) seeded\['会议议题'\] = ctx\.noteTitle;/);
    // 纯日期口径：拼的是 YYYY-MM-DD，不带 T 时刻
    expect(MEETING_COLS).toMatch(/seeded\['会议时间'\] = `\$\{d\.getFullYear\(\)\}-\$\{p\(d\.getMonth\(\) \+ 1\)\}-\$\{p\(d\.getDate\(\)\)\}`/);
  });
});
