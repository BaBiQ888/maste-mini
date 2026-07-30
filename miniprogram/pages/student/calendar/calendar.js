const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");

Page({
  data: {
    year: 0,
    month: 0,
    title: "",
    cells: [],
    totalDays: 0,
    streakDays: 0,
    streakLabel: "",
    selected: null,
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
    const now = new Date();
    if (!this.data.year) {
      this.setData({
        year: now.getFullYear(),
        month: now.getMonth() + 1,
      });
    }
    this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    const { year, month } = this.data;
    try {
      const data = await request({
        url: `/api/v1/me/calendar?year=${year}&month=${month}`,
        method: "GET",
      });
      const dayMap = {};
      let totalDays = 0;
      for (const d of data.calendar.days || []) {
        dayMap[d.date] = d;
        if (d.completedCount > 0) totalDays += 1;
      }
      const monthLit =
        data.calendar.monthLitDays != null
          ? Number(data.calendar.monthLitDays)
          : totalDays;
      const streakDays = Number(data.calendar.streakDays) || 0;
      const streakLabel =
        streakDays <= 0
          ? "今天点亮一格就好"
          : streakDays === 1
            ? "今天已点亮 · 连续 1 天"
            : `连续点亮 ${streakDays} 天`;
      this.setData({
        totalDays: monthLit,
        streakDays,
        streakLabel,
        title: `${year}年${month}月`,
        cells: buildMonthCells(year, month, dayMap),
        selected: null,
        loading: false,
        loadError: false,
      });
    } catch (e) {
      this.setData({ loading: false, loadError: true });
      showError(e, { fallback: "加载失败" });
    }
  },

  prevMonth() {
    let { year, month } = this.data;
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    this.setData({ year, month }, () => this.load());
  },

  nextMonth() {
    let { year, month } = this.data;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    this.setData({ year, month }, () => this.load());
  },

  onDay(e) {
    const date = e.currentTarget.dataset.date;
    const state = e.currentTarget.dataset.state;
    const count = e.currentTarget.dataset.count;
    const overdue = e.currentTarget.dataset.overdue;
    const review = e.currentTarget.dataset.review;
    if (!date) return;
    let tip = "这一天还没有记录";
    if (state === "done") tip = `完成 ${count} 项 · 节奏不错`;
    else if (state === "partial")
      tip = `完成 ${count} 项 · 其中 ${overdue || 0} 项曾逾期`;
    else if (state === "review_due") tip = "有巩固回访待完成";
    if (review === "1" && state === "done") tip += " · 还有回访";
    this.setData({
      selected: { date, tip, state },
    });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/student/home/home" });
  },
  goClasses() {
    wx.reLaunch({ url: "/pages/student/classes/list" });
  },
  goKnowledge() {
    wx.navigateTo({ url: "/pages/student/knowledge/list" });
  },
  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});

function buildMonthCells(year, month, dayMap) {
  const first = new Date(year, month - 1, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) {
    cells.push({ empty: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const info = dayMap[date] || {};
    const completedCount = info.completedCount || 0;
    const state = info.state || (completedCount > 0 ? "done" : "none");
    cells.push({
      empty: false,
      day: d,
      date,
      state,
      count: completedCount,
      overdueCount: info.overdueCount || 0,
      hasReviewDue: !!info.hasReviewDue,
      done: state === "done",
      partial: state === "partial",
      reviewOnly: state === "review_due",
    });
  }
  return cells;
}
