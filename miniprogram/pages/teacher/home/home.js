const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const {
  getCurrentClassId,
  setCurrentClassId,
} = require("../../../utils/class-context");

Page({
  data: {
    nickname: "",
    classes: [],
    current: null,
    pendingGrade: 0,
    dashboard: null,
    recent: [],
    loading: true,
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
    this.setData({ nickname: user.nickname || "老师" });
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const [clsData, asgData] = await Promise.all([
        request({ url: "/api/v1/classes", method: "GET" }),
        request({ url: "/api/v1/assignments", method: "GET" }),
      ]);
      const classes = clsData.classes || [];
      let currentId = getCurrentClassId();
      let current = classes.find((c) => c.id === currentId) || null;
      if (classes.length && !current) {
        current = classes[0];
        setCurrentClassId(current.id);
      }
      if (!classes.length) {
        setCurrentClassId("");
        current = null;
      }

      let dashboard = null;
      let recent = [];
      if (current) {
        try {
          const d = await request({
            url: `/api/v1/classes/${current.id}/dashboard`,
            method: "GET",
          });
          dashboard = d.dashboard;
          recent = (dashboard.recentAssignments || []).map((a) => ({
            ...a,
            rateText:
              a.completionRate != null ? `${a.completionRate}%` : "—",
          }));
        } catch (_) {
          /* ignore */
        }
      }

      this.setData({
        classes,
        current,
        pendingGrade: asgData.pendingGrade || 0,
        dashboard,
        recent,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  goClasses() {
    wx.reLaunch({ url: "/pages/teacher/classes/list" });
  },
  goAssignments() {
    wx.reLaunch({ url: "/pages/teacher/assignments/list" });
  },
  goCreateClass() {
    wx.navigateTo({ url: "/pages/teacher/classes/create" });
  },
  goCreateAssignment() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create" });
  },
  goCreateOnline() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create-online" });
  },
  goCreateDrill() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create-drill" });
  },
  goCreateCheckin() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create-checkin" });
  },
  goQuestions() {
    wx.reLaunch({ url: "/pages/teacher/questions/list" });
  },
  goClassDetail() {
    if (!this.data.current) return;
    wx.navigateTo({
      url: `/pages/teacher/classes/detail?id=${this.data.current.id}`,
    });
  },
  goAssignment(e) {
    wx.navigateTo({
      url: `/pages/teacher/assignments/detail?id=${e.currentTarget.dataset.id}`,
    });
  },
  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});
