'use client';

import { useState } from 'react';

export type FieldType = 'text' | 'select' | 'date' | 'multiselect' | 'user' | 'email' | 'phone';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
}

export const STUDENT_SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: '基本信息',
    fields: [
      { key: '学生姓名', label: '学生姓名', type: 'text' },
      { key: '性别', label: '性别', type: 'select', options: ['男', '女', '其他'] },
      { key: '出生日期', label: '出生日期', type: 'date' },
      { key: '姓名拼音', label: '姓名拼音', type: 'text' },
      { key: '英文名', label: '英文名', type: 'text' },
      { key: '曾用名', label: '曾用名', type: 'text' },
      { key: '国籍或地区', label: '国籍或地区', type: 'text' },
      { key: '民族', label: '民族', type: 'text' },
      { key: '籍贯', label: '籍贯', type: 'text' },
      { key: '户籍类型', label: '户籍类型', type: 'select', options: ['城镇', '农村'] },
      { key: '政治面貌', label: '政治面貌', type: 'text' },
    ],
  },
  {
    title: '学籍信息',
    fields: [
      { key: '当前状态', label: '当前状态', type: 'select', options: ['在校', '毕业', '离校'] },
      { key: '班级', label: '班级', type: 'text' },
      { key: '校区', label: '校区', type: 'text' },
      { key: '当前学段', label: '当前学段', type: 'select', options: ['幼儿园', '小学', '初中', '高中', '国际课程'] },
      { key: '当前年级', label: '当前年级', type: 'text' },
      { key: '入学类型', label: '入学类型', type: 'select', options: ['统招', '国际', '插班', '转学'] },
      { key: '入学日期', label: '入学日期', type: 'date' },
      { key: '预计毕业日期', label: '预计毕业日期', type: 'date' },
      { key: '毕业日期', label: '毕业日期', type: 'date' },
      { key: '离校原因', label: '离校原因', type: 'select', options: ['毕业', '转学', '休学', '退学'] },
      { key: '学籍号（脱敏）', label: '学籍号（脱敏）', type: 'text' },
      { key: '毕业学校', label: '毕业学校', type: 'text' },
      { key: '专业学科', label: '专业学科', type: 'text' },
      { key: '就读方式', label: '就读方式', type: 'text' },
      { key: '数据密级', label: '数据密级', type: 'select', options: ['L1', 'L2', 'L3', 'L4'] },
      { key: '档案完整度', label: '档案完整度', type: 'select', options: ['完整', '待补充', '缺失'] },
      { key: '最近核验日期', label: '最近核验日期', type: 'date' },
    ],
  },
  {
    title: '联系方式',
    fields: [
      { key: '证件号码（脱敏）', label: '证件号码（脱敏）', type: 'text' },
      { key: '学生手机号', label: '学生手机号', type: 'phone' },
      { key: '学生邮箱', label: '学生邮箱', type: 'email' },
      { key: '现居住地址', label: '现居住地址', type: 'text' },
      { key: '通讯地址', label: '通讯地址', type: 'text' },
      { key: '邮政编码', label: '邮政编码', type: 'text' },
      { key: '学生微信号', label: '学生微信号', type: 'text' },
      { key: '飞书 Open ID', label: '飞书 Open ID', type: 'text' },
      { key: '学生标签', label: '学生标签', type: 'text' },
      { key: '备注', label: '备注', type: 'text' },
    ],
  },
  {
    title: '健康与安全',
    fields: [
      { key: '健康风险摘要', label: '健康风险摘要', type: 'select', options: ['无', '低风险', '中风险', '高风险'] },
      { key: '特殊支持摘要', label: '特殊支持摘要', type: 'multiselect', options: ['学习支持', '心理支持', '行为支持', '语言支持', '医疗支持'] },
      { key: '宿舍信息', label: '宿舍信息', type: 'text' },
    ],
  },
  {
    title: '招生跟进',
    fields: [
      { key: '来源渠道', label: '来源渠道', type: 'select', options: ['官网', '转介绍', '展会', '社交媒体', '代理', '其他'] },
      { key: '生源跟进状态', label: '生源跟进状态', type: 'select', options: ['新线索', '跟进中', '已报名', '已入学', '已流失'] },
      { key: '招生负责老师', label: '招生负责老师（open_id）', type: 'user' },
      { key: '班主任', label: '班主任（open_id）', type: 'user' },
      { key: '数据负责人', label: '数据负责人（open_id）', type: 'user' },
      { key: '通知状态', label: '通知状态', type: 'select', options: ['未订阅', '订阅中', '退订'] },
    ],
  },
];

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? '')));
  if (typeof v === 'string') return v ? [v] : [];
  return [];
}

export function StudentForm({
  initial,
  onSubmit,
  submitting,
}: {
  initial?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void;
  submitting?: boolean;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    if (initial) {
      for (const section of STUDENT_SECTIONS) {
        for (const f of section.fields) {
          v[f.key] = initial[f.key] ?? (f.type === 'multiselect' || f.type === 'user' ? [] : '');
        }
      }
    }
    return v;
  });

  const setField = (key: string, val: unknown) => setValues((p) => ({ ...p, [key]: val }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = {};
    for (const section of STUDENT_SECTIONS) {
      for (const f of section.fields) {
        const val = values[f.key];
        if (f.type === 'multiselect' || f.type === 'user') {
          const arr = toStringArray(val);
          if (arr.length) data[f.key] = arr;
        } else if (typeof val === 'string' && val.trim()) {
          data[f.key] = val.trim();
        }
      }
    }
    onSubmit(data);
  };

  return (
    <form onSubmit={handleSubmit} style={formStyles.form}>
      {STUDENT_SECTIONS.map((section) => (
        <fieldset key={section.title} style={formStyles.fieldset}>
          <legend style={formStyles.legend}>{section.title}</legend>
          <div style={formStyles.grid}>
            {section.fields.map((f) => (
              <label key={f.key} style={formStyles.label}>
                <span style={formStyles.labelText}>{f.label}</span>
                {f.type === 'select' ? (
                  <select style={formStyles.input} value={String(values[f.key] ?? '')} onChange={(e) => setField(f.key, e.target.value)}>
                    <option value="">—</option>
                    {f.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'multiselect' ? (
                  <select
                    multiple
                    style={{ ...formStyles.input, minHeight: 80 }}
                    value={toStringArray(values[f.key])}
                    onChange={(e) => setField(f.key, Array.from(e.target.selectedOptions).map((o) => o.value))}
                  >
                    {f.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    style={formStyles.input}
                    type={f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}
                    value={String(values[f.key] ?? '')}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <button type="submit" style={formStyles.submit} disabled={submitting}>
        {submitting ? '保存中…' : '保存'}
      </button>
    </form>
  );
}

const formStyles: Record<string, React.CSSProperties> = {
  form: { display: 'flex', flexDirection: 'column', gap: 24 },
  fieldset: { border: '1px solid var(--border)', borderRadius: 10, padding: '16px 20px' },
  legend: { fontWeight: 700, color: 'var(--fg)', padding: '0 8px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 },
  label: { display: 'flex', flexDirection: 'column', gap: 6 },
  labelText: { fontSize: 12, color: 'var(--muted)', fontWeight: 500 },
  input: { padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14 },
  submit: {
    padding: '12px 24px', border: 'none', borderRadius: 8, background: 'var(--brand)',
    color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start',
  },
};
