const {
  setToken,
  setUser,
  getToken,
  getUser,
  getOrCreateDeviceId,
  routeByUser,
} = require("../../utils/auth");
const { request } = require("../../utils/request");

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
      const title = (e && e.message) || "登录失败";
      console.error("[login]", e);
      wx.showToast({
        title: title.length > 40 ? `${title.slice(0, 40)}…` : title,
        icon: "none",
        duration: 3500,
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
            // no AppID / tool failure — still send a code; deviceId keeps identity stable
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
