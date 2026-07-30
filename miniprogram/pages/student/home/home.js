const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { STATUS_LABEL, assignmentTypeLabel } = require("../../../utils/media");
const { showError, logError } = require("../../../utils/errors");

Page({
  data: {
    classes: [],
    requiredTasks: [],
    doneTasks: [],
    reviewCard: null,
    incompleteCount: 0,
    streakDays: 0,
    monthLitDays: 0,
    streakLabel: "",
    allClear: false,
    emptyTip: "今日空页。可翻翻知识地图，或等老师布置。",
    loading: true,
    loadError: false,
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
    this.setData({ loading: true, loadError: false });
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const [cls, asg, cal, due] = await Promise.all([
        request({ url: "/api/v1/classes", method: "GET" }),
        request({ url: "/api/v1/assignments", method: "GET" }),
        request({
          url: `/api/v1/me/calendar?year=${year}&month=${month}`,
          method: "GET",
        }).catch((err) => {
          logError("home.calendar", err, { year, month });
          return null;
        }),
        request({
          url: "/api/v1/me/mastery/due",
          method: "GET",
        }).catch((err) => {
          logError("home.masteryDue", err, {});
          return { review: null };
        }),
      ]);
      const classes = cls.classes || [];
      const assignments = asg.assignments || [];
      const incompleteCount = asg.incompleteCount || 0;

      const calendar = (cal && cal.calendar) || {};
      const streakDays = Number(calendar.streakDays) || 0;
      // monthLitDays: 0 is valid — do not fall through with ||
      const monthLitDays =
        calendar.monthLitDays != null
          ? Number(calendar.monthLitDays)
          : (calendar.days && calendar.days.length) || 0;
      const streakLabel =
        streakDays <= 0
          ? "今天点亮一格就好"
          : streakDays === 1
            ? "今天已点亮"
            : `连续点亮 ${streakDays} 天`;

      // myStatus is batched on GET /assignments (no per-id my-submission N+1)
      const tasks = assignments.map((a) =>
        this.mapTask(a, {
          status: a.myStatus || "not_started",
        }),
      );

      // 必做：未完成；已完成单独分组（S1 首页契约）
      const requiredTasks = tasks
        .filter((t) => !t.done)
        .sort((a, b) => {
          const da = a.dueAt || "9999";
          const db = b.dueAt || "9999";
          return da.localeCompare(db);
        });
      const doneTasks = tasks.filter((t) => t.done);
      const reviewCard = (due && due.review) || null;
      const allClear =
        classes.length > 0 &&
        requiredTasks.length === 0 &&
        !reviewCard &&
        tasks.length > 0;

      this.setData({
        classes,
        requiredTasks,
        doneTasks,
        reviewCard,
        incompleteCount,
        streakDays,
        monthLitDays,
        streakLabel,
        allClear,
        loading: false,
        loadError: false,
      });
    } catch (e) {
      this.setData({ loading: false, loadError: true });
      showError(e, { fallback: "加载失败" });
    }
  },

  mapTask(a, submission) {
    const knowledgeHint =
      a.knowledgePoints && a.knowledgePoints.length
        ? ` · ${a.knowledgePoints
            .map((k) => k.name)
            .slice(0, 2)
            .join("、")}`
        : "";
    const status = (submission && submission.status) || "not_started";
    const done = status === "completed";
    return {
      ...a,
      typeLabel: assignmentTypeLabel(a.type),
      submissionStatus: status,
      statusLabel: STATUS_LABEL[status] || status,
      needDot: !done,
      done,
      isWrong: status === "pending_correction",
      knowledgeHint,
    };
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
  goKnowledge() {
    wx.navigateTo({ url: "/pages/student/knowledge/list" });
  },
  goWeekSummary() {
    wx.navigateTo({ url: "/pages/student/summary/week" });
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
  goReview() {
    const card = this.data.reviewCard;
    if (!card || !card.masteryItemId) return;
    wx.navigateTo({
      url: `/pages/student/task/review?itemId=${card.masteryItemId}`,
    });
  },
  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});
