const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { fullUrl, RESULT_LABEL } = require("../../../utils/media");
const { showError } = require("../../../utils/errors");

Page({
  data: {
    submissionId: "",
    assignmentId: "",
    submission: null,
    photoDisplay: [],
    result: "correct",
    results: [
      { id: "correct", label: "正确" },
      { id: "partial", label: "部分正确" },
      { id: "incorrect", label: "错误" },
    ],
    score: "",
    comment: "",
    requireResubmit: false,
    loading: false,
  },

  onLoad(q) {
    this.setData({
      submissionId: q.submissionId || "",
      assignmentId: q.assignmentId || "",
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
    this.load();
  },

  async load() {
    if (!this.data.assignmentId) return;
    try {
      const data = await request({
        url: `/api/v1/assignments/${this.data.assignmentId}/submissions`,
        method: "GET",
      });
      const submission = (data.submissions || []).find(
        (s) => s.id === this.data.submissionId,
      );
      if (!submission) {
        wx.showToast({ title: "记录不存在", icon: "none" });
        return;
      }
      this.setData({
        submission,
        photoDisplay: (submission.photos || []).map((p) => fullUrl(p.url)),
        result: (submission.grade && submission.grade.result) || "correct",
        score:
          submission.grade && submission.grade.score != null
            ? String(submission.grade.score)
            : "",
        comment: (submission.grade && submission.grade.comment) || "",
        requireResubmit: !!(
          submission.grade && submission.grade.requireResubmit
        ),
      });
    } catch (e) {
      showError(e, { fallback: "加载失败" });
    }
  },

  pickResult(e) {
    this.setData({ result: e.currentTarget.dataset.id });
  },
  onScore(e) {
    this.setData({ score: e.detail.value });
  },
  onComment(e) {
    this.setData({ comment: e.detail.value });
  },
  toggleResubmit() {
    this.setData({ requireResubmit: !this.data.requireResubmit });
  },
  preview(e) {
    wx.previewImage({
      urls: this.data.photoDisplay,
      current: e.currentTarget.dataset.src,
    });
  },

  async submit() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      let score = null;
      if ((this.data.score || "").trim() !== "") {
        score = Number(this.data.score);
        if (Number.isNaN(score)) {
          throw new Error("分数无效");
        }
      }
      await request({
        url: `/api/v1/submissions/${this.data.submissionId}/grade`,
        method: "POST",
        data: {
          result: this.data.result,
          score,
          comment: (this.data.comment || "").trim() || null,
          requireResubmit: this.data.requireResubmit,
        },
      });
      wx.showToast({ title: "已保存", icon: "success" });
      setTimeout(() => wx.navigateBack(), 400);
    } catch (e) {
      showError(e, { fallback: "批改失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
