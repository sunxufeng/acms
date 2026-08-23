'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';

export type FieldType = 'text' | 'select' | 'date' | 'multiselect' | 'user' | 'email' | 'phone' | 'textarea' | 'number' | 'typescore';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  /** 若该字段候选项来自字典表，则填字典 key（优先于 options；options 作为离线兜底） */
  dictKey?: string;
  /** 多选字段以单选下拉呈现（存储仍保持数组，兼容飞书多选字段） */
  singleChoice?: boolean;
  /** 数字字段范围（前端校验用） */
  min?: number;
  max?: number;
  /** typescore 专用：类型侧标题（如「英语标化类型」）与成绩侧标题（如「英语标化成绩」） */
  typeLabel?: string;
  scoreLabel?: string;
}

export const STUDENT_SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: '基本信息',
    fields: [
      { key: '学生姓名', label: '学生姓名', type: 'text' },
      { key: '性别', label: '性别', type: 'select', dictKey: '性别', options: ['男', '女'] },
      { key: '出生日期', label: '出生日期', type: 'date' },
      { key: '姓名拼音', label: '姓名拼音', type: 'text' },
      { key: '英文名', label: '英文名', type: 'text' },
      { key: '曾用名', label: '曾用名', type: 'text' },
      { key: '国籍或地区', label: '国籍或地区', type: 'text' },
      { key: '民族', label: '民族', type: 'text' },
      { key: '籍贯', label: '籍贯', type: 'text' },
      { key: '现居住省', label: '现居住省', type: 'select', dictKey: '现居住省' },
      { key: '城市', label: '城市', type: 'select', dictKey: '城市' },
      { key: '户籍类型', label: '户籍类型', type: 'select', dictKey: '户籍类型', options: ['城镇', '农村'] },
      { key: '政治面貌', label: '政治面貌', type: 'select', dictKey: '政治面貌', options: ['群众', '团员', '党员', '无党派'] },
      { key: '入学年份', label: '入学年份', type: 'select', dictKey: '入学年份' },
      { key: 'Arete毕业届', label: 'Arete毕业届', type: 'select', dictKey: 'Arete毕业届', options: ['第1届', '第2届', '第3届', '第4届', '第5届', '第6届'] },
      { key: '毕业届', label: '毕业届', type: 'select', dictKey: '毕业届', options: ['2021', '2022', '2023', '2024', '2025', '2026', '2027'] },
      { key: '日常禁忌', label: '日常禁忌', type: 'text' },
      { key: '宗教信仰', label: '宗教信仰', type: 'text' },
    ],
  },
  {
    title: '学籍信息',
    fields: [
      { key: '学籍号（脱敏）', label: '学籍号（脱敏）', type: 'text' },
      { key: '班级', label: '班级', type: 'select', dictKey: '班级', options: ['Foundation', 'Pre1', 'Pre2', 'Pre3', '大一班'] },
      { key: '校区', label: '校区', type: 'select', dictKey: '校区', options: ['主校区', '东校区', '西校区', '南校区', '北校区', '国际部校区'] },
      { key: '当前学段', label: '当前学段', type: 'select', dictKey: '当前学段', options: ['幼儿园', '小学', '初中', '高中', '国际课程'] },
      { key: '入学年级', label: '入学年级', type: 'select', dictKey: '入学年级', options: ['托班', '小班', '中班', '大班', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '高一', '高二', '高三'] },
      { key: '实际学制', label: '实际学制', type: 'select', dictKey: '实际学制' },
      { key: '入学类型', label: '入学类型', type: 'select', dictKey: '入学类型', options: ['统招', '国际', '插班', '转学'] },
      { key: '入学日期', label: '入学日期', type: 'date' },
      { key: '预计毕业日期', label: '预计毕业日期', type: 'date' },
      { key: '毕业日期', label: '毕业日期', type: 'date' },
      { key: '离校原因', label: '离校原因', type: 'select', dictKey: '离校原因', options: ['毕业', '转学', '休学', '退学'] },
      { key: '毕业学校', label: '毕业学校', type: 'text' },
      { key: '专业学科', label: '专业学科', type: 'text' },
      { key: '就读方式', label: '就读方式', type: 'text' },
      { key: '数据密级', label: '数据密级', type: 'select', dictKey: '数据密级', options: ['L1', 'L2', 'L3', 'L4'] },
      { key: '档案完整度', label: '档案完整度', type: 'select', dictKey: '档案完整度', options: ['完整', '待补充', '缺失'] },
      { key: '当前状态', label: '当前状态', type: 'select', dictKey: '当前状态', options: ['已录未报到', '在校在读', '离校未毕(休学）', '离校未毕(保留学籍）', '毕业', '退学', '放弃入学', '潜在学生'] },
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
      { key: '学生标签', label: '学生标签（可多选/可新建）', type: 'multiselect', dictKey: '学生标签' },
      { key: '特长标签', label: '特长标签', type: 'multiselect', dictKey: '特长标签', singleChoice: true },
      { key: '备注', label: '备注', type: 'text' },
    ],
  },
  {
    title: '健康与安全',
    fields: [
      { key: '健康风险摘要', label: '健康风险摘要', type: 'select', dictKey: '健康风险摘要', options: ['无', '低风险', '中风险', '高风险'] },
      { key: '特殊支持摘要', label: '特殊支持摘要', type: 'multiselect', dictKey: '特殊支持摘要', singleChoice: true, options: ['学习支持', '心理支持', '行为支持', '语言支持', '医疗支持', '经济支持'] },
      { key: '摘要', label: '摘要', type: 'textarea' },
      { key: '宿舍信息', label: '宿舍信息', type: 'textarea' },
      { key: '既往病史', label: '既往病史', type: 'textarea' },
      { key: '心理状态', label: '心理状态', type: 'textarea' },
    ],
  },
  {
    title: '招生跟进',
    fields: [
      { key: '来源渠道', label: '来源渠道', type: 'select', dictKey: '来源渠道', options: ['官网', '转介绍', '展会', '社交媒体', '代理', '其他'] },
      { key: '生源跟进状态', label: '生源跟进状态', type: 'select', dictKey: '生源跟进状态', options: ['新线索', '跟进中', '已报名', '已入学', '已流失'] },
      { key: '通知状态', label: '通知状态', type: 'select', dictKey: '通知状态', options: ['未订阅', '订阅中', '退订', '已发送', '已读'] },
      { key: '原学校', label: '原学校', type: 'text' },
      { key: '原学校类型', label: '原学校类型', type: 'select', dictKey: '原学校类型' },
      { key: '合同状态', label: '合同状态', type: 'select', dictKey: '合同状态' },
      { key: '付款状态', label: '付款状态', type: 'select', dictKey: '付款状态' },
      { key: '奖学金金额', label: '奖学金金额', type: 'text' },
      { key: '家庭关键决策点', label: '家庭关键决策点', type: 'select', dictKey: '家庭关键决策点' },
      { key: '招生负责老师', label: '招生负责老师（open_id）', type: 'user' },
      { key: '班主任', label: '班主任（open_id）', type: 'user' },
      { key: '数据负责人', label: '数据负责人', type: 'user' },
    ],
  },
  {
    title: '入学测试',
    fields: [
      { key: '数学笔试成绩', label: '数学笔试成绩（0-100）', type: 'number', min: 0, max: 100 },
      { key: '英语笔试成绩', label: '英语笔试成绩（0-100）', type: 'number', min: 0, max: 100 },
      { key: '英语口语评分', label: '英语口语评分（0-100）', type: 'number', min: 0, max: 100 },
      { key: '家长面谈情况', label: '家长面谈情况', type: 'textarea' },
      { key: '学生面试情况', label: '学生面试情况', type: 'textarea' },
      { key: '作品集/附加材料评价', label: '作品集/附加材料评价', type: 'textarea' },
      { key: '综合评定等级', label: '综合评定等级', type: 'select', dictKey: '综合评定等级' },
    ],
  },
  {
    title: '学术表现',
    fields: [
      { key: 'GPA成绩', label: 'GPA成绩（类型 + 成绩）', type: 'typescore', dictKey: 'GPA成绩类型', typeLabel: 'GPA成绩类型', scoreLabel: 'GPA成绩' },
      { key: '学术标化成绩', label: '学术标化（类型 + 成绩）', type: 'typescore', dictKey: '学术标化类型', typeLabel: '学术标化类型', scoreLabel: '学术标化成绩' },
      { key: '语言标化成绩', label: '语言标化（含英语，类型 + 成绩）', type: 'typescore', dictKey: '语言标化类型', typeLabel: '语言标化类型', scoreLabel: '语言标化成绩' },
      { key: '预警科目', label: '预警科目', type: 'text' },
      { key: '提升成果', label: '提升成果', type: 'text' },
      { key: '出勤率', label: '出勤率（0%-100%）', type: 'number', min: 0, max: 100 },
      { key: '作业完成率', label: '作业完成率（0%-100%）', type: 'number', min: 0, max: 100 },
      { key: '核心课程表现', label: '核心课程表现', type: 'textarea' },
    ],
  },
  {
    title: '成长表现',
    fields: [
      { key: '社团表现', label: '社团表现', type: 'textarea' },
      { key: '社区服务表现', label: '社区服务表现', type: 'textarea' },
      { key: '企业参访表现', label: '企业参访表现', type: 'textarea' },
      { key: '创新创业PBL表现', label: '创新创业PBL表现', type: 'textarea' },
      { key: 'AI LAB项目表现', label: 'AI LAB项目表现', type: 'textarea' },
      { key: '亮点行动', label: '亮点行动', type: 'textarea' },
      { key: '交付物', label: '交付物', type: 'textarea' },
      { key: '项目导师评语/成长改进建议', label: '项目导师评语/成长改进建议', type: 'textarea' },
      { key: 'IDP导师评语/成长改进建议', label: 'IDP导师评语/成长改进建议', type: 'textarea' },
    ],
  },
  {
    title: '家庭情况',
    fields: [
      { key: '父亲姓名', label: '父亲姓名', type: 'text' },
      { key: '父亲单位', label: '父亲单位', type: 'text' },
      { key: '父亲职位', label: '父亲职位', type: 'text' },
      { key: '父亲电话', label: '父亲电话', type: 'phone' },
      { key: '父亲邮箱', label: '父亲邮箱', type: 'email' },
      { key: '母亲姓名', label: '母亲姓名', type: 'text' },
      { key: '母亲单位', label: '母亲单位', type: 'text' },
      { key: '母亲职位', label: '母亲职位', type: 'text' },
      { key: '母亲电话', label: '母亲电话', type: 'phone' },
      { key: '母亲邮箱', label: '母亲邮箱', type: 'email' },
      { key: '是否企业家庭', label: '是否企业家庭', type: 'select', dictKey: '是否' },
      { key: '是否工坊企业', label: '是否工坊企业', type: 'select', dictKey: '是否' },
      { key: '是否多胎家庭', label: '是否多胎家庭', type: 'select', dictKey: '是否' },
      { key: '家庭地址', label: '家庭地址', type: 'text' },
      { key: '家长期待', label: '家长期待', type: 'textarea' },
    ],
  },
  {
    title: '升学阶段',
    fields: [
      { key: '初始留学意向', label: '初始留学意向', type: 'text' },
      { key: '目标国家', label: '目标国家', type: 'text' },
      { key: '目标院校', label: '目标院校', type: 'text' },
      { key: '意向专业', label: '意向专业', type: 'text' },
      { key: '录取offer', label: '录取offer', type: 'text' },
      { key: '最终入读院校', label: '最终入读院校', type: 'text' },
      { key: '签证情况', label: '签证情况', type: 'select', dictKey: '签证情况' },
      { key: '升学导师', label: '升学导师（open_id）', type: 'user' },
    ],
  },
];

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? '')));
  if (typeof v === 'string') return v ? [v] : [];
  return [];
}

/** 解析证件信息：可能是 JSON 字符串或已是数组，统一返回 {type,number}[] */
function parseDocInfo(v: unknown): { type: string; number: string }[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? safeParseDoc(x) : x) as { type: string; number: string })
      .filter((x) => x && x.type);
  }
  if (typeof v === 'string' && v.trim()) return safeParseDoc(v);
  return [];
}
function safeParseDoc(s: string): { type: string; number: string }[] {
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.filter((x: { type?: string }) => x && x.type);
  } catch {
    /* ignore */
  }
  return [];
}

/** 解析标化成绩（类型 + 成绩）：可能是 JSON 字符串或已是数组，统一返回 {type,score}[] */
function parseTypeScore(v: unknown): { type: string; score: string }[] {
  if (Array.isArray(v)) return v.filter((x) => x && (x.type || x.score));
  if (typeof v === 'string' && v.trim()) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.filter((x) => x && (x.type || x.score));
    } catch {
      /* ignore */
    }
  }
  return [];
}

/** 格式化时间戳（秒或毫秒）为 YYYY-MM-DD HH:mm */
function fmtDateVal(v: unknown): string {
  if (!v) return '';
  const n = Number(v);
  if (!n || isNaN(n)) return String(v ?? '');
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(v);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 头像底色（按姓名稳定取色） */
function avatarColor(name: string): string {
  const palette = ['#2f6df6', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#475569'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

/**
 * 标签输入组件（学生标签 / 特长标签 用）：
 * - 已选标签以 chip 展示，可单独移除；
 * - 下拉展示「数据库里已有的标签」（未选中的），点击即添加；
 * - 输入框可输入新标签，回车即添加（并写回字典，使其进入「已有标签」）。
 */
function TagInput({
  value,
  options,
  onChange,
  onPersist,
  readOnly,
}: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
  onPersist: (tag: string) => void;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const selected = Array.isArray(value) ? value : [];
  const rest = (options ?? []).filter((o) => !selected.includes(o));
  const draftMatch = draft.trim() && !selected.includes(draft.trim()) && !options.includes(draft.trim());

  const add = (tag: string) => {
    const t = tag.trim();
    if (!t || selected.includes(t)) return;
    onChange([...selected, t]);
    if (!options.includes(t)) onPersist(t);
    setDraft('');
    setOpen(false);
  };
  const remove = (tag: string) => onChange(selected.filter((x) => x !== tag));

  return (
    <div className="tag-input-wrap">
      <div className="tag-chips">
        {selected.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            {!readOnly && (
              <button type="button" className="tag-chip-x" onClick={() => remove(t)} aria-label="移除">
                ×
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <input
            className="tag-input"
            placeholder={selected.length ? '继续添加…' : '选择或输入标签'}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(draft);
              }
            }}
          />
        )}
      </div>
      {!readOnly && open && (rest.length > 0 || draftMatch) && (
        <div className="tag-dropdown">
          {rest.map((o) => (
            <div key={o} className="tag-opt" onMouseDown={() => add(o)}>
              {o}
            </div>
          ))}
          {draftMatch && (
            <div className="tag-opt tag-opt-new" onMouseDown={() => add(draft)}>
              新建标签「{draft.trim()}」
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 用户选择器：从用户管理读取姓名→open_id，单选（存储为 [open_id]） */
function UserField({
  value,
  onChange,
  readOnly,
  users,
  title = '选择用户',
}: {
  value: unknown;
  onChange: (v: string[]) => void;
  readOnly: boolean;
  users: { openId: string; name: string; role?: string; campus?: string; teacherType?: string }[];
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ids = toStringArray(value);
  const selectedId = ids[0];
  const selected = users.find((u) => u.openId === selectedId);
  const matched = users.filter(
    (u) => !q || u.name.includes(q) || u.openId.includes(q) || (u.role ?? '').includes(q),
  );
  // 已选中的用户即使不在按类型过滤后的列表里（例如尚未设置教师类型），也始终展示，避免已存值“消失”
  const selectedUser = selectedId ? users.find((u) => u.openId === selectedId) : undefined;
  const filtered =
    selectedUser && !matched.some((u) => u.openId === selectedUser.openId)
      ? [selectedUser, ...matched]
      : matched;
  const pick = (openId: string) => {
    onChange([openId]);
    setOpen(false);
  };
  const modal = (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="user-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="user-picker-head">
          <h3 className="user-picker-title">{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="user-picker-search">
          <input
            className="form-input"
            placeholder="搜索姓名 / 角色 / open_id"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </div>
        <div className="user-picker-list">
          {filtered.length === 0 && <div className="user-picker-empty">无匹配用户</div>}
          {filtered.map((u) => {
            const isSel = u.openId === selectedId;
            return (
              <div
                key={u.openId}
                className={`user-picker-card${isSel ? ' selected' : ''}`}
                onClick={() => pick(u.openId)}
              >
                <span className="user-pick-avatar" style={{ background: avatarColor(u.name) }}>
                  {u.name.charAt(0)}
                </span>
                <div className="user-pick-meta">
                  <div className="user-pick-name">{u.name}</div>
                  <div className="user-pick-sub">{u.role || u.campus || u.openId}</div>
                </div>
                {isSel && <span className="user-pick-check">✓</span>}
              </div>
            );
          })}
        </div>
        <div className="user-picker-foot">
          {selected && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick('')}>
              清除选择
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
  return (
    <div>
      {selected ? (
        <div className="user-pick-current">
          <span className="user-pick-avatar" style={{ background: avatarColor(selected.name) }}>
            {selected.name.charAt(0)}
          </span>
          <div className="user-pick-meta">
            <div className="user-pick-name">{selected.name}</div>
            <div className="user-pick-sub">{selected.role || selected.campus || selected.openId}</div>
          </div>
          {!readOnly && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
              更换
            </button>
          )}
        </div>
      ) : (
        !readOnly && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
            + {title}
          </button>
        )
      )}
      {open && typeof document !== 'undefined' && createPortal(modal, document.body)}
    </div>
  );
}

/** 数据负责人：只读展示（默认当前登录用户，无需选择） */
function UserDisplay({
  value,
  users,
  hint,
}: {
  value: unknown;
  users: { openId: string; name: string; role?: string; campus?: string }[];
  hint?: string;
}) {
  const ids = toStringArray(value);
  const u = users.find((x) => x.openId === ids[0]);
  return (
    <div className="user-pick-current">
      {u ? (
        <span className="user-pick-avatar" style={{ background: avatarColor(u.name) }}>
          {u.name.charAt(0)}
        </span>
      ) : (
        <span className="user-pick-avatar" style={{ background: 'var(--fg-tertiary)' }}>
          {ids[0]?.slice(0, 1) ?? '?'}
        </span>
      )}
      <div className="user-pick-meta">
        <div className="user-pick-name">{u?.name || ids[0] || '未设置'}</div>
        <div className="user-pick-sub">{hint ?? (u?.role || u?.campus || '')}</div>
      </div>
    </div>
  );
}

/** 证件信息编辑器：一组（证件类型 + 证件号码），下方列表展示已填证件号码 */
function DocInfoEditor({
  value,
  onChange,
  options,
  readOnly,
}: {
  value: unknown;
  onChange: (v: { type: string; number: string }[]) => void;
  options: string[];
  readOnly: boolean;
}) {
  const [type, setType] = useState('');
  const [num, setNum] = useState('');
  const list = Array.isArray(value) ? (value as { type: string; number: string }[]) : [];
  const add = () => {
    if (!type) { alert('请选择证件类型'); return; }
    if (!num.trim()) { alert('请填写证件号码'); return; }
    onChange([...list, { type, number: num.trim() }]);
    setType('');
    setNum('');
  };
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i));
  return (
    <div className="docinfo-editor">
      <div className="docinfo-add-row">
        <select className="form-input" value={type} disabled={readOnly} onChange={(e) => setType(e.target.value)}>
          <option value="">证件类型</option>
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <input
          className="form-input"
          placeholder="证件号码"
          value={num}
          disabled={readOnly}
          onChange={(e) => setNum(e.target.value)}
        />
        {!readOnly && (
          <button type="button" className="btn btn-primary btn-sm" onClick={add}>添加</button>
        )}
      </div>
      {list.length > 0 && (
        <table className="data-table docinfo-list">
          <thead>
            <tr>
              <th style={{ width: '40%' }}>证件类型</th>
              <th>证件号码</th>
              {!readOnly && <th style={{ width: 80 }}>操作</th>}
            </tr>
          </thead>
          <tbody>
            {list.map((d, i) => (
              <tr key={i}>
                <td>{d.type}</td>
                <td>{d.number}</td>
                {!readOnly && (
                  <td>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(i)}>删除</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 标化成绩编辑器：一组（类型 + 成绩），下方列表展示已填成绩（仿 证件信息 的 类型 + 号码） */
function TypeScoreEditor({
  value,
  onChange,
  options,
  typeLabel,
  scoreLabel,
  readOnly,
}: {
  value: unknown;
  onChange: (v: { type: string; score: string }[]) => void;
  options: string[];
  typeLabel: string;
  scoreLabel: string;
  readOnly: boolean;
}) {
  const [type, setType] = useState('');
  const [score, setScore] = useState('');
  const list = Array.isArray(value) ? (value as { type: string; score: string }[]) : [];
  const add = () => {
    if (!type) { alert(`请选择${typeLabel}`); return; }
    if (!score.trim()) { alert(`请填写${scoreLabel}`); return; }
    onChange([...list, { type, score: score.trim() }]);
    setType('');
    setScore('');
  };
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i));
  return (
    <div className="docinfo-editor">
      <div className="docinfo-add-row">
        <select className="form-input" value={type} disabled={readOnly} onChange={(e) => setType(e.target.value)}>
          <option value="">{typeLabel}</option>
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <input
          className="form-input"
          placeholder={scoreLabel}
          value={score}
          disabled={readOnly}
          onChange={(e) => setScore(e.target.value)}
        />
        {!readOnly && (
          <button type="button" className="btn btn-primary btn-sm" onClick={add}>添加</button>
        )}
      </div>
      {list.length > 0 && (
        <table className="data-table docinfo-list">
          <thead>
            <tr>
              <th style={{ width: '40%' }}>{typeLabel}</th>
              <th>{scoreLabel}</th>
              {!readOnly && <th style={{ width: 80 }}>操作</th>}
            </tr>
          </thead>
          <tbody>
            {list.map((d, i) => (
              <tr key={i}>
                <td>{d.type}</td>
                <td>{d.score}</td>
                {!readOnly && (
                  <td>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(i)}>删除</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function StudentForm({
  initial,
  onSubmit,
  submitting,
  readOnly,
}: {
  initial?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void;
  submitting?: boolean;
  readOnly?: boolean;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    if (initial) {
      for (const section of STUDENT_SECTIONS) {
        for (const f of section.fields) {
          if (f.type === 'typescore') {
            v[f.key] = parseTypeScore(initial[f.key]);
          } else {
            v[f.key] = initial[f.key] ?? (f.type === 'multiselect' || f.type === 'user' ? [] : '');
          }
        }
      }
      // 证件信息（JSON 数组）单独解析
      v['证件信息'] = parseDocInfo(initial['证件信息']);
    } else {
      v['证件信息'] = [];
    }
    return v;
  });

  // 照片与附件状态
  const [photos, setPhotos] = useState<FileAttachment[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadingAtt, setUploadingAtt] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const attInputRef = useRef<HTMLInputElement>(null);

  // 记录 ID：编辑态由 initial 提供；新建态在首次保存/上传时由表单自动建记录后写入
  const [studentId, setStudentId] = useState<string | undefined>(initial?.id as string | undefined);
  const [saving, setSaving] = useState(false);
  // 防止并发上传时重复建记录：首个 ensureRecord 创建中的 Promise 被复用
  const createPromiseRef = useRef<Promise<string> | null>(null);

  // 从 initial 数据提取照片和附件
  useEffect(() => {
    if (initial) {
      const extractFiles = (v: unknown): FileAttachment[] => {
        if (!v) return [];
        if (Array.isArray(v)) {
          return v.map((item: any) => ({
            file_token: String(item.file_token ?? item ?? ''),
            name: item.name ? String(item.name) : undefined,
            viewUrl: item.viewUrl ? String(item.viewUrl) : undefined,
          })).filter((x: FileAttachment) => x.file_token);
        }
        // 单个对象
        if (typeof v === 'object' && v !== null && (v as any).file_token) {
          return [{
            file_token: String((v as any).file_token),
            name: (v as any).name ? String((v as any).name) : undefined,
            viewUrl: (v as any).viewUrl ? String((v as any).viewUrl) : undefined,
          }];
        }
        return [];
      };
      setPhotos(extractFiles(initial['学生照片']));
      setAttachments(extractFiles(initial['证件与文件']));
    }
  }, [initial]);

type FileAttachment = { file_token: string; name?: string; viewUrl?: string };

/** 附件可访问 URL：优先用后端换发的免 token 临时链接，否则走代理 */
function getFileUrl(att: FileAttachment): string {
  if (att.viewUrl) return att.viewUrl;
  return `/api/v1/files/${encodeURIComponent(att.file_token)}`;
}

/** 照片与附件展示组件（独立子组件，避免类型推断污染主表单） */
function PhotoAttachmentSection({
  photos, attachments, readOnly, studentId,
  uploadingPhoto, uploadingAtt, onPhotoUpload, onAttUpload,
}: {
  photos: FileAttachment[];
  attachments: FileAttachment[];
  readOnly: boolean;
  studentId: string | undefined;
  uploadingPhoto: boolean;
  uploadingAtt: boolean;
  onPhotoUpload: () => void;
  onAttUpload: () => void;
}) {
  return (
    <div className="photo-att-row">
      {/* 照片 */}
      <fieldset className="form-fieldset" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <legend className="form-legend">学生照片</legend>
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-start', gap: 24 }}>
          <div className="student-photo-wrap">
            {photos.length > 0 ? (
              <img
                src={getFileUrl(photos[0])}
                alt=""
                className="student-photo-img"
                onError={(e) => { const t = e.target as HTMLImageElement; t.style.display = 'none'; }}
              />
            ) : (
              <div className="student-photo-placeholder">
                <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>暂无照片</span>
              </div>
            )}
          </div>
          {!readOnly && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
              <button type="button" className="btn btn-outline btn-sm" onClick={onPhotoUpload} disabled={uploadingPhoto}>
                {uploadingPhoto ? '上传中...' : '上传照片'}
              </button>
              {photos.length > 0 && (
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
                  已有 {photos.length} 张
                </span>
              )}
            </div>
          )}
        </div>
      </fieldset>

      {/* 附件 */}
      <fieldset className="form-fieldset" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <legend className="form-legend">证件与文件</legend>
        <div style={{ flex: 1 }}>
          {attachments.length === 0 ? (
            <p style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>暂无附件</p>
          ) : (
            <div className="attachment-list">
              {attachments.map((att, i) => (
                <a key={i} href={getFileUrl(att)} target="_blank" rel="noreferrer" className="attachment-item">
                  <span>{att.name || `文件${i + 1}`}</span>
                </a>
              ))}
            </div>
          )}
        </div>
        {!readOnly && (
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-outline btn-sm" onClick={onAttUpload} disabled={uploadingAtt}>
              {uploadingAtt ? '上传中...' : '上传附件'}
            </button>
          </div>
        )}
      </fieldset>
    </div>
  );
}

  /** 字典表候选项（后端 /api/v1/dictionaries）；加载前用字段自带 options 兜底 */
  const [dicts, setDicts] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let alive = true;
    api
      .dictionaries()
      .then((d) => {
        if (alive) setDicts(d ?? {});
      })
      .catch(() => {
        /* 离线兜底：沿用字段 options */
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 省 → 市级联映射（级联下拉用） */
  const [provinceCities, setProvinceCities] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let alive = true;
    api
      .provinceCities()
      .then((m) => {
        if (alive) setProvinceCities(m ?? {});
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 把新建的标签写回字典（持久化，使「数据库里已经有的标签」随使用增长） */
  const persistTag = useCallback(
    (key: string, tag: string) => {
      setDicts((prev) => {
        const cur = prev[key] ?? [];
        if (cur.includes(tag)) return prev;
        const next = { ...prev, [key]: [...cur, tag] };
        api.updateDictionary(key, next[key]).catch(() => {});
        return next;
      });
    },
    [],
  );

  /** 字段有效候选项：优先字典，其次字段 options */
  const optionsFor = (f: FieldDef): string[] =>
    f.dictKey ? dicts[f.dictKey] ?? f.options ?? [] : f.options ?? [];

  /** 用户列表（招生负责老师 / 班主任 选择器数据源；含角色/校区用于展示） */
  const [users, setUsers] = useState<{ openId: string; name: string; role?: string; campus?: string; teacherType?: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const collected: { openId: string; name: string; role?: string; campus?: string; teacherType?: string }[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const params: Record<string, string | undefined> = { pageSize: '100' };
      if (token) params.pageToken = token;
      const p = await api.listUsers(params);
      for (const u of p.items) {
        collected.push({
          openId: String(u['飞书 Open ID'] ?? ''),
          name: String(u['姓名'] ?? ''),
          role: Array.isArray(u['系统角色']) ? u['系统角色'].join('、') : String(u['系统角色'] ?? ''),
          campus: String(u['默认校区'] ?? ''),
          teacherType: String(u['教师类型'] ?? ''),
        });
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => {
        if (alive) setUsers(collected.filter((u) => u.openId));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 当前登录用户（新建时把「数据负责人」默认设为本人） */
  useEffect(() => {
    if (initial) return; // 编辑态不覆盖已有值
    let alive = true;
    api
      .me()
      .then((me) => {
        if (!alive) return;
        setValues((p) => {
          const cur = toStringArray(p['数据负责人']);
          if (cur.length) return p;
          return { ...p, '数据负责人': [me.openId] };
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [initial]);

  const setField = (key: string, val: unknown) => setValues((p) => ({ ...p, [key]: val }));

  /** 收集当前表单字段（与提交一致） */
  const buildData = (): Record<string, unknown> => {
    const data: Record<string, unknown> = {};
    for (const section of STUDENT_SECTIONS) {
      for (const f of section.fields) {
        const val = values[f.key];
        if (f.type === 'typescore') {
          const arr = Array.isArray(val) ? (val as { type: string; score: string }[]) : [];
          if (arr.length) data[f.key] = JSON.stringify(arr);
        } else if (f.type === 'multiselect' || f.type === 'user') {
          const arr = toStringArray(val);
          if (arr.length) data[f.key] = arr;
        } else if (typeof val === 'string' && val.trim()) {
          data[f.key] = val.trim();
        }
      }
    }
    // 证件信息：结构化数组序列化为 JSON 字符串写入 Base 文本字段
    const docs = Array.isArray(values['证件信息']) ? (values['证件信息'] as { type: string; number: string }[]) : [];
    if (docs.length) data['证件信息'] = JSON.stringify(docs);
    return data;
  };

  /** 确保已有记录 ID：新建态首次上传/保存时自动建记录（并发安全，避免重复建记录） */
  const ensureRecord = async (): Promise<string> => {
    if (studentId) return studentId;
    if (createPromiseRef.current) return createPromiseRef.current;
    const p = (async () => {
      const created = await api.createStudent(buildData());
      setStudentId(created.id);
      return created.id;
    })();
    createPromiseRef.current = p;
    return p;
  };

  /** 上传照片 */
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 仅允许图片
    if (!file.type.startsWith('image/')) { alert('请选择图片文件'); return; }
    if (!values['学生姓名']?.toString().trim()) { alert('请先填写「学生姓名」再上传照片'); return; }
    setUploadingPhoto(true);
    try {
      const id = await ensureRecord();
      const res = await api.uploadStudentPhoto(id, file);
      setPhotos((prev) => [...prev, { file_token: res.file_token, viewUrl: res.viewUrl }]);
    } catch (err) { alert('上传失败：' + (err as Error).message); }
    finally { setUploadingPhoto(false); if (photoInputRef.current) photoInputRef.current.value = ''; }
  };

  /** 上传附件 */
  const handleAttUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!values['学生姓名']?.toString().trim()) { alert('请先填写「学生姓名」再上传附件'); return; }
    setUploadingAtt(true);
    try {
      const id = await ensureRecord();
      const res = await api.uploadStudentAttachment(id, file);
      setAttachments((prev) => [...prev, { file_token: res.file_token, name: res.name, viewUrl: res.viewUrl }]);
    } catch (err) { alert('上传失败：' + (err as Error).message); }
    finally { setUploadingAtt(false); if (attInputRef.current) attInputRef.current.value = ''; }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = buildData();
    setSaving(true);
    try {
      if (studentId) {
        await api.updateStudent(studentId, data);
      } else {
        const created = await api.createStudent(data);
        setStudentId(created.id);
      }
      onSubmit(data);
    } catch (err) { alert('保存失败：' + (err as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* 照片与附件区域 */}
      <PhotoAttachmentSection
        photos={photos}
        attachments={attachments}
        readOnly={!!readOnly}
        studentId={studentId}
        uploadingPhoto={uploadingPhoto}
        uploadingAtt={uploadingAtt}
        onPhotoUpload={() => photoInputRef.current?.click()}
        onAttUpload={() => attInputRef.current?.click()}
      />
      <input ref={photoInputRef} type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: 'none' }} />
      <input ref={attInputRef} type="file" onChange={handleAttUpload} style={{ display: 'none' }} />

      {STUDENT_SECTIONS.map((section) => (
        <fieldset key={section.title} className="form-fieldset">
          <legend className="form-legend">{section.title}</legend>
          <div className="form-grid">
            {section.fields.map((f) => (
              <label key={f.key} className="form-label">
                <span className="form-label-text">{f.label}</span>
                {f.type === 'select' ? (
                  <select
                    className="form-input"
                    value={String(values[f.key] ?? '')}
                    disabled={readOnly}
                    onChange={(e) => {
                      setField(f.key, e.target.value);
                      if (f.key === '现居住省') setField('城市', ''); // 省变化 → 清空城市（级联）
                    }}
                  >
                    <option value="">—</option>
                    {(f.key === '城市'
                      ? (provinceCities[String(values['现居住省'] ?? '')] ?? [])
                      : optionsFor(f)
                    ).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : f.type === 'multiselect' ? (
                  f.key === '学生标签' ? (
                    <TagInput
                      value={toStringArray(values[f.key])}
                      options={dicts[f.key] ?? []}
                      onChange={(v) => setField(f.key, v)}
                      onPersist={(t) => persistTag(f.key, t)}
                      readOnly={!!readOnly}
                    />
                  ) : (
                  <select
                    multiple={!f.singleChoice}
                    className="form-input"
                    style={f.singleChoice ? undefined : { minHeight: 80 }}
                    value={
                      f.singleChoice
                        ? toStringArray(values[f.key])[0] ?? ''
                        : toStringArray(values[f.key])
                    }
                    disabled={readOnly}
                    onChange={(e) =>
                      setField(
                        f.key,
                        f.singleChoice
                          ? (e.target.value ? [e.target.value] : [])
                          : Array.from(e.target.selectedOptions).map((o) => o.value),
                      )
                    }
                  >
                    {f.singleChoice && <option value="">—</option>}
                    {optionsFor(f).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                  )
                ) : f.type === 'number' ? (
                  <input
                    className="form-input"
                    type="number"
                    min={f.min}
                    max={f.max}
                    value={String(values[f.key] ?? '')}
                    disabled={readOnly}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                ) : f.type === 'typescore' ? (
                  <TypeScoreEditor
                    value={values[f.key]}
                    onChange={(v) => setField(f.key, v)}
                    options={optionsFor(f)}
                    typeLabel={f.typeLabel ?? '类型'}
                    scoreLabel={f.scoreLabel ?? '成绩'}
                    readOnly={!!readOnly}
                  />
                ) : f.type === 'textarea' ? (
                  <textarea
                    className="form-input"
                    style={{ minHeight: 76, resize: 'vertical' }}
                    value={String(values[f.key] ?? '')}
                    disabled={readOnly}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                ) : f.type === 'user' ? (
                  f.key === '数据负责人' ? (
                    <UserDisplay value={values[f.key]} users={users} hint="默认当前登录用户" />
                  ) : (
                    <UserField
                      value={values[f.key]}
                      onChange={(v) => setField(f.key, v)}
                      readOnly={!!readOnly}
                    users={
                      (() => {
                        const hint =
                          f.key === '招生负责老师'
                            ? '招生'
                            : f.key === '升学导师'
                              ? '升学'
                              : '班主任';
                        const strict = users.filter((u) => u.teacherType === hint);
                        if (strict.length) return strict;
                        // 兜底：教师类型未维护时，按系统角色包含关键词匹配
                        const loose = users.filter((u) =>
                          (u.role ?? '').includes(hint) ||
                          (u.teacherType ?? '').includes(hint),
                        );
                        return loose.length ? loose : users;
                      })()
                    }
                    title={
                      f.label.includes('招生')
                        ? '选择招生负责老师'
                        : f.label.includes('升学')
                          ? '选择升学导师'
                          : '选择班主任'
                    }
                    />
                  )
                ) : (
                  <input
                    className="form-input"
                    type={f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}
                    value={readOnly && f.type === 'date' ? fmtDateVal(values[f.key]) : String(values[f.key] ?? '')}
                    disabled={readOnly}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
          {section.title === '联系方式' && (
            <div className="docinfo-block">
              <div className="form-label-text" style={{ margin: 'var(--space-md) 0 var(--space-xs)' }}>证件信息（类型 + 号码）</div>
              <DocInfoEditor
                value={values['证件信息']}
                onChange={(v) => setField('证件信息', v)}
                options={optionsFor({ dictKey: '证件类型' } as FieldDef)}
                readOnly={!!readOnly}
              />
            </div>
          )}
        </fieldset>
      ))}

      {!readOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={saving || submitting}>
            {saving ? '保存中…' : '保存'}
          </button>
          {!initial && (
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
              保存后可直接在此上传照片与附件
            </span>
          )}
        </div>
      )}
    </form>
  );
}
