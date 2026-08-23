const config = require('./config.js');

App({
  globalData: {
    apiBase: config.apiBase,
  },
  onLaunch() {
    // 启动时若已绑定会话，直接跳转到打卡页
    const sid = wx.getStorageSync('acms_sid');
    if (sid) {
      // 不强制跳转，保留启动页逻辑由页面自身决定
    }
  },
});
