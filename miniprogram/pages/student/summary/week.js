const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");

Page({
  data: {
    summary: null,
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
        url: "/api/v1/me/mastery/week-summary",
        method: "GET",
      });
      const summary = data.summary || null;
      if (summary) {
        // WXML cannot call Array methods — precompute display text
        const names = summary.knowledgeNames || [];
        summary.knowledgeNamesText = names.length ? names.join("、") : "";
      }
      this.setData({ summary, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  onCopy() {
    const text =
      (this.data.summary && this.data.summary.copyText) || "";
    if (!text) {
      wx.showToast({ title: "暂无内容", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: "已复制，可发给家长", icon: "none" });
      },
    });
  },

  goMap() {
    wx.navigateTo({ url: "/pages/student/knowledge/list" });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/student/home/home" });
  },
});
