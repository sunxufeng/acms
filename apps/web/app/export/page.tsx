'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { exportTable } from '../../lib/api';
import { useTl } from '../../lib/useTl';

const TABLES: { key: string; label: string }[] = [
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
  { key: 'homeSchoolComm', label: '家校沟通' },
  { key: 'dailyFollowup', label: '日常跟进' },
  { key: 'stageEvaluation', label: '阶段评价' },
  { key: 'alumniFollowup', label: '校友跟进' },
];

export default function ExportPage() {

  const tl = useTl();
  const tc = useTranslations('common');
  const [selected, setSelected] = useState('studentProfile');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function run() {
    setBusy(true);
    setMsg('');
    try {
      await exportTable(selected);
      setMsg(`已触发下载：${selected}.csv`);
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
      </div>

      <div className="form-fieldset" style={{ maxWidth: 520 }}>
        <legend className="form-legend">{tl('选择导出对象')}</legend>
        <div className="form-grid">
          <div className="form-label">
            <span className="form-label-text">{tl('业务表')}</span>
            <select className="form-input" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {TABLES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}（{t.key}）
                </option>
              ))}
            </select>
          </div>
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
