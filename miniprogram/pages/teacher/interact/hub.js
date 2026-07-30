const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { getCurrentClassId, setCurrentClassId } = require("../../../utils/class-context");
const { showError, logError } = require("../../../utils/errors");

const REASON_LABEL = {
  careless: "粗心",
  concept: "概念不清",
  procedure: "计算步骤",
  misread: "看错题目",
};

Page({
  data: {
    classes: [],
    classId: "",
    className: "请选择班级",
    focus: null,
    focusLabel: "",
    stuck: [],
    shares: [],
    reasons: [],
    mapProgress: null,
    noteBody: "",
    loading: true,
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
    this.bootstrap();
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      const cls = await request({ url: "/api/v1/classes", method: "GET" });
      const classes = cls.classes || [];
      let classId = getCurrentClassId() || "";
      let found = classes.find((c) => c.id === classId);
      if (!found && classes.length) {
        found = classes[0];
        classId = found.id;
        setCurrentClassId(classId);
      }
      this.setData({
        classes,
        classId: found ? found.id : "",
        className: found ? found.name : "请选择班级",
      });
      if (found) await this.loadClass(found.id);
      else this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  async loadClass(classId) {
    this.setData({ loading: true });
    try {
      const [focus, stuck, shares, reasons, map] = await Promise.all([
        request({ url: `/api/v1/classes/${classId}/focus`, method: "GET" }).catch(
          (err) => {
            logError("interact.focus", err, { classId });
            return { focus: null };
          },
        ),
        request({
          url: `/api/v1/classes/${classId}/stuck-reports?status=open`,
          method: "GET",
        }).catch((err) => {
          logError("interact.stuck", err, { classId });
          return { reports: [] };
        }),
        request({
          url: `/api/v1/classes/${classId}/week-shares`,
          method: "GET",
        }).catch((err) => {
          logError("interact.weekShares", err, { classId });
          return { shares: [] };
        }),
        request({
          url: `/api/v1/classes/${classId}/wrong-reason-stats`,
          method: "GET",
        }).catch((err) => {
          logError("interact.wrongReasons", err, { classId });
          return { reasons: [] };
        }),
        request({
          url: `/api/v1/classes/${classId}/map-progress`,
          method: "GET",
        }).catch((err) => {
          logError("interact.mapProgress", err, { classId });
          return { progress: null };
        }),
      ]);
      this.setData({
        focus: focus.focus || null,
        focusLabel: (focus.focus && focus.focus.label) || "",
        stuck: stuck.reports || [],
        shares: shares.shares || [],
        reasons: (reasons.reasons || []).map((r) => ({
          ...r,
          label: REASON_LABEL[r.reason] || r.reason,
        })),
        mapProgress: map.progress || null,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  pickClass() {
    const names = this.data.classes.map((c) => c.name);
    if (!names.length) return;
    wx.showActionSheet({
      itemList: names,
      success: (res) => {
        const c = this.data.classes[res.tapIndex];
        setCurrentClassId(c.id);
        this.setData({ classId: c.id, className: c.name }, () =>
          this.loadClass(c.id),
        );
      },
    });
  },

  onFocusLabel(e) {
    this.setData({ focusLabel: e.detail.value });
  },

  async saveFocus() {
    if (!this.data.classId) return;
    const label = (this.data.focusLabel || "").trim();
    if (!label) {
      wx.showToast({ title: "请填写今日焦点", icon: "none" });
      return;
    }
    try {
      const data = await request({
        url: `/api/v1/classes/${this.data.classId}/focus`,
        method: "PUT",
        data: { label },
      });
      this.setData({ focus: data.focus });
      wx.showToast({ title: "已钉上", icon: "success" });
    } catch (e) {
      showError(e, { tag: "interact.focus", fallback: "保存失败" });
    }
  },

  onNoteBody(e) {
    this.setData({ noteBody: e.detail.value });
  },

  async sendBroadcast() {
    if (!this.data.classId) return;
    const body = (this.data.noteBody || "").trim();
    if (!body) {
      wx.showToast({ title: "请写小纸条内容", icon: "none" });
      return;
    }
    try {
      await request({
        url: `/api/v1/classes/${this.data.classId}/notes`,
        method: "POST",
        data: { body, kind: "broadcast" },
      });
      this.setData({ noteBody: "" });
      wx.showToast({ title: "已发给全班", icon: "success" });
    } catch (e) {
      showError(e, { tag: "interact.note", fallback: "发送失败" });
    }
  },

  replyStuck(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "回复学生",
      editable: true,
      placeholderText: "写一句提示，不要直接给答案",
      success: async (res) => {
        if (!res.confirm) return;
        const reply = (res.content || "").trim();
        if (!reply) {
          wx.showToast({ title: "请填写回复", icon: "none" });
          return;
        }
        try {
          await request({
            url: `/api/v1/stuck-reports/${id}/reply`,
            method: "POST",
            data: { reply, resolve: true },
          });
          wx.showToast({ title: "已回复", icon: "success" });
          this.loadClass(this.data.classId);
        } catch (err) {
          showError(err, { tag: "interact.stuckReply", fallback: "回复失败" });
        }
      },
    });
  },

  replyShare(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "回复周小结",
      editable: true,
      placeholderText: "下周重点…",
      success: async (res) => {
        if (!res.confirm) return;
        const reply = (res.content || "").trim();
        if (!reply) return;
        try {
          await request({
            url: `/api/v1/week-shares/${id}/reply`,
            method: "POST",
            data: { reply },
          });
          wx.showToast({ title: "已回复", icon: "success" });
          this.loadClass(this.data.classId);
        } catch (err) {
          showError(err, { tag: "interact.weekReply", fallback: "回复失败" });
        }
      },
    });
  },
});
