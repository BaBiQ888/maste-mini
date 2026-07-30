const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { STATUS_LABEL } = require("../../../utils/media");
const { showError, logError } = require("../../../utils/errors");
const { buildSuccessPanel } = require("../../../utils/mastery-copy");

const WRONG_REASON_OPTIONS = [
  { value: "careless", label: "粗心" },
  { value: "concept", label: "概念不清" },
  { value: "procedure", label: "计算步骤" },
  { value: "misread", label: "看错题目" },
];

Page({
  data: {
    id: "",
    assignment: null,
    submission: null,
    items: [],
    statusLabels: STATUS_LABEL,
    wrongReasonOptions: WRONG_REASON_OPTIONS,
    loading: true,
    loadError: false,
    busy: false,
    mode: "answer",
    scoreText: "",
    timerText: "",
    timeRemainingSec: null,
    answeredCount: 0,
    progressPct: 0,
    success: null,
    streakDays: null,
  },

  _timer: null,
  _autoSubmitted: false,
  _bootstrapped: false,

  onLoad(q) {
    this._bootstrapped = false;
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
    // Keep local answers / wrong-reason chips / success overlay across resume
    if (
      this._bootstrapped &&
      !this.data.loadError &&
      this.data.submission &&
      (this.data.mode === "answer" ||
        this.data.mode === "correct" ||
        this.data.mode === "result")
    ) {
      if (this.data.mode === "answer") this.setupTimer(this.data.submission);
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
    this.setData({ loading: true, loadError: false });
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
      this._bootstrapped = true;
      this.setData({ loadError: false });
    } catch (e) {
      this._bootstrapped = false;
      this.setData({ loading: false, loadError: true });
      showError(e, { fallback: "加载失败" });
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

      const options = (ans.options || []).map((o) => ({
        ...o,
        letter: o.id != null ? String(o.id).toUpperCase() : "",
      }));

      return {
        ...ans,
        responseText,
        isTf,
        isChoice,
        isFill: !isTf && !isChoice,
        showKey: ans.isCorrect !== null && ans.isCorrect !== undefined,
        mark:
          ans.isCorrect === true ? "对" : ans.isCorrect === false ? "错" : "",
        wrongReason: ans.wrongReason || "",
        options,
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

  async refreshStreak() {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const data = await request({
        url: `/api/v1/me/calendar?year=${year}&month=${month}`,
        method: "GET",
      });
      const streakDays =
        data.calendar && data.calendar.streakDays != null
          ? Number(data.calendar.streakDays)
          : null;
      this.setData({ streakDays });
      return streakDays;
    } catch (err) {
      logError("online.refreshStreak", err, {});
      return this.data.streakDays;
    }
  },

  async showSuccess(submission, opts) {
    const scoreBefore =
      opts && opts.scoreBefore != null ? opts.scoreBefore : null;
    let streakDays = this.data.streakDays;
    if (submission.status === "completed") {
      streakDays = await this.refreshStreak();
    }
    // Prefer server answers (setData is async; this.data.items may lag)
    const items = (submission.answers || this.data.items || []).map((a) => ({
      isCorrect: a.isCorrect,
    }));
    const success = buildSuccessPanel({
      assignment: this.data.assignment,
      submission,
      items,
      scoreBefore,
      streakDays,
      forceWrong: opts && opts.forceWrong,
    });
    this.setData({ success });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/student/home/home" });
  },

  dismissSuccess() {
    this.setData({ success: null });
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

  pickWrongReason(e) {
    if (this.data.mode !== "correct") return;
    const idx = e.currentTarget.dataset.index;
    const item = this.data.items[idx];
    if (!item || item.isCorrect !== false) return;
    const reason = e.currentTarget.dataset.reason || "";
    const items = this.data.items.slice();
    // toggle off if same chip tapped again
    items[idx].wrongReason =
      items[idx].wrongReason === reason ? "" : reason;
    this.setData({ items });
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
      showError(e, { fallback: "保存失败" });
    } finally {
      this.setData({ busy: false });
    }
  },

  submitAll() {
    if (this.data.busy || this.data.mode !== "answer") return;
    const total = this.data.items.length;
    const answered = this.countAnswered(this.data.items, "answer");
    const blank = total - answered;
    // Server rejects incomplete papers unless timer has expired (force/auto).
    // Do not open a confirm that would 400 on /answers.
    if (blank > 0) {
      const timedOut =
        this.data.timeRemainingSec != null && this.data.timeRemainingSec <= 0;
      if (!timedOut) {
        wx.showToast({
          title: `还有 ${blank} 题未作答，请先完成`,
          icon: "none",
        });
        return;
      }
      // Time already up — force-submit partial
      this.doSubmitAll({ force: true });
      return;
    }
    wx.showModal({
      title: "确认交卷",
      content: "交卷后将自动批改，确定提交吗？",
      confirmText: "交卷",
      success: (res) => {
        if (res.confirm) this.doSubmitAll({ force: false });
      },
    });
  },

  async doSubmitAll(opts) {
    if (this.data.busy) return;
    const force = !!(opts && opts.force);
    this.setData({ busy: true });
    try {
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/answers`,
        method: "POST",
        data: {
          answers: this.collectAnswers(false),
          force: force || undefined,
        },
      });
      this.clearTimer();
      this.applySubmission(this.data.assignment, data.submission);
      await this.showSuccess(data.submission, { scoreBefore: null });
    } catch (e) {
      showError(e, { fallback: "提交失败" });
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
      // Single force submit with current answers (server merges + grades).
      // Avoid draft-then-answers race when server already auto-forced.
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/answers`,
        method: "POST",
        data: {
          answers: this.collectAnswers(false),
          force: true,
        },
      });
      this.applySubmission(this.data.assignment, data.submission);
      await this.showSuccess(data.submission, { scoreBefore: null });
    } catch (e) {
      // Concurrent server auto-force already closed the paper
      if (e && e.code === "INVALID_STATUS") {
        try {
          await this.load();
          await this.showSuccess(this.data.submission, { scoreBefore: null });
          return;
        } catch (_) {
          /* fall through */
        }
      }
      this._autoSubmitted = false;
      showError(e, { fallback: "自动交卷失败" });
    } finally {
      this.setData({ busy: false });
    }
  },

  collectWrongReasons() {
    const list = [];
    for (const it of this.data.items) {
      if (it.isCorrect !== false) continue;
      if (it.wrongReason) {
        list.push({
          assignmentQuestionId: it.assignmentQuestionId,
          reason: it.wrongReason,
        });
      }
    }
    return list;
  },

  async submitCorrect() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    const scoreBefore =
      this.data.submission && this.data.submission.score != null
        ? this.data.submission.score
        : null;
    try {
      const wrongReasons = this.collectWrongReasons();
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/correct`,
        method: "POST",
        data: {
          answers: this.collectAnswers(true),
          wrongReasons: wrongReasons.length ? wrongReasons : undefined,
        },
      });
      this.applySubmission(this.data.assignment, data.submission);
      await this.showSuccess(data.submission, {
        scoreBefore,
        forceWrong: data.submission.status === "pending_correction",
      });
    } catch (e) {
      showError(e, { fallback: "订正失败" });
    } finally {
      this.setData({ busy: false });
    }
  },

  reportStuck(e) {
    const idx = e.currentTarget.dataset.index;
    const item = this.data.items[idx];
    if (!this.data.submission || !item) return;
    wx.showModal({
      title: "告诉老师还不会",
      content: "不会公开，只给老师看。可写一句哪里卡住了。",
      editable: true,
      placeholderText: "如：进位不会",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({
            url: `/api/v1/submissions/${this.data.submission.id}/stuck`,
            method: "POST",
            data: {
              assignmentQuestionId: item.assignmentQuestionId,
              note: (res.content || "").trim() || null,
            },
          });
          wx.showToast({ title: "已告诉老师", icon: "success" });
        } catch (err) {
          showError(err, {
            tag: "online.stuck",
            fallback: "上报失败",
          });
        }
      },
    });
  },
});
