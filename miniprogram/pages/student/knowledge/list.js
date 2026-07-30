const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError, logError } = require("../../../utils/errors");

const REASON_LABEL = {
  careless: "粗心",
  concept: "概念不清",
  procedure: "计算步骤",
  misread: "看错题目",
};

const GRADES = [3, 4, 5, 6];

Page({
  data: {
    grades: GRADES,
    grade: 3,
    units: [],
    stamps: [],
    summary: { dark: 0, half: 0, lit: 0 },
    pending: [],
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

  async load() {
    this.setData({ loading: true });
    try {
      const grade = this.data.grade;
      const [mapRes, mastery] = await Promise.all([
        request({
          url: `/api/v1/me/mastery-map?grade=${grade}`,
          method: "GET",
        }),
        request({
          url: "/api/v1/me/mastery?status=open,due",
          method: "GET",
        }).catch((err) => {
          logError("knowledge.masteryList", err, { grade });
          return { items: [] };
        }),
      ]);
      const map = mapRes.map || { units: [], summary: {}, grade };
      const units = (map.units || []).map((u) => ({
        ...u,
        open: true,
        nodes: (u.nodes || []).map((n) => ({
          ...n,
          stateLabel:
            n.state === "lit" ? "已过关" : n.state === "half" ? "待巩固" : "未练",
          canPractice: n.state === "half",
          canReview: n.masteryStatus === "due",
        })),
      }));
      // Hide self-practice scaffold rows (open + missCount 0, far review_at)
      const pending = (mastery.items || [])
        .filter(
          (it) =>
            it.status === "due" ||
            (it.status === "open" && (it.missCount || 0) > 0),
        )
        .map((it) => ({
          ...it,
          reasonLabel: it.lastWrongReason
            ? REASON_LABEL[it.lastWrongReason] || it.lastWrongReason
            : "",
          statusLabel: it.status === "due" ? "可回访" : "待巩固",
          canReview: it.status === "due",
        }));
      const stamps = (map.stamps || []).map((s) => ({
        ...s,
        progressText: `${s.litCount}/${s.total}`,
      }));
      this.setData({
        grade: map.grade || grade,
        units,
        stamps,
        summary: map.summary || { dark: 0, half: 0, lit: 0 },
        pending,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  pickGrade(e) {
    const g = Number(e.currentTarget.dataset.g);
    if (!g || g === this.data.grade) return;
    this.setData({ grade: g }, () => this.load());
  },

  toggleUnit(e) {
    const id = e.currentTarget.dataset.id;
    const units = this.data.units.map((u) =>
      u.unitId === id ? { ...u, open: !u.open } : u,
    );
    this.setData({ units });
  },

  onNodeTap(e) {
    const state = e.currentTarget.dataset.state;
    const kn = e.currentTarget.dataset.kn;
    const masteryId = e.currentTarget.dataset.mid;
    const canReview = e.currentTarget.dataset.review === "1";
    if (canReview && masteryId) {
      wx.navigateTo({
        url: `/pages/student/task/review?itemId=${masteryId}`,
      });
      return;
    }
    if (state === "half" && kn) {
      wx.showModal({
        title: "巩固练习",
        content: "用 5 道小题再练一遍这个知识点？",
        confirmText: "开始",
        success: (res) => {
          if (res.confirm) this.startSelfPractice(kn);
        },
      });
      return;
    }
    if (state === "lit") {
      wx.showToast({ title: "这页已过关", icon: "none" });
      return;
    }
    if (state === "dark") {
      wx.showToast({ title: "完成相关作业后会点亮", icon: "none" });
    }
  },

  async startSelfPractice(knowledgeNodeId) {
    wx.showLoading({ title: "出题中…" });
    try {
      const data = await request({
        url: "/api/v1/me/mastery/self-practice",
        method: "POST",
        data: { knowledgeNodeId },
      });
      wx.hideLoading();
      const rid = data.review && data.review.id;
      if (rid) {
        wx.navigateTo({
          url: `/pages/student/task/review?reviewId=${rid}`,
        });
      } else {
        logError("knowledge.selfPractice.noId", new Error("missing review id"), {
          knowledgeNodeId,
          hasReview: !!(data && data.review),
        });
        showError(new Error("出题结果异常"), {
          tag: "knowledge.selfPractice.noId",
          fallback: "出题失败，请重试",
        });
      }
    } catch (e) {
      wx.hideLoading();
      showError(e, {
        tag: "knowledge.selfPractice",
        fallback: "出题失败",
      });
    }
  },

  goReview(e) {
    const id = e.currentTarget.dataset.id;
    const can = e.currentTarget.dataset.can;
    if (!id || !can) {
      wx.showToast({ title: "还没到回访时间", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/student/task/review?itemId=${id}`,
    });
  },
});
