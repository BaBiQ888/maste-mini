const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");

Page({
  data: {
    items: [],
    loading: true,
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user || user.role !== "student") {
      routeByUser(user);
      return;
    }
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const data = await request({
        url: "/api/v1/me/knowledge-progress",
        method: "GET",
      });
      this.setData({ items: data.items || [], loading: false });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },
});
