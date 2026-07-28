const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");

Page({
  data: {
    year: 0,
    month: 0,
    title: "",
    cells: [],
    completedDates: {},
    totalDays: 0,
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
    this.setData({ loading: true });
    const { year, month } = this.data;
    try {
      const data = await request({
        url: `/api/v1/me/calendar?year=${year}&month=${month}`,
        method: "GET",
      });
      const map = {};
      let totalDays = 0;
      for (const d of data.calendar.days || []) {
        map[d.date] = d.completedCount;
        totalDays += 1;
      }
      this.setData({
        completedDates: map,
        totalDays,
        title: `${year}年${month}月`,
        cells: buildMonthCells(year, month, map),
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
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

function buildMonthCells(year, month, completedMap) {
  const first = new Date(year, month - 1, 1);
  const startWeekday = first.getDay(); // 0 Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) {
    cells.push({ empty: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const count = completedMap[date] || 0;
    cells.push({
      empty: false,
      day: d,
      date,
      done: count > 0,
      count,
    });
  }
  return cells;
}
