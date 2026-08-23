const { request, getSid } = require('../../utils/request.js');
const { formatNow, extractTime, parseGps } = require('../../utils/util.js');

Page({
  data: {
    loading: false,
    needBind: false,
    result: null, // { passed, direction, method, distanceMeters, matchedCampus, time, duplicated }
    ssid: '',
    gpsText: '',
    errMsg: '',
    lastAt: '',
    profile: null,
  },

  onLoad() {
    const profile = wx.getStorageSync('acms_profile') || null;
    this.setData({ profile });
  },

  onShow() {
    if (!getSid()) {
      this.setData({ needBind: true });
      return;
    }
    this.setData({ needBind: false });
    this.autoCheck();
  },

  goBind() {
    wx.redirectTo({ url: '/pages/bind/bind' });
  },

  goPortal() {
    wx.navigateTo({ url: '/pages/portal/portal' });
  },

  // 打开即签到：WiFi + GPS 自动判定
  async autoCheck() {
    this.setData({ loading: true, errMsg: '' });
    try {
      const { ssid, bssid } = await this.getWifi();
      const gps = await this.getLocation();
      const mode = ssid ? 'wifi' : 'gps';
      const body = { mode, at: formatNow() };
      if (ssid) {
        body.ssid = ssid;
        body.bssid = bssid;
      }
      if (gps) body.gps = gps;

      const res = await request('/student-attendances/sign', { method: 'POST', data: body });

      if (res.duplicated) {
        const rec = res.record || {};
        this.setData({
          result: {
            passed: true,
            direction: rec['方向'] || '',
            method: rec['签到方式'] || '',
            distanceMeters: rec['签到距离(米)'] != null ? rec['签到距离(米)'] : null,
            matchedCampus: rec['校区'] || '',
            time: extractTime(rec),
            duplicated: true,
          },
          lastAt: formatNow(),
          ssid: ssid || '',
          gpsText: gps || '',
        });
      } else {
        this.setData({
          result: {
            passed: res.passed,
            direction: res.direction,
            method: res.method,
            distanceMeters: res.distanceMeters != null ? res.distanceMeters : null,
            matchedCampus: res.matchedCampus || '',
            time: formatNow(),
            duplicated: false,
          },
          lastAt: formatNow(),
          ssid: ssid || '',
          gpsText: gps || '',
        });
      }
    } catch (e) {
      const msg = (e && e.message) || '检测失败';
      if (msg === 'UNAUTHENTICATED') {
        this.setData({ needBind: true });
        return;
      }
      this.setData({ errMsg: msg });
    } finally {
      this.setData({ loading: false });
    }
  },

  getWifi() {
    return new Promise((resolve) => {
      wx.startWifi({
        success() {
          wx.getConnectedWifi({
            success(r) {
              resolve({ ssid: (r.wifi && r.wifi.SSID) || '', bssid: (r.wifi && r.wifi.BSSID) || '' });
            },
            fail() {
              resolve({ ssid: '', bssid: '' });
            },
          });
        },
        fail() {
          resolve({ ssid: '', bssid: '' });
        },
      });
    });
  },

  getLocation() {
    return new Promise((resolve) => {
      wx.getLocation({
        type: 'gcj02',
        success(r) {
          resolve(`${r.latitude},${r.longitude}`);
        },
        fail(e) {
          if (e && e.errMsg && e.errMsg.indexOf('auth') >= 0) {
            wx.showModal({
              title: '需要定位权限',
              content: '请在右上角「…」→「设置」中开启定位权限，用于到校打卡。',
              showCancel: false,
            });
          }
          resolve('');
        },
      });
    });
  },

  refresh() {
    this.autoCheck();
  },
});
