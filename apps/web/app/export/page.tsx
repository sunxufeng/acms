'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { exportTable } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import {
  STUDENT_RECORD_EXPORT_ALL,
  STUDENT_RECORD_EXPORT_KEY,
  STUDENT_RECORD_TYPES,
  STUDENT_RECORD_TYPE_VALUES,
} from '@acms/contracts';
// 下拉统一走全站组件（2026-09-22 第二批）
import { FilterSelect } from '../../components/FilterSelect';

/**
 * 导出对象。`key` = `TABLES` 里的表键；`type` = 只导该「记录类型」（三合一记录表专用）。
 *
 * 🔴 学生记录（三合一）是**一张表 + 一个「记录类型」字段**，所以按类型分别列出来：
 *    合并前的老写法是「日常跟进 → 整张表（5 类全在里面）」「家校沟通 / 学生观察 → 合并前的旧表
 *    （生产实测 0 行，导出来只有表头）」，用户点哪个都拿不到想要的那一类。
 *    现在：同一个表键 + 各自的类型，URL 形如 `/export/dailyFollowup?记录类型=家校沟通`。
 */
interface ExportItem {
  key: string;
  label: string;
  type?: string;
}

const TABLES: ExportItem[] = [
  { key: 'studentProfile', label: '学生档案' },
  { key: 'teacherProfile', label: '教师档案' },
  { key: 'coursePlan', label: '课程方案' },
  { key: 'teachingClass', label: '教学班级' },
  { key: 'session', label: '课次' },
  { key: 'venue', label: '场地' },
  { key: 'enrollment', label: '选课' },
  { key: 'attendance', label: '教师履约考勤' },
  { key: 'partnership', label: '聘用合作关系' },
  { key: 'billingDetail', label: '计费明细' },
  { key: 'monthlySettlement', label: '月度结算' },
  { key: 'adjustment', label: '调整冲销' },
  { key: 'notificationTemplate', label: '通知模板' },
  { key: 'notificationLog', label: '通知记录' },
  { key: 'sourceFollowup', label: '生源跟进' },
  { key: 'attendance', label: '学生考勤' },
  { key: 'academicGrade', label: '学业成绩' },
  { key: 'practiceActivity', label: '实践活动' },
  // 学生记录（日常跟进 / IDP沟通 / 学生沟通 / 学生实践 / 家校沟通 / 学生观察）——
  // 一张表按类型分别导出，清单从类型定义生成，将来再加类型不必改这里。
  ...STUDENT_RECORD_TYPES.map((t) => ({
    key: STUDENT_RECORD_EXPORT_KEY,
    label: `学生记录 · ${t.value}`,
    type: t.value,
  })),
  {
    key: STUDENT_RECORD_EXPORT_KEY,
    label: '学生记录 · 全部类型',
    type: STUDENT_RECORD_EXPORT_ALL,
  },
  { key: 'stageEvaluation', label: '阶段评价' },
  { key: 'alumniFollowup', label: '校友跟进' },
];

/** 下拉的 value：带类型时用 `表键::类型`（表键本身不含 `::`） */
const itemValue = (it: ExportItem) => (it.type ? `${it.key}::${it.type}` : it.key);

const ITEM_BY_VALUE: Record<string, ExportItem> = Object.fromEntries(
  TABLES.map((it) => [itemValue(it), it]),
);

export default function ExportPage() {

  const tl = useTl();
  const tc = useTranslations('common');
  const [selected, setSelected] = useState(itemValue(TABLES[0]!));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function run() {
    setBusy(true);
    setMsg('');
    const item = ITEM_BY_VALUE[selected];
    try {
      const name = await exportTable(item?.key ?? selected, item?.type, item?.label ?? selected);
      setMsg(`已触发下载：${name}`);
    } catch (e) {
      setMsg('导出失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">{tl('数据导出')}</h1>
        <p className="muted">{tl('将任一业务表全量导出为 CSV（含 BOM，Excel 可直接打开）。需「导出」权限（export:run）。')}</p>
        <p className="muted">
          {/* 类型清单**从类型定义生成**（`{types}` 是占位符，渲染时替换）——
              原先这里手写了 5 个类型名，加「IDP沟通」「学生实践」时都要记得回来改，
              漏了不报错，只是页面写着的类型与下拉里能选的对不上。 */}
          {tl('学生记录（{types}）是同一张表，按「记录类型」分别导出；只能导出你本人有权查看的类型。').replace(
            '{types}',
            STUDENT_RECORD_TYPE_VALUES.join(' / '),
          )}
        </p>
      </div>

      <div className="form-fieldset" style={{ maxWidth: 520 }}>
        <legend className="form-legend">{tl('选择导出对象')}</legend>
        <div className="form-grid">
          {/* 业务表是**必选参数**（导出必须指名一张表）⇒ `clearable={false}` */}
          <FilterSelect
            label={tl('业务表')}
            value={selected}
            onChange={setSelected}
            options={TABLES.map((t) => itemValue(t))}
            optionLabels={Object.fromEntries(
              TABLES.map((t) => [itemValue(t), t.type ? t.label : `${t.label}（${t.key}）`]),
            )}
            clearable={false}
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            {busy ? tc('exporting') : tc('exportCsv')}
          </button>
          {msg && <span style={{ marginLeft: 12 }} className="muted">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
