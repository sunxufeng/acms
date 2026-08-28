'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTranslations } from 'next-intl';

const STATUS_OPTS = ['待提交', '已提交', '教师已确认', '教务已审核', '可计费'];
const PERIOD_OPTS = ['上午', '下午', '晚上'];

const TRANSITIONS: Record<string, string[]> = {
  待提交: ['已提交'],
  已提交: ['教师已确认'],
  教师已确认: ['教务已审核'],
  教务已审核: ['可计费'],
};

export default function AttendancePage() {
  const t = useTranslations('teachers');

  const COLUMNS: CrudColumn[] = [
    { key: '教学班文本', label: t('colTeachingClass'), width: '150px', filter: true, filterType: 'text', form: true, type: 'text' },
    { key: '授课教师文本', label: t('colTeachingTeacher'), width: '120px', filter: true, filterType: 'text', form: true, required: true, type: 'text' },
    { key: '出勤日期', label: t('colAttendanceDate'), width: '130px', form: true, type: 'date' },
    { key: '时段', label: t('colPeriod'), width: '90px', filter: true, filterOptions: PERIOD_OPTS, form: true, type: 'select', options: PERIOD_OPTS },
    { key: '计划课时', label: t('colPlannedHours'), width: '90px', form: true, type: 'number' },
    { key: '实到人数', label: t('colActualAttendance'), width: '80px', form: true, type: 'number' },
    { key: '出勤状态', label: t('colStatus'), width: '110px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
    { key: '异常描述', label: t('colAnomalyDesc'), form: true, type: 'textarea' },
    { key: '校区', label: t('colCampus'), width: '100px', form: true, type: 'text' },
  ];

  return (
    <CrudPage
      title={t('titleAttendance')}
      subtitle={t('subtitleAttendance')}
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listAttendances(p),
        create: (d) => api.createAttendance(d),
        update: (id, d) => api.updateAttendance(id, d),
        archive: (id) => api.archiveAttendance(id),
        transition: (id, to) => api.transitionAttendance(id, to),
      }}
      statusField="出勤状态"
      transitions={TRANSITIONS}
      search={{ placeholder: t('searchPlaceholderClassName') }}
    />
  );
}
