const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");

Page({
  data: {
    summary: null,
    classes: [],
    classId: "",
    loading: true,
    shareBusy: false,
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
      const [data, cls] = await Promise.all([
        request({
          url: "/api/v1/me/mastery/week-summary",
          method: "GET",
        }),
        request({ url: "/api/v1/classes", method: "GET" }).catch(() => ({
          classes: [],
        })),
      ]);
      const summary = data.summary || null;
      if (summary) {
        // WXML cannot call Array methods — precompute display text
        const names = summary.knowledgeNames || [];
        summary.knowledgeNamesText = names.length ? names.join("、") : "";
      }
      const classes = cls.classes || [];
      this.setData({
        summary,
        classes,
        classId: classes[0] ? classes[0].id : "",
        loading: false,
      });
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

  async shareToTeacher() {
    const summary = this.data.summary;
    if (!summary || !summary.copyText) {
      wx.showToast({ title: "暂无内容", icon: "none" });
      return;
    }
    if (!this.data.classId) {
      wx.showToast({ title: "请先加入班级", icon: "none" });
      return;
    }
    if (this.data.shareBusy) return;
    this.setData({ shareBusy: true });
    try {
      await request({
        url: "/api/v1/me/week-share",
        method: "POST",
        data: {
          classId: this.data.classId,
          weekLabel: summary.weekLabel || "本周",
          copyText: summary.copyText,
          payload: {
            litDays: summary.litDays,
            completedTaskCount: summary.completedTaskCount,
          },
        },
      });
      wx.showToast({ title: "已发给老师", icon: "success" });
    } catch (e) {
      showError(e, { tag: "week.share", fallback: "发送失败" });
    } finally {
      this.setData({ shareBusy: false });
    }
  },

  goMap() {
    wx.navigateTo({ url: "/pages/student/knowledge/list" });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/student/home/home" });
  },
});
