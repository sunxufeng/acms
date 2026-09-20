'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api, type CurriculumCoverageResult } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { usePermissions } from '../../lib/permissions';
import {
  CoverageBar,
  DateField,
  Notice,
  StatCard,
  Tabs,
  fmtDate,
  fmtDateTime,
  fmtPct,
  statusClassOf,
} from '../../components/curriculum/fields';

/**
 * 课程规划（Curriculum）—— 对齐 Gibbon v31 的 Planner，五张表 + 一个覆盖率报表。
 *
 *   units      单元（母版，挂在课程方案上）
 *   blocks     单元环节（导入 / 讲解 / 练习…）
 *   classes    单元开课（单元 × 教学班，带起止日期）→ 行级「部署环节到课次」
 *   deployed   部署环节（环节落到具体课次，带授课日期与状态）
 *   outcomes   单元挂成果（可对成果文本做单元内改写）
 *   coverage   覆盖率：按教学班汇总单元数 / 状态分布 / 环节部署数与部署到课次的占比
 *
 * 与 Gibbon 的差异（刻意的简化）：
 *   - 一个环节 = 一节课。课时数只做排课时的参考，不做「一个环节跨多节课」的编排，
 *     部署时第 i 个环节固定落到第 i 个课次上，规则简单到教师能预期。
 *   - 「学年」是自由文本而非关联（全站没有学年列表接口）。
 */

const BLOCK_TYPES = ['导入', '讲解', '演示', '练习', '讨论', '实验', '评估', '总结', '作业讲评', '其它'];
const ON_OFF = ['启用', '停用'];
const YES_NO = ['是', '否'];
const UNIT_CLASS_STATUSES = ['未开始', '进行中', '已完成', '已取消'];
const DEPLOY_STATUSES = ['未开始', '进行中', '已完成', '已跳过'];

const UNIT_TRANSITIONS: Record<string, string[]> = {
  草稿: ['已发布'],
  已发布: ['已归档', '草稿'],
  已归档: ['草稿'],
};
const ON_OFF_TRANSITIONS: Record<string, string[]> = { 启用: ['停用'], 停用: ['启用'] };
const UNIT_CLASS_TRANSITIONS: Record<string, string[]> = {
  未开始: ['进行中', '已完成', '已取消'],
  进行中: ['已完成', '已取消'],
  已完成: [],
  已取消: ['未开始'],
};
const DEPLOY_TRANSITIONS: Record<string, string[]> = {
  未开始: ['进行中', '已完成', '已跳过'],
  进行中: ['已完成', '已跳过'],
  已完成: ['进行中'],
  已跳过: ['未开始'],
};

interface LinkOption {
  value: string;
  label: string;
}

/**
 * link 字段的候选项。只取第一页（pageSize 上限 500）—— 单元/环节/成果这类规划数据
 * 单校量级在数百条内；课次上千条，因此课次下拉只给最近 300 条，精确定位请回「排课课次」页筛。
 */
function toOptions(rows: Record<string, unknown>[], nameKey: string): LinkOption[] {
  return rows
    .map((r) => ({ value: String(r.id ?? ''), label: String(r[nameKey] ?? '') }))
    .filter((x) => x.value && x.label);
}

type TabKey = 'units' | 'blocks' | 'classes' | 'deployed' | 'outcomes' | 'coverage';

/**
 * 关联候选项跨模块（课程方案 / 教学班 / 排课课次 / 学习成果），用户未必都有读权限。
 * 逐个兜底而不是整体 catch：缺哪个就哪个下拉为空，其余照常可用。
 */
function safe(p: Promise<{ items?: Record<string, unknown>[] }>): Promise<{ items?: Record<string, unknown>[] }> {
  return p.catch(() => ({ items: [] as Record<string, unknown>[] }));
}

export default function CurriculumPage() {
  const tl = useTl();
  const perms = usePermissions();
  const canUpdate = perms.includes('module:curriculum:update');

  const [tab, setTab] = useState<TabKey>('units');
  const [editing, setEditing] = useState(false);
  const [plans, setPlans] = useState<LinkOption[]>([]);
  const [units, setUnits] = useState<LinkOption[]>([]);
  const [classes, setClasses] = useState<LinkOption[]>([]);
  const [sessions, setSessions] = useState<LinkOption[]>([]);
  const [blocks, setBlocks] = useState<LinkOption[]>([]);
  const [outcomes, setOutcomes] = useState<LinkOption[]>([]);
  const [unitClasses, setUnitClasses] = useState<LinkOption[]>([]);
  const [coverage, setCoverage] = useState<CurriculumCoverageResult | null>(null);
  const [coverageErr, setCoverageErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'info' | 'ok' | 'error'; title: string; detail?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      safe(api.listCoursePlans({ pageSize: '200' })),
      safe(api.curriculumUnits.list({ pageSize: '500' })),
      safe(api.listTeachingClasses({ pageSize: '300' })),
      safe(api.listSessions({ pageSize: '300' })),
      safe(api.curriculumUnitBlocks.list({ pageSize: '500' })),
      safe(api.learningOutcomes.list({ pageSize: '500' })),
      safe(api.curriculumUnitClasses.list({ pageSize: '500' })),
    ]).then(([pl, un, cl, se, bl, oc, uc]) => {
      if (!alive) return;
      setPlans(toOptions(pl.items ?? [], '课程方案名称'));
      setUnits(toOptions(un.items ?? [], '单元名称'));
      setClasses(toOptions(cl.items ?? [], '教学班名称'));
      setSessions(toOptions(se.items ?? [], '课次名称'));
      setBlocks(toOptions(bl.items ?? [], '环节名称'));
      setOutcomes(toOptions(oc.items ?? [], '成果名称'));
      setUnitClasses(toOptions(uc.items ?? [], '开课名称'));
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 覆盖率同时供「单元开课」的部署进度列与「覆盖率」页签使用，只在切到这两个页签时拉 */
  const reloadCoverage = useCallback(async () => {
    try {
      const r = await api.getCurriculumCoverage();
      setCoverage(r);
      setCoverageErr(null);
    } catch (e) {
      setCoverage(null);
      setCoverageErr((e as Error).message);
    }
  }, []);

  /** 开课 id → 该开课的部署进度（来自覆盖率接口，避免每行再打一次接口） */
  const deployOfUnitClass = useMemo(() => {
    const m: Record<string, { 已部署环节数: number; 环节总数: number }> = {};
    for (const c of coverage?.items ?? []) {
      for (const u of c.单元) m[u.开课] = { 已部署环节数: u.已部署环节数, 环节总数: u.环节总数 };
    }
    return m;
  }, [coverage]);

  // ── 单元 ──────────────────────────────────────────────────────────
  const unitColumns = useMemo<CrudColumn[]>(
    () => [
      { key: '单元名称', label: '单元名称', width: '200px', form: true, required: true, type: 'text' },
      {
        key: '课程方案', label: '课程方案', width: '170px',
        form: true, type: 'link', linkOptions: plans,
        filter: true, filterParam: '课程方案__has', filterOptions: plans.map((x) => x.label),
      },
      {
        // 读字典「学年」（2020学年 ~ 2030学年）。原来是自由文本 ⇒ 写法不一（2026-2027 / 2026学年）
        // 会让按学年检索与聚合都对不上；改下拉后取值统一。
        key: '学年', label: '学年', width: '100px',
        form: true, type: 'select', dictKey: '学年', filter: true,
        hint: '按学年检索也可以用顶部搜索框',
      },
      {
        // 字典「教学学期」（含「暑期学期」，合到同一 key 免得出现两套学期名单）
        key: '学期', label: '学期', width: '90px',
        form: true, type: 'select', dictKey: '教学学期', filter: true,
      },
      { key: '预计课时', label: '预计课时', width: '90px', form: true, type: 'number' },
      { key: '单元状态', label: '单元状态', width: '90px', filter: true, filterOptions: ['草稿', '已发布', '已归档'] },
      { key: '排序', label: '排序', width: '70px', form: true, type: 'number', hint: '同一课程方案内按此升序' },
      {
        key: '单元描述', label: '单元描述', width: '320px',
        form: true, type: 'textarea', list: false, fieldHeight: 120,
        hint: '写清本单元要解决的核心问题与达成标准',
      },
      { key: '更新时间', label: '更新时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
    ],
    [plans],
  );

  // ── 单元环节 ──────────────────────────────────────────────────────
  const blockColumns = useMemo<CrudColumn[]>(
    () => [
      { key: '环节名称', label: '环节名称', width: '200px', form: true, required: true, type: 'text' },
      {
        key: '所属单元', label: '所属单元', width: '180px',
        form: true, required: true, type: 'link', linkOptions: units,
        filter: true, filterParam: '所属单元__has', filterOptions: units.map((x) => x.label),
      },
      { key: '环节类型', label: '环节类型', width: '110px', form: true, type: 'select', options: BLOCK_TYPES, filter: true, filterOptions: BLOCK_TYPES },
      { key: '课时数', label: '课时数', width: '80px', form: true, type: 'number', hint: '部署时一个环节占一节课，这里只做排课参考' },
      { key: '含作业', label: '含作业', width: '80px', form: true, type: 'select', options: YES_NO, filter: true, filterOptions: YES_NO },
      {
        key: '环节状态', label: '环节状态', width: '90px',
        filter: true, filterOptions: ON_OFF,
        hint: '设为「停用」后该环节不参与部署，也不计入覆盖率的环节总数',
      },
      { key: '排序', label: '排序', width: '70px', form: true, type: 'number', hint: '部署时按此顺序落到课次上' },
      { key: '环节描述', label: '环节描述', width: '300px', form: true, type: 'textarea', list: false, fieldHeight: 100 },
      { key: '更新时间', label: '更新时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
    ],
    [units],
  );

  // ── 单元开课（含部署进度与行级部署动作）───────────────────────────
  const deployAction = useMemo(
    () =>
      canUpdate
        ? [
            {
              // ⚠️ CrudPage 对 rowExtraActions.label **不做** tl() 翻译（只有 extraActions 会），
              //    所以这里自己译好再传，否则英文界面下会露出中文
              label: tl('部署环节到课次'),
              run: async (row: Record<string, unknown>, reload: () => void) => {
                const id = String(row.id ?? '');
                const name = String(row['开课名称'] ?? '') || id;
                const ok = window.confirm(
                  `${tl('把该开课所属单元的环节按顺序部署到教学班的课次上？')}\n\n${tl('已有部署记录会被重建。')}${name ? `（${name}）` : ''}`,
                );
                if (!ok) return;
                setMsg({ kind: 'info', title: tl('正在部署…') });
                try {
                  const r = await api.deployUnitClass(id);
                  setMsg({
                    kind: 'ok',
                    title: tl('部署完成'),
                    detail: `${tl('环节')} ${r.环节数} · ${tl('可用课次')} ${r.可用课次数} · ${tl('已部署')} ${r.已部署}${
                      r.课次不足的环节数 ? ` · ${tl('课次不足未排入')} ${r.课次不足的环节数}` : ''
                    }${r.空余课次数 ? ` · ${tl('空余课次')} ${r.空余课次数}` : ''}`,
                  });
                } catch (e) {
                  setMsg({ kind: 'error', title: tl('部署失败'), detail: (e as Error).message });
                }
                reload();
                void reloadCoverage();
              },
            },
          ]
        : undefined,
    [canUpdate, tl, reloadCoverage],
  );

  const classColumns = useMemo<CrudColumn[]>(
    () => [
      {
        key: '开课名称', label: '开课名称', width: '200px',
        form: true, required: true, type: 'text',
        hint: '如「七年级数学 · 第一章 有理数」；它也是部署环节列表里显示的开课名',
      },
      {
        key: '单元', label: '单元', width: '180px',
        form: true, required: true, type: 'link', linkOptions: units,
        filter: true, filterParam: '单元__has', filterOptions: units.map((x) => x.label),
      },
      {
        key: '教学班', label: '教学班', width: '150px',
        form: true, required: true, type: 'link', linkOptions: classes,
        filter: true, filterParam: '教学班__has', filterOptions: classes.map((x) => x.label),
      },
      {
        key: '开始日期', label: '开始日期', width: '110px',
        form: true, renderField: ({ value, onChange }) => <DateField value={value} onChange={onChange} />,
        render: (v) => <span className="muted">{fmtDate(v)}</span>,
        hint: '部署只取这个区间内的课次',
      },
      {
        key: '结束日期', label: '结束日期', width: '110px',
        form: true, renderField: ({ value, onChange }) => <DateField value={value} onChange={onChange} />,
        render: (v) => <span className="muted">{fmtDate(v)}</span>,
        hint: '必须晚于开始日期',
      },
      { key: '开课状态', label: '开课状态', width: '90px', filter: true, filterOptions: UNIT_CLASS_STATUSES },
      {
        key: '部署进度', label: '部署进度', width: '190px',
        render: (_v, row) => {
          const d = deployOfUnitClass[String(row.id ?? '')];
          if (!d) return <span className="muted">—</span>;
          if (!d.环节总数) return <span className="muted">{tl('该单元还没有环节')}</span>;
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <CoverageBar value={d.已部署环节数 / d.环节总数} />
              <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>{`${d.已部署环节数}/${d.环节总数}`}</span>
            </span>
          );
        },
      },
      { key: '备注', label: '备注', width: '220px', form: true, type: 'textarea', list: false, fieldHeight: 80 },
      { key: '更新时间', label: '更新时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
    ],
    [units, classes, deployOfUnitClass, tl],
  );

  // ── 部署环节 ──────────────────────────────────────────────────────
  const deployedColumns = useMemo<CrudColumn[]>(
    () => [
      {
        key: '所属开课', label: '所属开课', width: '190px',
        form: true, type: 'link', linkOptions: unitClasses,
        filter: true, filterParam: '所属开课__has', filterOptions: unitClasses.map((x) => x.label),
      },
      {
        key: '环节', label: '环节', width: '170px',
        form: true, type: 'link', linkOptions: blocks,
        filter: true, filterParam: '环节__has', filterOptions: blocks.map((x) => x.label),
      },
      {
        key: '课次', label: '课次', width: '170px',
        form: true, type: 'link', linkOptions: sessions,
        filter: true, filterParam: '课次__has', filterOptions: sessions.map((x) => x.label),
      },
      {
        key: '授课日期', label: '授课日期', width: '110px',
        form: true, renderField: ({ value, onChange }) => <DateField value={value} onChange={onChange} />,
        render: (v) => <span className="muted">{fmtDate(v)}</span>,
        hint: '部署时自动取课次日期，也可手工调整',
      },
      { key: '部署状态', label: '部署状态', width: '90px', filter: true, filterOptions: DEPLOY_STATUSES },
      {
        key: '单元', label: '单元', width: '170px',
        form: true, type: 'link', linkOptions: units,
        filter: true, filterParam: '单元__has', filterOptions: units.map((x) => x.label),
        hint: '冗余存一份，便于按单元直接筛部署记录',
      },
      { key: '备注', label: '备注', width: '200px', form: true, type: 'textarea', list: false, fieldHeight: 80 },
      { key: '更新时间', label: '更新时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
    ],
    [unitClasses, blocks, sessions, units],
  );

  // ── 单元挂成果 ────────────────────────────────────────────────────
  const outcomeColumns = useMemo<CrudColumn[]>(
    () => [
      {
        key: '所属单元', label: '所属单元', width: '200px',
        form: true, required: true, type: 'link', linkOptions: units,
        filter: true, filterParam: '所属单元__has', filterOptions: units.map((x) => x.label),
      },
      {
        key: '学习成果', label: '学习成果', width: '220px',
        form: true, required: true, type: 'link', linkOptions: outcomes,
        filter: true, filterParam: '学习成果__has', filterOptions: outcomes.map((x) => x.label),
      },
      {
        key: '成果改写', label: '成果改写', width: '320px',
        form: true, type: 'textarea', fieldHeight: 80,
        hint: '留空 = 直接用成果库原文；要贴合本单元时在此改写',
      },
      { key: '排序', label: '排序', width: '70px', form: true, type: 'number' },
      { key: '更新时间', label: '更新时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
    ],
    [units, outcomes],
  );

  const summary = coverage?.汇总;

  return (
    <>
      {!editing && (
        <Tabs<TabKey>
          value={tab}
          onChange={(k) => {
            setTab(k);
            setMsg(null);
            if (k === 'coverage' || k === 'classes') void reloadCoverage();
          }}
          tabs={[
            { key: 'units', label: tl('单元') },
            { key: 'blocks', label: tl('单元环节') },
            { key: 'classes', label: tl('单元开课') },
            { key: 'deployed', label: tl('部署环节') },
            { key: 'outcomes', label: tl('单元挂成果') },
            { key: 'coverage', label: tl('覆盖率') },
          ]}
        />
      )}

      {!editing && msg ? (
        <Notice kind={msg.kind} title={msg.title}>
          {msg.detail}
        </Notice>
      ) : null}
      {!editing && coverageErr ? (
        <Notice kind="error" title={tl('覆盖率读取失败')}>
          {coverageErr}
        </Notice>
      ) : null}

      {tab === 'units' && (
        <CrudPage
          title="单元"
          subtitle="单元母版挂在课程方案上，可复用到不同学年与教学班；环节与成果都挂在单元下"
          moduleKey="curriculum"
          columns={unitColumns}
          statusField="单元状态"
          transitions={UNIT_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索单元名称 / 描述' }}
          api={{
            list: (p) => api.curriculumUnits.list(p),
            create: (d) => api.curriculumUnits.create(d),
            update: (id, d) => api.curriculumUnits.update(id, d),
            archive: (id) => api.curriculumUnits.archive(id),
            transition: (id, to) => api.curriculumUnits.transition(id, to),
          }}
        />
      )}

      {tab === 'blocks' && (
        <CrudPage
          title="单元环节"
          subtitle="单元内的教学环节；「排序」决定部署到课次时的先后顺序"
          moduleKey="curriculum"
          columns={blockColumns}
          statusField="环节状态"
          transitions={ON_OFF_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索环节名称 / 描述' }}
          api={{
            list: (p) => api.curriculumUnitBlocks.list(p),
            create: (d) => api.curriculumUnitBlocks.create(d),
            update: (id, d) => api.curriculumUnitBlocks.update(id, d),
            archive: (id) => api.curriculumUnitBlocks.archive(id),
            transition: (id, to) => api.curriculumUnitBlocks.transition(id, to),
          }}
        />
      )}

      {tab === 'classes' && (
        <CrudPage
          title="单元开课"
          subtitle="单元在某教学班的开课区间；填好起止日期后点行内「部署环节到课次」即可排完整个单元"
          moduleKey="curriculum"
          columns={classColumns}
          statusField="开课状态"
          transitions={UNIT_CLASS_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索开课名称 / 备注' }}
          rowExtraActions={deployAction}
          api={{
            list: (p) => api.curriculumUnitClasses.list(p),
            create: (d) => api.curriculumUnitClasses.create(d),
            update: (id, d) => api.curriculumUnitClasses.update(id, d),
            archive: (id) => api.curriculumUnitClasses.archive(id),
            transition: (id, to) => api.curriculumUnitClasses.transition(id, to),
          }}
        />
      )}

      {tab === 'deployed' && (
        <CrudPage
          title="部署环节"
          subtitle="环节落到具体课次的结果，由「单元开课」页的部署动作生成，也可单条微调状态"
          moduleKey="curriculum"
          columns={deployedColumns}
          statusField="部署状态"
          transitions={DEPLOY_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索备注' }}
          api={{
            list: (p) => api.curriculumUnitClassBlocks.list(p),
            create: (d) => api.curriculumUnitClassBlocks.create(d),
            update: (id, d) => api.curriculumUnitClassBlocks.update(id, d),
            archive: (id) => api.curriculumUnitClassBlocks.archive(id),
            transition: (id, to) => api.curriculumUnitClassBlocks.transition(id, to),
          }}
        />
      )}

      {tab === 'outcomes' && (
        <CrudPage
          title="单元挂成果"
          subtitle="把学习成果挂到单元上；需要贴合本单元口径时在「成果改写」里写"
          moduleKey="curriculum"
          columns={outcomeColumns}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索成果改写' }}
          api={{
            list: (p) => api.curriculumUnitOutcomes.list(p),
            create: (d) => api.curriculumUnitOutcomes.create(d),
            update: (id, d) => api.curriculumUnitOutcomes.update(id, d),
            archive: (id) => api.curriculumUnitOutcomes.archive(id),
          }}
        />
      )}

      {tab === 'coverage' && !editing && (
        <div className="page">
          <div className="page-header page-header-row">
            <div>
              <div className="page-eyebrow">CURRICULUM / COVERAGE</div>
              <h1 className="page-title">{tl('课程覆盖率')}</h1>
              <p className="page-subtitle">
                {tl('按教学班汇总单元数与环节部署情况；「部署率」= 已挂到具体课次的环节 ÷ 该班所有单元的环节总数。')}
              </p>
            </div>
            <div className="page-actions">
              <button className="btn btn-outline" onClick={() => void reloadCoverage()}>
                {tl('刷新')}
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 'var(--space-md)',
              marginBottom: 'var(--space-xl)',
            }}
          >
            <StatCard label={tl('教学班数')} value={summary?.教学班数 ?? 0} />
            <StatCard label={tl('单元总数')} value={summary?.单元总数 ?? 0} />
            <StatCard label={tl('进行中')} value={summary?.进行中 ?? 0} />
            <StatCard label={tl('已完成')} value={summary?.已完成 ?? 0} />
            <StatCard label={tl('环节总数')} value={summary?.环节总数 ?? 0} />
            <StatCard
              label={tl('部署率')}
              value={fmtPct(summary?.部署率 ?? 0)}
              sub={`${summary?.已部署课次环节数 ?? 0} / ${summary?.环节总数 ?? 0}`}
            />
          </div>

          {!coverage?.items.length ? (
            <div className="empty-state">
              <div className="empty-state-text">
                {tl('还没有单元开课记录：先到「单元开课」里把单元排到教学班，覆盖率才有数据。')}
              </div>
            </div>
          ) : (
            <>
              <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 700, marginBottom: 'var(--space-md)' }}>
                {tl('按教学班')}
              </h2>
              <div className="data-table-wrap" style={{ marginBottom: 'var(--space-xl)' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{tl('教学班')}</th>
                      <th>{tl('单元总数')}</th>
                      <th>{tl('未开始')}</th>
                      <th>{tl('进行中')}</th>
                      <th>{tl('已完成')}</th>
                      <th>{tl('环节总数')}</th>
                      <th>{tl('已部署环节')}</th>
                      <th>{tl('未部署环节')}</th>
                      <th>{tl('部署率')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.items.map((c) => (
                      <tr key={c.教学班}>
                        <td>{c.教学班名称}</td>
                        <td>{c.单元总数}</td>
                        <td>{c.未开始}</td>
                        <td>{c.进行中}</td>
                        <td>{c.已完成}</td>
                        <td>{c.环节总数}</td>
                        <td>{c.已部署环节数}</td>
                        <td>{c.未部署环节数}</td>
                        <td><CoverageBar value={c.部署率} width={140} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 700, marginBottom: 'var(--space-md)' }}>
                {tl('按单元明细')}
              </h2>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{tl('教学班')}</th>
                      <th>{tl('开课名称')}</th>
                      <th>{tl('单元')}</th>
                      <th>{tl('开课状态')}</th>
                      <th>{tl('开始日期')}</th>
                      <th>{tl('结束日期')}</th>
                      <th>{tl('环节总数')}</th>
                      <th>{tl('已部署环节')}</th>
                      <th>{tl('已完成环节')}</th>
                      <th>{tl('已跳过环节')}</th>
                      <th>{tl('部署率')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.items.flatMap((c) =>
                      c.单元.map((u) => (
                        <tr key={`${c.教学班}-${u.开课}`}>
                          <td>{c.教学班名称}</td>
                          <td>{u.开课名称 || '—'}</td>
                          <td>{u.单元名称}</td>
                          <td>
                            <span className={`status-dot ${statusClassOf(u.开课状态)}`}>{tl(u.开课状态)}</span>
                          </td>
                          <td className="muted">{u.开始日期 || '—'}</td>
                          <td className="muted">{u.结束日期 || '—'}</td>
                          <td>{u.环节总数}</td>
                          <td>{u.已部署环节数}</td>
                          <td>{u.已完成环节数}</td>
                          <td>{u.已跳过环节数}</td>
                          <td><CoverageBar value={u.环节总数 ? u.已部署环节数 / u.环节总数 : 0} width={140} /></td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
