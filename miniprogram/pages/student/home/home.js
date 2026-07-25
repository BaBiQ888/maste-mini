const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { STATUS_LABEL } = require("../../../utils/media");

Page({
  data: {
    classes: [],
    tasks: [],
    incompleteCount: 0,
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

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const [cls, asg] = await Promise.all([
        request({ url: "/api/v1/classes", method: "GET" }),
        request({ url: "/api/v1/assignments", method: "GET" }),
      ]);
      const classes = cls.classes || [];
      const assignments = asg.assignments || [];
      const incompleteCount = asg.incompleteCount || 0;
      const tasks = [];
      for (const a of assignments) {
        try {
          const s = await request({
            url: `/api/v1/assignments/${a.id}/my-submission`,
            method: "GET",
          });
          const knowledgeHint =
            a.knowledgePoints && a.knowledgePoints.length
              ? ` · ${a.knowledgePoints.map((k) => k.name).slice(0, 2).join("、")}`
              : "";
          const done = s.submission.status === "completed";
          tasks.push({
            ...a,
            submissionStatus: s.submission.status,
            statusLabel: STATUS_LABEL[s.submission.status] || s.submission.status,
            needDot: !done,
            done,
            knowledgeHint,
          });
        } catch (_) {
          const knowledgeHint =
            a.knowledgePoints && a.knowledgePoints.length
              ? ` · ${a.knowledgePoints.map((k) => k.name).slice(0, 2).join("、")}`
              : "";
          tasks.push({
            ...a,
            submissionStatus: "not_started",
            statusLabel: STATUS_LABEL.not_started,
            needDot: true,
            done: false,
            knowledgeHint,
          });
        }
      }
      this.setData({ classes, tasks, incompleteCount, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  goJoin() {
    wx.navigateTo({ url: "/pages/student/join/join" });
  },
  goClasses() {
    wx.reLaunch({ url: "/pages/student/classes/list" });
  },
  goCalendar() {
    wx.reLaunch({ url: "/pages/student/calendar/calendar" });
  },
  goTask(e) {
    const id = e.currentTarget.dataset.id;
    const type = e.currentTarget.dataset.type;
    if (type === "photo_homework") {
      wx.navigateTo({ url: `/pages/student/task/detail?id=${id}` });
    } else {
      wx.navigateTo({ url: `/pages/student/task/online?id=${id}` });
    }
  },
  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});
