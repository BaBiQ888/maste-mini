const {
  setToken,
  setUser,
  getToken,
  getUser,
  getOrCreateDeviceId,
  routeByUser,
} = require("../../utils/auth");
const { request } = require("../../utils/request");
const { showError } = require("../../utils/errors");

Page({
  data: {
    loading: false,
  },

  onShow() {
    const token = getToken();
    const user = getUser();
    if (token && user) {
      routeByUser(user);
    }
  },

  async onLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const code = await this.getWxCode();
      const deviceId = getOrCreateDeviceId();
      const data = await request({
        url: "/api/v1/auth/wechat",
        method: "POST",
        data: { code, deviceId },
      });
      setToken(data.token);
      setUser(data.user);
      const app = getApp();
      app.setUser(data.user);
      routeByUser(data.user);
    } catch (e) {
      // Full detail in console; user only sees friendly modal
      showError(e, {
        tag: "login",
        fallback: "登录失败，请稍后重试",
        modal: true,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  getWxCode() {
    return new Promise((resolve) => {
      wx.login({
        success(res) {
          if (res.code) {
            resolve(res.code);
          } else {
            resolve(`dev_fallback_${Date.now()}`);
          }
        },
        fail() {
          resolve(`dev_fallback_${Date.now()}`);
        },
      });
    });
  },
});
