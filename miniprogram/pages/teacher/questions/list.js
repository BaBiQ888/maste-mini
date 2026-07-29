const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");
const { attachKnowledgeLabels } = require("../../../utils/knowledge");

const TYPE_LABEL = {
  fill_blank: "填空",
  choice: "选择",
  true_false: "判断",
};

Page({
  data: {
    questions: [],
    loading: true,
    typeLabels: TYPE_LABEL,
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
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const data = await request({ url: "/api/v1/questions", method: "GET" });
      const questions = await attachKnowledgeLabels(data.questions || []);
      this.setData({ questions, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  goCreate() {
    wx.navigateTo({ url: "/pages/teacher/questions/edit" });
  },

  goEdit(e) {
    wx.navigateTo({
      url: `/pages/teacher/questions/edit?id=${e.currentTarget.dataset.id}`,
    });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/teacher/home/home" });
  },
  goClasses() {
    wx.reLaunch({ url: "/pages/teacher/classes/list" });
  },
  goAssignments() {
    wx.reLaunch({ url: "/pages/teacher/assignments/list" });
  },
  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});
