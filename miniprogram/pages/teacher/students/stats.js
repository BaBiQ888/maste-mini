const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { STATUS_LABEL } = require("../../../utils/media");

Page({
  data: {
    classId: "",
    userId: "",
    stats: null,
    recent: [],
    statusLabels: STATUS_LABEL,
    loading: true,
  },

  onLoad(q) {
    this.setData({
      classId: q.classId || "",
      userId: q.userId || "",
    });
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user || user.role !== "teacher") {
      routeByUser(user);
      return;
    }
    if (this.data.classId && this.data.userId) this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const data = await request({
        url: `/api/v1/classes/${this.data.classId}/students/${this.data.userId}/stats?days=14`,
        method: "GET",
      });
      const stats = data.stats;
      const recent = (stats.recent || []).map((r) => ({
        ...r,
        statusLabel: STATUS_LABEL[r.status] || r.status,
        rateText: r.score != null ? `${r.score}%` : "—",
      }));
      this.setData({ stats, recent, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  goAssignment(e) {
    wx.navigateTo({
      url: `/pages/teacher/assignments/detail?id=${e.currentTarget.dataset.id}`,
    });
  },
});
