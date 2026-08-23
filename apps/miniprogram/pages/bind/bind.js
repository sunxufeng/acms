const { request, setSid } = require('../../utils/request.js');

Page({
  data: {
    code: '',
    studentNo: '',
    name: '',
    loading: false,
    errMsg: '',
    needForm: false, // 是否显示绑定表单（首次或尚未绑定）
  },

  onLoad() {
    this.prepareLogin();
  },

  // 取 wx.login code，并尝试直接登录（若已绑定则无需填表）
  prepareLogin() {
    wx.login({
      success: (res) => {
        this.setData({ code: res.code });
        this.tryLogin({ code: res.code });
      },
      fail: () => {
        this.setData({ needForm: true, errMsg: '无法获取登录凭证，请重试' });
      },
    });
  },

  async tryLogin(body) {
    this.setData({ loading: true, errMsg: '' });
    try {
      const res = await request('/student/auth/wechat-login', { method: 'POST', data: body });
      if (res.needBind) {
        // 尚未绑定：展示表单让用户输入学号 + 姓名
        this.setData({ needForm: true });
        return;
      }
      this.onBound(res);
    } catch (e) {
      const msg = (e && e.message) || '登录失败';
      // 未配置微信凭证（本地调试）给明确提示
      if (msg.indexOf('WECHAT_NOT_CONFIGURED') >= 0) {
        this.setData({ needForm: true, errMsg: '后端未配置微信小程序 AppID/Secret，暂无法登录' });
      } else {
        this.setData({ needForm: true, errMsg: msg });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  onBound(res) {
    setSid(res.sessionId);
    wx.setStorageSync('acms_profile', {
      studentId: res.studentId,
      name: res.name,
      campus: res.campus,
    });
    wx.showToast({ title: '登录成功', icon: 'success' });
    setTimeout(() => wx.redirectTo({ url: '/pages/index/index' }), 700);
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  async submit() {
    const { code, studentNo, name } = this.data;
    if (!studentNo || !name) {
      this.setData({ errMsg: '请填写学号和姓名' });
      return;
    }
    this.setData({ errMsg: '' });
    await this.tryLogin({ code, studentNo, name });
  },
});
