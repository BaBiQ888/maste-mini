const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { STATUS_LABEL } = require("../../../utils/media");

Page({
  data: {
    id: "",
    assignment: null,
    submission: null,
    items: [],
    statusLabels: STATUS_LABEL,
    loading: true,
    busy: false,
    mode: "answer",
    scoreText: "",
    timerText: "",
    timeRemainingSec: null,
    answeredCount: 0,
    progressPct: 0,
  },

  _timer: null,
  _autoSubmitted: false,

  onLoad(q) {
    this.setData({ id: q.id || "" });
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
    if (this.data.id) this.load();
  },

  onHide() {
    this.clearTimer();
  },

  onUnload() {
    this.clearTimer();
  },

  clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  async load() {
    this.setData({ loading: true });
    this._autoSubmitted = false;
    try {
      const [a, s] = await Promise.all([
        request({ url: `/api/v1/assignments/${this.data.id}`, method: "GET" }),
        request({
          url: `/api/v1/assignments/${this.data.id}/my-submission`,
          method: "GET",
        }),
      ]);
      this.applySubmission(a.assignment, s.submission);
      this.setupTimer(s.submission);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  setupTimer(submission) {
    this.clearTimer();
    if (
      !submission.timeLimitSec ||
      submission.timeRemainingSec == null ||
      (submission.status !== "not_started" &&
        submission.status !== "in_progress")
    ) {
      this.setData({ timerText: "", timeRemainingSec: null });
      return;
    }
    let remain = submission.timeRemainingSec;
    const tick = () => {
      if (remain <= 0) {
        this.setData({
          timerText: "时间到，正在交卷…",
          timeRemainingSec: 0,
        });
        this.clearTimer();
        this.autoSubmit();
        return;
      }
      const m = Math.floor(remain / 60);
      const s = remain % 60;
      this.setData({
        timeRemainingSec: remain,
        timerText: `剩余 ${m}:${String(s).padStart(2, "0")}`,
      });
      remain -= 1;
    };
    tick();
    this._timer = setInterval(tick, 1000);
  },

  applySubmission(assignment, submission) {
    const status = submission.status;
    let mode = "answer";
    if (status === "pending_correction") mode = "correct";
    else if (status === "completed") mode = "result";

    const items = (submission.answers || []).map((ans) => {
      const isTf = ans.type === "true_false";
      const isChoice = ans.type === "choice";
      let responseText = "";
      if (ans.response === true) responseText = "true";
      else if (ans.response === false) responseText = "false";
      else if (ans.response != null) responseText = String(ans.response);

      return {
        ...ans,
        responseText,
        isTf,
        isChoice,
        isFill: !isTf && !isChoice,
        showKey: ans.isCorrect !== null && ans.isCorrect !== undefined,
        mark:
          ans.isCorrect === true ? "对" : ans.isCorrect === false ? "错" : "",
        options: ans.options || [],
      };
    });

    const answeredCount = this.countAnswered(items, mode);
    const progressPct =
      items.length > 0
        ? Math.round((answeredCount / items.length) * 100)
        : 0;

    this.setData({
      assignment,
      submission,
      items,
      mode,
      answeredCount,
      progressPct,
      scoreText:
        submission.score != null ? `正确率 ${submission.score}%` : "",
      loading: false,
    });
  },

  countAnswered(items, mode) {
    let n = 0;
    for (const it of items || []) {
      if (mode === "correct" && it.isCorrect !== false) {
        n += 1;
        continue;
      }
      const t = it.responseText;
      if (t !== undefined && t !== null && String(t).trim() !== "") n += 1;
      else if (it.response === true || it.response === false) n += 1;
    }
    return n;
  },

  refreshProgress(items) {
    const list = items || this.data.items;
    const answeredCount = this.countAnswered(list, this.data.mode);
    const progressPct =
      list.length > 0 ? Math.round((answeredCount / list.length) * 100) : 0;
    this.setData({ items: list, answeredCount, progressPct });
  },

  onFill(e) {
    const idx = e.currentTarget.dataset.index;
    const items = this.data.items.slice();
    items[idx].responseText = e.detail.value;
    items[idx].response = e.detail.value;
    this.refreshProgress(items);
  },

  pickChoice(e) {
    if (this.data.mode === "result") return;
    const idx = e.currentTarget.dataset.index;
    const item = this.data.items[idx];
    if (this.data.mode === "correct" && item.isCorrect !== false) return;
    const oid = e.currentTarget.dataset.oid;
    const items = this.data.items.slice();
    items[idx].responseText = oid;
    items[idx].response = oid;
    this.refreshProgress(items);
  },

  pickTf(e) {
    if (this.data.mode === "result") return;
    const idx = e.currentTarget.dataset.index;
    const item = this.data.items[idx];
    if (this.data.mode === "correct" && item.isCorrect !== false) return;
    const v = e.currentTarget.dataset.v === "1";
    const items = this.data.items.slice();
    items[idx].response = v;
    items[idx].responseText = v ? "true" : "false";
    this.refreshProgress(items);
  },

  collectAnswers(onlyWrong) {
    const list = [];
    for (const it of this.data.items) {
      if (onlyWrong && it.isCorrect !== false) continue;
      let response = it.response;
      if (it.isFill) response = it.responseText;
      if (it.isChoice) response = it.responseText;
      if (it.isTf) {
        if (it.responseText === "true") response = true;
        else if (it.responseText === "false") response = false;
      }
      list.push({
        assignmentQuestionId: it.assignmentQuestionId,
        response: response === undefined || response === "" ? null : response,
      });
    }
    return list;
  },

  async saveDraft() {
    if (this.data.busy || this.data.mode !== "answer") return;
    this.setData({ busy: true });
    try {
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/draft`,
        method: "PUT",
        data: { answers: this.collectAnswers(false) },
      });
      this.applySubmission(this.data.assignment, data.submission);
      wx.showToast({ title: "草稿已保存", icon: "success" });
    } catch (e) {
      wx.showToast({ title: e.message || "保存失败", icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },

  submitAll() {
    if (this.data.busy || this.data.mode !== "answer") return;
    const total = this.data.items.length;
    const answered = this.countAnswered(this.data.items, "answer");
    const blank = total - answered;
    const content =
      blank > 0
        ? `还有 ${blank} 题未作答，确定交卷吗？`
        : "交卷后将自动批改，确定提交吗？";
    wx.showModal({
      title: "确认交卷",
      content,
      confirmText: "交卷",
      success: (res) => {
        if (res.confirm) this.doSubmitAll();
      },
    });
  },

  async doSubmitAll() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/answers`,
        method: "POST",
        data: { answers: this.collectAnswers(false) },
      });
      this.clearTimer();
      this.applySubmission(this.data.assignment, data.submission);
      wx.showToast({
        title:
          data.submission.status === "completed"
            ? "全部正确，真棒"
            : "请订正标错的题",
        icon: "none",
      });
    } catch (e) {
      wx.showToast({ title: e.message || "提交失败", icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },

  async autoSubmit() {
    if (this._autoSubmitted || this.data.busy) return;
    if (
      this.data.mode !== "answer" ||
      !this.data.submission ||
      (this.data.submission.status !== "not_started" &&
        this.data.submission.status !== "in_progress")
    ) {
      return;
    }
    this._autoSubmitted = true;
    this.setData({ busy: true });
    try {
      // save draft first so server has partial answers
      await request({
        url: `/api/v1/submissions/${this.data.submission.id}/draft`,
        method: "PUT",
        data: { answers: this.collectAnswers(false) },
      });
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/answers`,
        method: "POST",
        data: { answers: this.collectAnswers(false), force: true },
      });
      this.applySubmission(this.data.assignment, data.submission);
      wx.showToast({ title: "时间到，已自动交卷", icon: "none" });
    } catch (e) {
      this._autoSubmitted = false;
      wx.showToast({ title: e.message || "自动交卷失败", icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },

  async submitCorrect() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/correct`,
        method: "POST",
        data: { answers: this.collectAnswers(true) },
      });
      this.applySubmission(this.data.assignment, data.submission);
      wx.showToast({
        title:
          data.submission.status === "completed" ? "订正完成" : "仍有错题",
        icon: "none",
      });
    } catch (e) {
      wx.showToast({ title: e.message || "订正失败", icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
