const { setToken, setUser, getToken, getUser, routeByUser } = require("../../utils/auth");
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
      const data = await request({
        url: "/api/v1/auth/wechat",
        method: "POST",
        data: { code },
      });
      setToken(data.token);
      setUser(data.user);
      const app = getApp();
      app.setUser(data.user);
      routeByUser(data.user);
    } catch (e) {
      wx.showToast({
        title: e.message || "登录失败",
        icon: "none",
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  getWxCode() {
    return new Promise((resolve, reject) => {
      // 开发者工具 / 无 AppID：用本地 mock code，后端 mock openid
      // 正式环境走 wx.login
      wx.login({
        success(res) {
          if (res.code) {
            resolve(res.code);
          } else {
            resolve(`dev_${Date.now()}`);
          }
        },
        fail() {
          resolve(`dev_${Date.now()}`);
        },
      });
    });
  },
});
