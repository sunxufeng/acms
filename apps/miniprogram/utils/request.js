// 小程序端统一请求封装：携带 acms_sid 会话头，统一错误处理。
const SID_KEY = 'acms_sid';

function getSid() {
  return wx.getStorageSync(SID_KEY) || '';
}
function setSid(sid) {
  if (sid) wx.setStorageSync(SID_KEY, sid);
  else wx.removeStorageSync(SID_KEY);
}

/**
 * @param {string} path 如 '/student/auth/wechat-login'（不含基址，含 /api/v1 前缀由调用方拼）
 * @param {object} opts { method, data, auth }
 */
function request(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const auth = opts.auth !== false;
  const header = { 'Content-Type': 'application/json' };
  const sid = getSid();
  if (auth && sid) header['x-acms-sid'] = sid;

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getApp().globalData.apiBase}${path}`,
      method,
      data: opts.data,
      header,
      success(res) {
        if (res.statusCode === 401) {
          setSid('');
          reject(new Error('UNAUTHENTICATED'));
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const body = res.data || {};
          const msg =
            (body.error && body.error.message) ||
            (body.message) ||
            `HTTP ${res.statusCode}`;
          reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        }
      },
      fail(err) {
        reject(err);
      },
    });
  });
}

module.exports = { request, getSid, setSid };
