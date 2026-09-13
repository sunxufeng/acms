'use client';

import { useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import {
  DateField,
  DateTimeField,
  Notice,
  Tabs,
  fmtDate,
  fmtDateTime,
  statusClassOf,
} from '../../components/curriculum/fields';

/**
 * 课时教案（Lesson Plans）—— 挂在**课次**上的备课单元。
 *
 * 四个子表：
 *   lessons          课时教案：课题 + 目标/内容/活动流程 + 学生可见 / 家长可见
 *   homework         作业提交：每次提交一个版本，迟交由服务端按截止时间核算
 *   tracker          作业完成：教师侧只记「完成与否」，不含分数
 *   outcomes         课时挂成果：把学习成果挂到具体一节课上（可局部改写成果文本）
 *
 * 刻意的取舍：课次与教学班的候选项只拉最近 200 条 —— 学期课次上千条，
 * 全量灌进下拉框既慢又难找；需要精确定位时先在「排课课次」页按班级/日期筛出课次，
 * 记住时间后再回这里选。
 */

const YES_NO = ['是', '否'];
const LESSON_STATUSES = ['草稿', '已发布', '已归档'];
const HOMEWORK_STATUSES = ['待批改', '已批改', '已退回'];

const LESSON_TRANSITIONS: Record<string, string[]> = {
  草稿: ['已发布'],
  已发布: ['已归档', '草稿'],
  已归档: ['草稿'],
};

const HOMEWORK_TRANSITIONS: Record<string, string[]> = {
  待批改: ['已批改', '已退回'],
  已批改: ['已退回'],
  已退回: ['待批改'],
};

interface LinkOption {
  value: string;
  label: string;
}

interface Options {
  classes: LinkOption[];
  sessions: LinkOption[];
  units: LinkOption[];
  outcomes: LinkOption[];
  lessons: LinkOption[];
}

function buildLessonColumns(o: Options): CrudColumn[] {
  return [
    { key: '课题', label: '课题', width: '220px', form: true, required: true, type: 'text' },
    {
      key: '课次', label: '课次', width: '170px',
      form: true, type: 'link', linkOptions: o.sessions,
      filter: true, filterParam: '课次__has', filterOptions: o.sessions.map((x) => x.label),
      hint: '只列出最近 200 个课次；课次本身在「排课课次」页维护',
    },
    {
      key: '教学班', label: '教学班', width: '150px',
      form: true, type: 'link', linkOptions: o.classes,
      filter: true, filterParam: '教学班__has', filterOptions: o.classes.map((x) => x.label),
    },
    {
      key: '所属单元', label: '所属单元', width: '150px',
      form: true, type: 'link', linkOptions: o.units,
      filter: true, filterParam: '所属单元__has', filterOptions: o.units.map((x) => x.label),
      hint: '填了才能在「课程规划」里按单元汇总这一节的归属',
    },
    { key: '备课教师', label: '备课教师', width: '110px', form: true, type: 'text' },
    {
      key: '备课日期', label: '备课日期', width: '110px',
      form: true, renderField: ({ value, onChange }) => <DateField value={value} onChange={onChange} />,
      render: (v) => <span className="muted">{fmtDate(v)}</span>,
    },
    { key: '教案状态', label: '教案状态', width: '90px', filter: true, filterOptions: LESSON_STATUSES },
    {
      key: '学生可见', label: '学生可见', width: '90px',
      form: true, type: 'select', options: YES_NO, filter: true, filterOptions: YES_NO,
      hint: '设为「是」后学生门户才能看到这一节的教案',
    },
    { key: '家长可见', label: '家长可见', width: '90px', form: true, type: 'select', options: YES_NO },
    {
      key: '教学目标', label: '教学目标', width: '260px',
      form: true, type: 'textarea', list: false, fieldHeight: 90,
      hint: '一节课 2~3 条，写「学生能做到什么」',
    },
    { key: '教学内容', label: '教学内容', width: '260px', form: true, type: 'textarea', list: false, fieldHeight: 120 },
    {
      key: '活动与流程', label: '活动与流程', width: '260px',
      form: true, type: 'textarea', list: false, fieldHeight: 160,
      hint: '按「环节 — 时长 — 师生活动」逐行写',
    },
    { key: '资源清单', label: '资源清单', width: '200px', form: true, type: 'textarea', list: false, fieldHeight: 80 },
    { key: '作业布置', label: '作业布置', width: '200px', form: true, type: 'textarea', list: false, fieldHeight: 80 },
    {
      key: '更新时间', label: '更新时间', width: '150px',
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
    },
  ];
}

function buildHomeworkColumns(o: Options): CrudColumn[] {
  return [
    { key: '作业名称', label: '作业名称', width: '200px', form: true, required: true, type: 'text' },
    {
      key: '教学班', label: '教学班', width: '150px',
      form: true, type: 'link', linkOptions: o.classes,
      filter: true, filterParam: '教学班__has', filterOptions: o.classes.map((x) => x.label),
    },
    {
      key: '课次', label: '课次', width: '160px',
      form: true, type: 'link', linkOptions: o.sessions,
      filter: true, filterParam: '课次__has', filterOptions: o.sessions.map((x) => x.label),
    },
    { key: '学生', label: '学生', width: '160px', form: true, type: 'studentLink', required: true },
    {
      key: '版本号', label: '版本号', width: '80px',
      form: true, type: 'number', hint: '同一份作业的多次提交依次递增，1 为初稿',
    },
    {
      key: '截止时间', label: '截止时间', width: '150px',
      form: true, renderField: ({ value, onChange }) => <DateTimeField value={value} onChange={onChange} />,
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
      hint: '与「提交时间」一起决定是否迟交',
    },
    {
      key: '提交时间', label: '提交时间', width: '150px',
      form: true, renderField: ({ value, onChange }) => <DateTimeField value={value} onChange={onChange} />,
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
    },
    // 是否迟交 / 迟交分钟数 由服务端核算（新建时立即算，事后改动走「重算迟交」），
    // 后端登记为 readonly，这里也只做展示、不给输入框
    {
      key: '是否迟交', label: '是否迟交', width: '90px',
      filter: true, filterOptions: ['是', '否'],
      render: (v) => (String(v ?? '') === '是'
        ? <span className="status-dot status-warn">是</span>
        : <span className="muted">否</span>),
    },
    {
      key: '迟交分钟数', label: '迟交分钟数', width: '100px',
      render: (v) => {
        const n = Number(v ?? 0);
        return n > 0 ? <span title={`约 ${Math.round(n / 60)} 小时`}>{n}</span> : <span className="muted">—</span>;
      },
    },
    { key: '提交状态', label: '提交状态', width: '90px', filter: true, filterOptions: HOMEWORK_STATUSES },
    { key: '提交内容', label: '提交内容', width: '260px', form: true, type: 'textarea', list: false, fieldHeight: 120 },
    {
      key: '附件', label: '附件链接', width: '180px',
      form: true, type: 'text', list: false,
      hint: '多个用「、」分隔（文件先传到网盘再贴链接）',
    },
    {
      key: '更新时间', label: '更新时间', width: '150px',
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
    },
  ];
}

function buildTrackerColumns(o: Options): CrudColumn[] {
  return [
    { key: '作业名称', label: '作业名称', width: '200px', form: true, required: true, type: 'text' },
    {
      key: '教学班', label: '教学班', width: '150px',
      form: true, type: 'link', linkOptions: o.classes,
      filter: true, filterParam: '教学班__has', filterOptions: o.classes.map((x) => x.label),
    },
    { key: '学生', label: '学生', width: '160px', form: true, type: 'studentLink', required: true },
    {
      key: '课次', label: '课次', width: '160px',
      form: true, type: 'link', linkOptions: o.sessions,
      filter: true, filterParam: '课次__has', filterOptions: o.sessions.map((x) => x.label),
    },
    {
      key: '是否完成', label: '是否完成', width: '100px',
      form: true, type: 'select', options: YES_NO, filter: true, filterOptions: YES_NO,
    },
    {
      key: '完成时间', label: '完成时间', width: '150px',
      form: true, renderField: ({ value, onChange }) => <DateTimeField value={value} onChange={onChange} />,
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
    },
    {
      key: '教师确认', label: '教师确认', width: '100px',
      form: true, type: 'select', options: YES_NO, filter: true, filterOptions: YES_NO,
      hint: '学生自报完成后由教师核对',
    },
    { key: '备注', label: '备注', width: '240px', form: true, type: 'textarea', list: false, fieldHeight: 80 },
    {
      key: '更新时间', label: '更新时间', width: '150px',
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
    },
  ];
}

function buildLessonOutcomeColumns(o: Options): CrudColumn[] {
  return [
    {
      key: '课时教案', label: '课时教案', width: '220px',
      form: true, required: true, type: 'link', linkOptions: o.lessons,
      filter: true, filterParam: '课时教案__has', filterOptions: o.lessons.map((x) => x.label),
      hint: '只列出最近 300 条教案',
    },
    {
      key: '学习成果', label: '学习成果', width: '220px',
      form: true, required: true, type: 'link', linkOptions: o.outcomes,
      filter: true, filterParam: '学习成果__has', filterOptions: o.outcomes.map((x) => x.label),
    },
    {
      key: '成果改写', label: '成果改写', width: '300px',
      form: true, type: 'textarea', fieldHeight: 80,
      hint: '留空表示直接用成果库原文；要贴合本节内容时在此改写',
    },
    {
      key: '更新时间', label: '更新时间', width: '150px',
      render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
    },
  ];
}

type TabKey = 'lessons' | 'homework' | 'tracker' | 'outcomes';

/**
 * 关联候选项来自别的模块（课程规划 / 学习成果 / 排课 / 教学班），用户未必都有读权限。
 * 任一请求 403 就整体 Promise.all 失败、所有下拉一起变空 —— 所以逐个兜底，
 * 缺哪个就哪个为空，其余照常可用。
 */
function safe(p: Promise<{ items?: Record<string, unknown>[] }>): Promise<{ items?: Record<string, unknown>[] }> {
  return p.catch(() => ({ items: [] as Record<string, unknown>[] }));
}

export default function LessonPlansPage() {
  const tl = useTl();
  const [tab, setTab] = useState<TabKey>('lessons');
  /** 进入页内表单后隐藏标签页，避免「半页表单 + 半页导航」的错位 */
  const [editing, setEditing] = useState(false);
  const [opts, setOpts] = useState<Options>({ classes: [], sessions: [], units: [], outcomes: [], lessons: [] });
  const [lateMsg, setLateMsg] = useState<{ kind: 'info' | 'ok' | 'error'; title: string; detail?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      safe(api.listTeachingClasses({ pageSize: '200' })),
      safe(api.listSessions({ pageSize: '200' })),
      safe(api.curriculumUnits.list({ pageSize: '300' })),
      safe(api.learningOutcomes.list({ pageSize: '300' })),
      safe(api.lessonEntries.list({ pageSize: '300' })),
    ]).then(([cls, ses, units, outcomes, lessons]) => {
      if (!alive) return;
      const pick = (p: { items?: Record<string, unknown>[] }, key: string): LinkOption[] =>
        (p.items ?? [])
          .map((r) => ({ value: String(r.id ?? ''), label: String(r[key] ?? '') }))
          .filter((x) => x.value && x.label);
      setOpts({
        classes: pick(cls, '教学班名称'),
        sessions: pick(ses, '课次名称'),
        units: pick(units, '单元名称'),
        outcomes: pick(outcomes, '成果名称'),
        lessons: pick(lessons, '课题'),
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  const lessonColumns = useMemo(() => buildLessonColumns(opts), [opts]);
  const homeworkColumns = useMemo(() => buildHomeworkColumns(opts), [opts]);
  const trackerColumns = useMemo(() => buildTrackerColumns(opts), [opts]);
  const lessonOutcomeColumns = useMemo(() => buildLessonOutcomeColumns(opts), [opts]);

  /** 迟交重算：dryRun 只回结果不写库，先看清影响范围再决定是否写回 */
  async function runRecompute(dryRun: boolean) {
    setLateMsg({ kind: 'info', title: tl('正在重算迟交…') });
    try {
      const r = await api.recomputeHomeworkLate({ dryRun });
      setLateMsg({
        kind: 'ok',
        title: dryRun ? tl('迟交预检完成（未写库）') : tl('迟交重算完成'),
        detail: `扫描 ${r.scanned} 条 · 需改 ${r.changed} 条 · 无变化 ${r.unchanged} 条 · 缺时间 ${r.missingTime} 条${
          r.truncated ? '（明细只回前 50 条）' : ''
        }`,
      });
    } catch (e) {
      setLateMsg({ kind: 'error', title: tl('重算失败'), detail: (e as Error).message });
    }
  }

  return (
    <>
      {!editing && (
        <Tabs<TabKey>
          value={tab}
          onChange={(k) => {
            setTab(k);
            setLateMsg(null);
          }}
          tabs={[
            { key: 'lessons', label: tl('课时教案') },
            { key: 'homework', label: tl('作业提交') },
            { key: 'tracker', label: tl('作业完成') },
            { key: 'outcomes', label: tl('课时挂成果') },
          ]}
        />
      )}

      {!editing && lateMsg ? (
        <Notice kind={lateMsg.kind} title={lateMsg.title}>
          {lateMsg.detail}
        </Notice>
      ) : null}

      {tab === 'lessons' && (
        <CrudPage
          title="课时教案"
          subtitle="挂在课次上的备课记录：目标 / 内容 / 活动流程，以及学生与家长是否可见"
          moduleKey="lessonPlan"
          columns={lessonColumns}
          statusField="教案状态"
          transitions={LESSON_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索课题 / 教学目标 / 教学内容' }}
          api={{
            list: (p) => api.lessonEntries.list(p),
            create: (d) => api.lessonEntries.create(d),
            update: (id, d) => api.lessonEntries.update(id, d),
            archive: (id) => api.lessonEntries.archive(id),
            transition: (id, to) => api.lessonEntries.transition(id, to),
          }}
        />
      )}

      {tab === 'homework' && (
        <CrudPage
          title="作业提交"
          subtitle="一次提交一个版本；是否迟交由服务端按「截止时间 vs 提交时间」核算，无需手填"
          moduleKey="lessonPlan"
          columns={homeworkColumns}
          statusField="提交状态"
          transitions={HOMEWORK_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索作业名称 / 提交内容' }}
          extraActions={[
            { label: '迟交预检（不写库）', run: () => runRecompute(true) },
            { label: '重算迟交并写回', run: () => runRecompute(false) },
          ]}
          api={{
            list: (p) => api.homeworkSubmissions.list(p),
            create: (d) => api.homeworkSubmissions.create(d),
            update: (id, d) => api.homeworkSubmissions.update(id, d),
            archive: (id) => api.homeworkSubmissions.archive(id),
            transition: (id, to) => api.homeworkSubmissions.transition(id, to),
          }}
        />
      )}

      {tab === 'tracker' && (
        <CrudPage
          title="作业完成"
          subtitle="只记「完成与否 + 教师确认」，不含分数；分数走成绩册"
          moduleKey="lessonPlan"
          columns={trackerColumns}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索作业名称 / 备注' }}
          api={{
            list: (p) => api.homeworkTrackers.list(p),
            create: (d) => api.homeworkTrackers.create(d),
            update: (id, d) => api.homeworkTrackers.update(id, d),
            archive: (id) => api.homeworkTrackers.archive(id),
          }}
        />
      )}

      {tab === 'outcomes' && (
        <CrudPage
          title="课时挂成果"
          subtitle="把学习成果挂到具体一节课上；需要贴合本节内容时在「成果改写」里写单元口径"
          moduleKey="lessonPlan"
          columns={lessonOutcomeColumns}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索成果改写' }}
          api={{
            list: (p) => api.lessonOutcomes.list(p),
            create: (d) => api.lessonOutcomes.create(d),
            update: (id, d) => api.lessonOutcomes.update(id, d),
            archive: (id) => api.lessonOutcomes.archive(id),
          }}
        />
      )}
    </>
  );
}
