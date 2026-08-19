'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

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

const COLUMNS: CrudColumn[] = [
  // ── 列表展示列（仅这些列出现在表格；其余仅出现在新建/编辑表单） ──
  { key: '教师姓名', label: '教师姓名', width: '120px', form: true, required: true, type: 'text' },
  { key: '英文名', label: '英文名', form: true, type: 'text' },
  { key: '教师类别', label: '教师类别', width: '100px', form: true, type: 'select', dictKey: '教师类别' },
  { key: '主要学科', label: '主要学科', form: true, type: 'select', dictKey: '主要学科' },
  { key: '在职合作状态', label: '合作状态', width: '100px', form: true, type: 'select', options: STATUS_OPTS },
  { key: '更新时间', label: '更新', width: '160px', render: (v) => <span className="muted">{fmtUpdate(v)}</span> },

  // ── 仅表单字段 ───────────────────────────────────
  { key: '性别', label: '性别', list: false, form: true, type: 'select', dictKey: '性别' },
  { key: '毕业大学', label: '毕业大学', list: false, form: true, type: 'text' },
  { key: '学历/学位', label: '学历/学位', list: false, form: true, type: 'select', dictKey: '学历/学位' },
  { key: '标准课时(每周)', label: '标准课时(每周)', list: false, form: true, type: 'number' },
  { key: '学期预计总课时', label: '学期预计总课时', list: false, form: true, type: 'number' },
  { key: '每学期预计课酬总额', label: '每学期预计课酬总额', list: false, form: true, type: 'number' },
  { key: '实际课酬总额', label: '实际课酬总额', list: false, form: true, type: 'number' },
  { key: '内部对接人', label: '内部对接人（用户管理）', list: false, form: true, type: 'person' },
  { key: '手机号', label: '手机号', list: false, form: true, type: 'text' },
  { key: '微信号', label: '微信号', list: false, form: true, type: 'text' },
  { key: '邮箱', label: '邮箱', list: false, form: true, type: 'text' },
  { key: '所属部门', label: '所属部门', list: false, form: true, type: 'text' },
  { key: '常驻城市', label: '常驻城市', list: false, form: true, type: 'text' },
  { key: '外聘归属类型', label: '外聘归属类型', list: false, form: true, type: 'text' },
  { key: '入职或首次合作日期', label: '入职或首次合作日期', list: false, form: true, type: 'date' },
  { key: '离职或终止日期', label: '离职或终止日期', list: false, form: true, type: 'date' },
  { key: '授课学段', label: '授课学段', list: false, form: true, type: 'select', dictKey: '授课学段' },
  { key: '授课科目类型', label: '授课科目类型', list: false, form: true, type: 'select', dictKey: '授课科目类型' },
  { key: '授课科目', label: '授课科目', list: false, form: true, type: 'multiselect', dictKey: '授课科目' },
  { key: '合作开始时间', label: '合作开始时间', list: false, form: true, type: 'select', dictKey: '合作开始时间' },
  { key: '开课人数说明', label: '开课人数说明', list: false, form: true, type: 'text' },
  { key: '个人描述', label: '个人描述', list: false, form: true, type: 'textarea' },
  { key: '附件', label: '附件', list: false, form: true, type: 'textarea' },
  { key: '教师合作等级', label: '教师合作等级', list: false, form: true, type: 'text' },
  { key: '教学评估', label: '教学评估', list: false, form: true, type: 'textarea' },
  { key: '收款主体', label: '收款主体', list: false, form: true, type: 'select', dictKey: '收款主体' },
  { key: '可授年级与课程', label: '可授年级与课程', list: false, form: true, type: 'text' },
  { key: '资质与证书摘要', label: '资质与证书摘要', list: false, form: true, type: 'textarea' },
  { key: '数据密级', label: '密级', list: false, form: true, type: 'select', dictKey: '数据密级' },
  { key: '备注', label: '备注', list: false, form: true, type: 'textarea' },
];

export default function TeachersPage() {
  return (
    <CrudPage
      title="教师档案"
      subtitle="教师基本信息与师资管理（M2 教师域）"
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listTeachers(p),
        create: (d) => api.createTeacher(d),
        update: (id, d) => api.updateTeacher(id, d),
        archive: (id) => api.archiveTeacher(id),
      }}
    />
  );
}
