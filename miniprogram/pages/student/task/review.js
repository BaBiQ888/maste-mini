const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError, logError } = require("../../../utils/errors");

Page({
  data: {
    itemId: "",
    reviewId: "",
    review: null,
    items: [],
    loading: true,
    loadError: false,
    busy: false,
    mode: "answer",
    success: null,
  },

  _bootstrapped: false,

  onLoad(q) {
    this._bootstrapped = false;
    this.setData({
      itemId: q.itemId || "",
      reviewId: q.reviewId || "",
    });
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
    // Do not re-fetch on every show — that wipes in-progress answers.
    if (this._bootstrapped && this.data.review && !this.data.loadError) {
      return;
    }
    this.bootstrap();
  },

  async bootstrap() {
    this.setData({ loading: true, loadError: false });
    try {
      let review;
      if (this.data.reviewId) {
        const data = await request({
          url: `/api/v1/me/mastery/reviews/${this.data.reviewId}`,
          method: "GET",
        });
        review = data.review;
      } else if (this.data.itemId) {
        const data = await request({
          url: `/api/v1/me/mastery/${this.data.itemId}/start-review`,
          method: "POST",
          data: {},
        });
        review = data.review;
      } else {
        throw new Error("缺少回访参数");
      }
      // Abandoned session: do not enter answer mode (submit would only fail later)
      if (review && review.status === "abandoned") {
        logError(
          "mastery.review.abandoned",
          new Error("review abandoned"),
          {
            reviewId: review.id,
            itemId: this.data.itemId,
          },
        );
        // Prefer re-start from itemId when available
        if (this.data.itemId) {
          const data = await request({
            url: `/api/v1/me/mastery/${this.data.itemId}/start-review`,
            method: "POST",
            data: {},
          });
          review = data.review;
        } else {
          throw Object.assign(new Error("这次回访已失效，请重新进入"), {
            code: "REVIEW_ABANDONED",
          });
        }
      }
      if (review && review.status === "abandoned") {
        throw Object.assign(new Error("这次回访已失效，请重新进入"), {
          code: "REVIEW_ABANDONED",
        });
      }
      this.applyReview(review);
      this._bootstrapped = true;
      this.setData({ loadError: false });
    } catch (e) {
      this._bootstrapped = false;
      this.setData({ loading: false, loadError: true });
      showError(e, {
        tag: "mastery.review.bootstrap",
        fallback: "加载回访失败",
      });
    }
  },

  applyReview(review) {
    const mode =
      review.status === "completed"
        ? "result"
        : review.status === "abandoned"
          ? "result"
          : "answer";
    const items = (review.questions || []).map((q) => {
      const isTf = q.type === "true_false";
      const isChoice = q.type === "choice";
      let responseText = "";
      if (q.response === true) responseText = "true";
      else if (q.response === false) responseText = "false";
      else if (q.response != null) responseText = String(q.response);
      const options = (q.options || []).map((o) => ({
        ...o,
        letter: o.id != null ? String(o.id).toUpperCase() : "",
      }));
      return {
        ...q,
        responseText,
        response: q.response,
        isTf,
        isChoice,
        isFill: !isTf && !isChoice,
        mark:
          q.isCorrect === true ? "对" : q.isCorrect === false ? "错" : "",
        options,
      };
    });
    this.setData({
      review,
      reviewId: review.id,
      itemId: review.masteryItemId,
      items,
      mode,
      loading: false,
      success:
        mode === "result"
          ? {
              show: true,
              passed: !!review.passed,
              headline: review.passed ? "这页可以折角了" : "还差一口气",
              line: review.passed
                ? `${review.knowledgeName}，回访过关了。`
                : "过几天会再来找你，慢慢练。",
              scoreText:
                review.correctCount != null
                  ? `${review.correctCount}/${review.totalCount} 题正确`
                  : "",
            }
          : null,
    });
  },

  onFill(e) {
    if (this.data.mode !== "answer") return;
    const idx = e.currentTarget.dataset.index;
    const items = this.data.items.slice();
    items[idx].responseText = e.detail.value;
    items[idx].response = e.detail.value;
    this.setData({ items });
  },

  pickChoice(e) {
    if (this.data.mode !== "answer") return;
    const idx = e.currentTarget.dataset.index;
    const oid = e.currentTarget.dataset.oid;
    const items = this.data.items.slice();
    items[idx].responseText = oid;
    items[idx].response = oid;
    this.setData({ items });
  },

  pickTf(e) {
    if (this.data.mode !== "answer") return;
    const idx = e.currentTarget.dataset.index;
    const v = e.currentTarget.dataset.v === "1";
    const items = this.data.items.slice();
    items[idx].response = v;
    items[idx].responseText = v ? "true" : "false";
    this.setData({ items });
  },

  async submit() {
    if (this.data.busy || this.data.mode !== "answer") return;
    const blank = this.data.items.filter((it) => {
      if (it.isTf) return it.response !== true && it.response !== false;
      return !it.responseText || !String(it.responseText).trim();
    }).length;
    if (blank > 0) {
      wx.showToast({ title: `还有 ${blank} 题未作答`, icon: "none" });
      return;
    }
    this.setData({ busy: true });
    try {
      const answers = this.data.items.map((it, questionIndex) => {
        let response = it.response;
        if (it.isFill) response = it.responseText;
        if (it.isChoice) response = it.responseText;
        if (it.isTf) {
          if (it.responseText === "true") response = true;
          else if (it.responseText === "false") response = false;
        }
        return { questionIndex, response };
      });
      const data = await request({
        url: `/api/v1/me/mastery/reviews/${this.data.reviewId}/submit`,
        method: "POST",
        data: { answers },
      });
      this.applyReview(data.review);
    } catch (e) {
      showError(e, {
        tag: "mastery.review.submit",
        fallback: "提交失败",
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  goHome() {
    wx.reLaunch({ url: "/pages/student/home/home" });
  },

  dismissSuccess() {
    this.setData({ success: null });
  },
});
