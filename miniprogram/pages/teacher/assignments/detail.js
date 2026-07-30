const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const {
  resolveImageSrcs,
  STATUS_LABEL,
  RESULT_LABEL,
} = require("../../../utils/media");
const { showError } = require("../../../utils/errors");

const TYPE_LABEL = {
  fill_blank: "填空",
  choice: "选择",
  true_false: "判断",
};

function formatAnswerLabel(snap) {
  if (!snap) return "—";
  const t = snap.type;
  const a = snap.answer;
  if (t === "true_false") {
    if (a === true || a === "true" || a === "正确") return "正确";
    if (a === false || a === "false" || a === "错误") return "错误";
  }
  if (t === "choice" && a != null) {
    return String(a).toUpperCase();
  }
  if (a == null || a === "") return "—";
  return String(a);
}

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
    requireCorrection: true,
    topWrongs: [],
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
        }).catch((err) => {
          console.error("[detail.summary]", err);
          return { summary: null };
        }),
        request({
          url: `/api/v1/assignments/${this.data.id}/questions`,
          method: "GET",
        }).catch((err) => {
          console.error("[detail.questions]", err);
          return { questions: [] };
        }),
        request({
          url: `/api/v1/assignments/${this.data.id}/question-stats`,
          method: "GET",
        }).catch((err) => {
          console.error("[detail.questionStats]", err);
          return { questions: [] };
        }),
      ]);
      const submissions = await Promise.all(
        (s.submissions || []).map(async (sub) => ({
          ...sub,
          photoDisplay: await resolveImageSrcs(
            (sub.photos || []).map((p) => p.url),
          ),
        })),
      );
      const summary = sum.summary || null;
      const rateText =
        summary && summary.completionRate != null
          ? `${summary.completionRate}%`
          : "—";
      const isPhoto = a.assignment.type === "photo_homework";
      const questionStats = (qst.questions || []).map((q) => ({
        ...q,
        wrongCount:
          q.wrongCount != null
            ? q.wrongCount
            : Math.max(0, (q.answeredCount || 0) - (q.correctCount || 0)),
        rateText: q.correctRate != null ? `${q.correctRate}%` : "—",
      }));
      // Single source: top wrongs from question-stats (no second endpoint)
      const topWrongs = questionStats
        .filter((q) => q.wrongCount > 0)
        .sort(
          (x, y) =>
            y.wrongCount - x.wrongCount ||
            (y.answeredCount || 0) - (x.answeredCount || 0),
        )
        .slice(0, 3)
        .map((q) => ({
          assignmentQuestionId: q.assignmentQuestionId,
          stem: q.stem,
          wrongCount: q.wrongCount,
          answeredCount: q.answeredCount,
        }));
      const questions = (qs.questions || []).map((row) => {
        const snap = row.snapshot || {};
        return {
          ...row,
          typeLabel: TYPE_LABEL[snap.type] || "",
          answerLabel: formatAnswerLabel(snap),
        };
      });
      const cfg = (a.assignment && a.assignment.config) || {};
      const requireCorrection =
        cfg.requireCorrection === false ? false : !isPhoto;
      this.setData({
        assignment: a.assignment,
        submissions,
        questions,
        questionStats,
        isPhoto,
        summary,
        rateText,
        requireCorrection,
        topWrongs,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
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
      showError(e, { fallback: "操作失败，请稍后重试" });
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
          showError(e, { fallback: "操作失败，请稍后重试" });
        }
      },
    });
  },

  deleteDraft() {
    wx.showModal({
      title: "删除草稿",
      content: "删除后不可恢复，确定？",
      confirmColor: "#A63D3D",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({
            url: `/api/v1/assignments/${this.data.id}`,
            method: "DELETE",
          });
          wx.showToast({ title: "已删除", icon: "success" });
          setTimeout(() => {
            wx.navigateBack({ fail: () => {
              wx.reLaunch({ url: "/pages/teacher/assignments/list" });
            }});
          }, 400);
        } catch (e) {
          showError(e, {
            tag: "assignment.deleteDraft",
            fallback: "删除失败",
          });
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
      showError(e, { fallback: "复制失败" });
    }
  },

  async copyReminder() {
    try {
      const data = await request({
        url: `/api/v1/assignments/${this.data.id}/reminder-text?layered=1`,
        method: "GET",
      });
      wx.setClipboardData({
        data: data.text || "",
        success: () =>
          wx.showToast({ title: "分层催交已复制", icon: "success" }),
      });
    } catch (e) {
      showError(e, { fallback: "复制失败" });
    }
  },

  async goVariantDrill() {
    if (!this.data.id) return;
    wx.showLoading({ title: "生成变式…" });
    try {
      const data = await request({
        url: `/api/v1/assignments/${this.data.id}/variant-drill`,
        method: "POST",
        data: { count: 10, publish: true },
      });
      wx.hideLoading();
      wx.showToast({ title: "已发布变式", icon: "success" });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/teacher/assignments/detail?id=${data.assignment.id}`,
        });
      }, 400);
    } catch (e) {
      wx.hideLoading();
      showError(e, {
        tag: "assignment.variant",
        fallback: "生成失败，可手动布置",
      });
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
