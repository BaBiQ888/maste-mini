const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { fullUrl, STATUS_LABEL, RESULT_LABEL } = require("../../../utils/media");

Page({
  data: {
    id: "",
    assignment: null,
    submissions: [],
    questions: [],
    questionStats: [],
    isPhoto: true,
    summary: null,
    rateText: "—",
    loading: true,
    statusLabels: STATUS_LABEL,
    resultLabels: RESULT_LABEL,
  },

  onLoad(q) {
    this.setData({ id: q.id || "" });
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
    if (this.data.id) this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const [a, s, sum, qs, qst] = await Promise.all([
        request({ url: `/api/v1/assignments/${this.data.id}`, method: "GET" }),
        request({
          url: `/api/v1/assignments/${this.data.id}/submissions`,
          method: "GET",
        }),
        request({
          url: `/api/v1/assignments/${this.data.id}/summary`,
          method: "GET",
        }).catch(() => ({ summary: null })),
        request({
          url: `/api/v1/assignments/${this.data.id}/questions`,
          method: "GET",
        }).catch(() => ({ questions: [] })),
        request({
          url: `/api/v1/assignments/${this.data.id}/question-stats`,
          method: "GET",
        }).catch(() => ({ questions: [] })),
      ]);
      const submissions = (s.submissions || []).map((sub) => ({
        ...sub,
        photoDisplay: (sub.photos || []).map((p) => fullUrl(p.url)),
      }));
      const summary = sum.summary || null;
      const rateText =
        summary && summary.completionRate != null
          ? `${summary.completionRate}%`
          : "—";
      const isPhoto = a.assignment.type === "photo_homework";
      const questionStats = (qst.questions || []).map((q) => ({
        ...q,
        rateText: q.correctRate != null ? `${q.correctRate}%` : "—",
      }));
      this.setData({
        assignment: a.assignment,
        submissions,
        questions: qs.questions || [],
        questionStats,
        isPhoto,
        summary,
        rateText,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  async publish() {
    try {
      const data = await request({
        url: `/api/v1/assignments/${this.data.id}/publish`,
        method: "POST",
      });
      this.setData({ assignment: data.assignment });
      wx.showToast({ title: "已发布", icon: "success" });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || "失败", icon: "none" });
    }
  },

  revoke() {
    wx.showModal({
      title: "下架作业",
      content: "下架后学生不可再提交。确定？",
      confirmColor: "#A63D3D",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const data = await request({
            url: `/api/v1/assignments/${this.data.id}/revoke`,
            method: "POST",
          });
          this.setData({ assignment: data.assignment });
          wx.showToast({ title: "已下架", icon: "success" });
        } catch (e) {
          wx.showToast({ title: e.message || "失败", icon: "none" });
        }
      },
    });
  },

  async duplicate() {
    try {
      const data = await request({
        url: `/api/v1/assignments/${this.data.id}/duplicate`,
        method: "POST",
      });
      wx.showToast({ title: "已复制为草稿", icon: "success" });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/teacher/assignments/detail?id=${data.assignment.id}`,
        });
      }, 400);
    } catch (e) {
      wx.showToast({ title: e.message || "复制失败", icon: "none" });
    }
  },

  async copyReminder() {
    try {
      const data = await request({
        url: `/api/v1/assignments/${this.data.id}/reminder-text`,
        method: "GET",
      });
      wx.setClipboardData({
        data: data.text || "",
        success: () =>
          wx.showToast({ title: "催交文案已复制", icon: "success" }),
      });
    } catch (e) {
      wx.showToast({ title: e.message || "复制失败", icon: "none" });
    }
  },

  goGrade(e) {
    const sid = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/teacher/assignments/grade?submissionId=${sid}&assignmentId=${this.data.id}`,
    });
  },

  preview(e) {
    const urls = e.currentTarget.dataset.urls || [];
    const current = e.currentTarget.dataset.current;
    if (!urls.length) return;
    wx.previewImage({ urls, current });
  },
});
