'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { useTranslations } from 'next-intl';

const STATUS_OPTS = ['候选', '在职', '离职', '退休', '合作中'];

/** 把「更新时间」字段值（可能是 epoch 毫秒/秒或日期字符串）格式化为 YYYY-MM-DD HH:mm */
function fmtUpdate(v: unknown): string {
  if (v == null || v === '') return '—';
  let ms: number | null = null;
  if (typeof v === 'number') ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) ms = Number(s) > 1e12 ? Number(s) : Number(s) * 1000;
    else {
      const t = Date.parse(s);
      if (!isNaN(t)) ms = t;
    }
  }
  if (ms != null) {
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      const pad = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  return String(v);
}

export default function TeachersPage() {
  const t = useTranslations('teachers');

  const COLUMNS: CrudColumn[] = [
    // ── 列表展示列（仅这些列出现在表格；其余仅出现在新建/编辑表单） ──
    { key: '教师姓名', label: t('colTeacherName'), width: '120px', form: true, required: true, type: 'text' },
    { key: '英文名', label: t('colEnglishName'), form: true, type: 'text' },
    { key: '教师类别', label: t('colTeacherType'), width: '100px', filter: true, form: true, type: 'select', dictKey: '教师类别' },
    { key: '主要学科', label: t('colMajorSubject'), filter: true, form: true, type: 'multiselect', dictKey: '主要学科' },
    { key: '在职合作状态', label: t('colCoopStatus'), width: '100px', filter: true, form: true, type: 'select', options: STATUS_OPTS },
    { key: '更新时间', label: t('colUpdated'), width: '160px', render: (v) => <span className="muted">{fmtUpdate(v)}</span> },

    // ── 仅表单字段 ───────────────────────────────────
    { key: '性别', label: t('colGender'), list: false, form: true, type: 'select', dictKey: '性别' },
    { key: '毕业大学', label: t('colGradSchool'), list: false, form: true, type: 'text' },
    { key: '学历/学位', label: t('colEducation'), list: false, form: true, type: 'select', dictKey: '学历/学位' },
    { key: '标准课时(每周)', label: t('colStdHoursWeekly'), list: false, form: true, type: 'number' },
    { key: '学期预计总课时', label: t('colTermEstTotalHours'), list: false, form: true, type: 'number' },
    { key: '每学期预计课酬总额', label: t('colTermEstPayTotal'), list: false, form: true, type: 'number' },
    { key: '实际课酬总额', label: t('colActualPayTotal'), list: false, form: true, type: 'number' },
    { key: '内部对接人', label: t('colInternalLiaison'), list: false, form: true, type: 'person' },
    { key: '手机号', label: t('colPhone'), list: false, form: true, type: 'text' },
    { key: '微信号', label: t('colWechat'), list: false, form: true, type: 'text' },
    { key: '邮箱', label: t('colEmail'), list: false, form: true, type: 'text' },
    { key: '所属部门', label: t('colDepartment'), list: false, form: true, type: 'text' },
    { key: '常驻城市', label: t('colCity'), list: false, form: true, type: 'text' },
    { key: '外聘归属类型', label: t('colExternalType'), list: false, form: true, type: 'text' },
    { key: '入职或首次合作日期', label: t('colJoinDate'), list: false, form: true, type: 'date' },
    { key: '离职或终止日期', label: t('colLeaveDate'), list: false, form: true, type: 'date' },
    { key: '授课学段', label: t('colTeachStage'), list: false, form: true, type: 'select', dictKey: '授课学段' },
    { key: '授课科目类型', label: t('colTeachSubjectType'), list: false, form: true, type: 'select', dictKey: '授课科目类型' },
    { key: '授课科目', label: t('colTeachSubject'), list: false, form: true, type: 'multiselect', dictKey: '授课科目' },
    { key: '教师合作等级', label: t('colCoopLevel'), list: false, form: true, type: 'select', dictKey: '教师合作等级' },
    { key: '合作开始时间', label: t('colCoopStart'), list: false, form: true, type: 'select', dictKey: '合作开始时间' },
    { key: '开课人数说明', label: t('colClassSizeNote'), list: false, form: true, type: 'text' },
    { key: '个人描述', label: t('colPersonalDesc'), list: false, form: true, type: 'textarea' },
    { key: '教学评估', label: t('colTeachingEval'), list: false, form: true, type: 'textarea' },
    { key: '收款主体', label: t('colPayee'), list: false, form: true, type: 'select', dictKey: '收款主体' },
    { key: '可授年级与课程', label: t('colGradesCourses'), list: false, form: true, type: 'text' },
    { key: '资质与证书摘要', label: t('colQualificationSummary'), list: false, form: true, type: 'textarea' },
    { key: '备注', label: t('colRemark'), list: false, form: true, type: 'textarea' },
    { key: '附件', label: t('colAttachment'), list: false, form: true, type: 'attachment' },
    { key: '数据密级', label: t('colSecrecyLevel'), list: false, form: true, type: 'select', dictKey: '数据密级' },
  ];

  return (
    <CrudPage
      title={t('titleTeachers')}
      subtitle={t('subtitleTeachers')}
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchPlaceholderTeachers') }}
      api={{
        list: (p) => api.listTeachers(p),
        create: (d) => api.createTeacher(d),
        update: (id, d) => api.updateTeacher(id, d),
        archive: (id) => api.archiveTeacher(id),
      }}
    />
  );
}
