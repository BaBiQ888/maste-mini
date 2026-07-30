const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");
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
    interactBadge: 0,
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
      let interactBadge = 0;
      if (current) {
        try {
          const [d, badgeData] = await Promise.all([
            request({
              url: `/api/v1/classes/${current.id}/dashboard`,
              method: "GET",
            }),
            request({
              url: `/api/v1/me/interaction-badge?classId=${current.id}`,
              method: "GET",
            }).catch(() => ({ badge: { total: 0 } })),
          ]);
          dashboard = d.dashboard;
          recent = (dashboard.recentAssignments || []).map((a) => ({
            ...a,
            rateText:
              a.completionRate != null ? `${a.completionRate}%` : "—",
          }));
          interactBadge =
            (badgeData && badgeData.badge && badgeData.badge.total) || 0;
        } catch (_) {
          /* ignore */
        }
      }

      this.setData({
        classes,
        current,
        pendingGrade: asgData.pendingGrade || 0,
        interactBadge,
        dashboard,
        recent,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  goCreateClass() {
    wx.navigateTo({ url: "/pages/teacher/classes/create" });
  },
  goCreateAssignment() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create" });
  },
  goInteract() {
    wx.navigateTo({ url: "/pages/teacher/interact/hub" });
  },
  goAssignments() {
    wx.reLaunch({ url: "/pages/teacher/assignments/list" });
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
