const { request, getSid } = require('../../utils/request.js');

const PROFILE_FIELDS = [
  '学生姓名', '学籍号（脱敏）', '当前学段', '入学年级', '班级', '校区', '当前状态',
  '性别', '出生日期', '入学日期', '预计毕业日期', '国籍或地区', '民族',
  '学生手机号', '学生邮箱', '现居住地址', '数据密级',
];

function val(v) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join('、');
  return '' + v;
}

Page({
  data: {
    tab: 'profile',
    loading: false,
    errMsg: '',
    profileRows: [],
    schedule: [],
    grades: [],
    teachers: [],
  },

  onShow() {
    if (!getSid()) {
      wx.redirectTo({ url: '/pages/bind/bind' });
      return;
    }
    this.load(this.data.tab);
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab });
    this.load(tab);
  },

  async load(tab) {
    this.setData({ loading: true, errMsg: '' });
    try {
      if (tab === 'profile') {
        const p = await request('/portal/me');
        const rows = PROFILE_FIELDS.map((f) => ({ k: f, v: val(p[f]) }));
        this.setData({ profileRows: rows });
      } else if (tab === 'schedule') {
        const r = await request('/portal/schedule');
        const rows = (r.items || []).map((s) => ({
          日期: val(s['课次日期']),
          时间: `${val(s['开始时间'])}~${val(s['结束时间'])}`,
          课次: val(s['课次名称']),
          教学班: val(s['教学班'] || s['教学班文本']),
          教师: val(s['主讲教师'] || s['授课教师文本']),
          场地: val(s['场地文本']),
          状态: val(s['课次状态']),
        }));
        this.setData({ schedule: rows });
      } else if (tab === 'grades') {
        const r = await request('/portal/grades');
        const rows = (r.items || []).map((g) => ({
          学科: val(g['学科']),
          学期: val(g['学期']),
          类型: val(g['考核类型']),
          成绩: val(g['成绩']),
          等级: val(g['成绩等级']),
          教师: val(g['任课教师']),
          评语: val(g['教师评语']),
        }));
        this.setData({ grades: rows });
      } else if (tab === 'teachers') {
        const r = await request('/portal/teachers');
        const cards = (r.items || []).map((t) => ({
          姓名: val(t['教师姓名']),
          meta: [val(t['教师类别']), val(t['主要学科']), val(t['所属部门'])].filter((x) => x && x !== '—').join(' · '),
          简介: val(t['简介']),
        }));
        this.setData({ teachers: cards });
      }
    } catch (e) {
      const msg = (e && e.message) || '加载失败';
      this.setData({ errMsg: msg.indexOf('未关联') >= 0 ? '当前账号未关联到学生档案' : msg });
    } finally {
      this.setData({ loading: false });
    }
  },

  goBack() {
    wx.navigateBack({ delta: 1 });
  },
});
