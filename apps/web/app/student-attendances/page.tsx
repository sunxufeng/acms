'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import ReviewModal from '../../components/attendance/ReviewModal';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/permissions';
import { useTl } from '../../lib/useTl';
import { COLUMNS, parseAttendanceFromSummary } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function StudentAttendancesPage() {
  const ts = useTranslations('students');
  const tl = useTl();
  const perms = usePermissions();
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  /**
   * 终态审核：需要「教务审核」权限点 `attendance:approve`（系统管理员 / 院级管理 / 教务）。
   * 不用模块级的 `module:studentAttendances:update` —— 生产角色矩阵实测该权限点挂在
   * 教师本人 / student 上，用它会让被考勤的人自己批自己的出勤。
   */
  const canReview = perms.includes('attendance:approve');

  /** 待审核行（弹窗审核对象）；reload 存起来，审核成功后刷新列表 */
  const [review, setReview] = useState<{ rows: Record<string, unknown>[]; reload: () => void } | null>(null);

  const context = useMemo(
    () =>
      buildSelectionContext({
        title: '学生考勤',
        selected,
        fields: [
          ['考勤日期', '考勤日期'],
          ['时段', '时段'],
          ['考勤结果', '考勤结果'],
          ['班级', '班级'],
          ['通知状态', '通知状态'],
        ],
        detailKeys: [
          ['异常描述', '异常描述'],
          ['处理结果', '处理结果'],
        ],
      }),
    [selected],
  );

  const studentCount = useMemo(() => new Set(selected.map((r) => studentName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length
    ? ts('aiSubjectSelected', { count: selected.length, students: studentCount })
    : ts('aiSubjectNone');

  /** ⚠️ CrudPage 对 rowExtraActions / bulkActions 的 label **不做** tl() 翻译，这里自己译好 */
  const rowExtraActions = useMemo(
    () =>
      canReview
        ? [
            {
              label: tl('审核'),
              run: (row: Record<string, unknown>, reload: () => void) => setReview({ rows: [row], reload }),
            },
          ]
        : undefined,
    [canReview, tl],
  );

  const bulkActions = useMemo(
    () =>
      canReview
        ? [
            {
              label: tl('批量审核'),
              run: (rows: Record<string, unknown>[], reload: () => void) => setReview({ rows, reload }),
            },
          ]
        : undefined,
    [canReview, tl],
  );

  const onSaved = useCallback(() => {
    review?.reload();
    setReview(null);
  }, [review]);

  return (
    <>
      <CrudPage
        title="学生考勤"
        subtitle="日常出勤与异常记录（M1 学生域）"
        search={{ placeholder: '搜索学生姓名 / 学年 / 班级…' }}
        columns={COLUMNS}
        enrichPrefill={parseAttendanceFromSummary}
        statusField="考勤状态"
        inlineEdit
        standaloneForm
        studentDetailHref={(row) => '/student-attendances/' + String(row.id)}
        selection
        onSelectionChange={setSelected}
        rowExtraActions={rowExtraActions}
        bulkActions={bulkActions}
        // 报表下钻：起止日期（= 通用 CRUD 的默认区间字段「考勤日期」）与按学生的成员匹配
        rangeFilters={[{ key: '考勤日期', label: '考勤日期', fromParam: 'from', toParam: 'to' }]}
        passthroughParams={['关联学生编号__has']}
        api={{
          list: (p) => api.listStudentAttendances(p),
          // 新建时服务端默认写「待审核」：这里再兜一道，保证记录一定是显式的「待审核」，
          // 而不是靠「没值就当待审核」的归一逻辑（两者都支持，见 attendance-rate.ts）
          create: (d) => api.createStudentAttendance({ 审核状态: '待审核', ...d }),
          update: (id, d) => api.updateStudentAttendance(id, d),
          archive: (id) => api.archiveStudentAttendance(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考招生跟进，按勾选的一条或多条考勤记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条考勤记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="student-attendances-ai-dialog"
        placeholder="输入与学生考勤相关的问题，Enter 发送…"
      />

      {review ? <ReviewModal records={review.rows} onClose={() => setReview(null)} onSaved={onSaved} /> : null}
    </>
  );
}
