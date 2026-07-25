const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");

Page({
  data: {
    classes: [],
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
      const data = await request({ url: "/api/v1/classes", method: "GET" });
      this.setData({ classes: data.classes || [], loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  goJoin() {
    wx.navigateTo({ url: "/pages/student/join/join" });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/student/home/home" });
  },

  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});
