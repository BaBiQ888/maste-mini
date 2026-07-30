const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { getCurrentClassId } = require("../../../utils/class-context");
const { STATUS_LABEL, assignmentTypeLabel } = require("../../../utils/media");
const { showError } = require("../../../utils/errors");

const SWIPE_OPEN_PX = 80; // ~160rpx

Page({
  data: {
    assignments: [],
    classes: [],
    classId: "",
    className: "全部班级",
    pendingGrade: 0,
    hasDraft: false,
    loading: true,
    statusLabels: STATUS_LABEL,
  },

  _touch: null,

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

  onPullDownRefresh() {
    this.bootstrap().finally(() => wx.stopPullDownRefresh());
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      const classes = (
        await request({ url: "/api/v1/classes", method: "GET" })
      ).classes || [];
      let classId = this.data.classId || getCurrentClassId() || "";
      if (classId && !classes.find((c) => c.id === classId)) classId = "";
      const className = classId
        ? (classes.find((c) => c.id === classId) || {}).name || "班级"
        : "全部班级";
      this.setData({ classes, classId, className });
      await this.load();
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  async load() {
    try {
      const q = this.data.classId ? `?classId=${this.data.classId}` : "";
      const data = await request({
        url: `/api/v1/assignments${q}`,
        method: "GET",
      });
      const assignments = (data.assignments || []).map((a) => ({
        ...a,
        typeLabel: assignmentTypeLabel(a.type),
        open: false,
      }));
      this.setData({
        assignments,
        pendingGrade: data.pendingGrade || 0,
        hasDraft: assignments.some((a) => a.status === "draft"),
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { fallback: "加载失败" });
    }
  },

  closeAllSwipes(exceptId) {
    const next = this.data.assignments.map((a) => ({
      ...a,
      open: exceptId && a.id === exceptId ? a.open : false,
    }));
    this.setData({ assignments: next });
  },

  onTouchStart(e) {
    const t = e.touches[0];
    if (!t) return;
    const { id, status, index } = e.currentTarget.dataset;
    if (status !== "draft") {
      this._touch = null;
      return;
    }
    this._touch = {
      id,
      index: Number(index),
      startX: t.clientX,
      startY: t.clientY,
      moved: false,
      opened: !!this.data.assignments[Number(index)]?.open,
    };
  },

  onTouchMove(e) {
    const touch = this._touch;
    if (!touch) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - touch.startX;
    const dy = t.clientY - touch.startY;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
      // vertical scroll — ignore
      this._touch = null;
      return;
    }
    if (Math.abs(dx) > 8) touch.moved = true;
  },

  onTouchEnd(e) {
    const touch = this._touch;
    this._touch = null;
    if (!touch || !touch.moved) return;
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) return;
    const dx = t.clientX - touch.startX;
    const open = touch.opened ? dx > -SWIPE_OPEN_PX / 2 : dx < -SWIPE_OPEN_PX / 2;
    const next = this.data.assignments.map((a) => ({
      ...a,
      open: a.id === touch.id ? open : false,
    }));
    this.setData({ assignments: next });
  },

  confirmDelete(e) {
    const id = e.currentTarget.dataset.id;
    const title = e.currentTarget.dataset.title || "草稿";
    wx.showModal({
      title: "删除草稿",
      content: `确定删除「${title}」？删除后不可恢复。`,
      confirmColor: "#A63D3D",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({
            url: `/api/v1/assignments/${id}`,
            method: "DELETE",
          });
          const assignments = this.data.assignments.filter((a) => a.id !== id);
          this.setData({
            assignments,
            hasDraft: assignments.some((a) => a.status === "draft"),
          });
          wx.showToast({ title: "已删除", icon: "success" });
        } catch (err) {
          showError(err, {
            tag: "assignment.deleteDraft",
            fallback: "删除失败",
          });
        }
      },
    });
  },

  pickClass() {
    const names = ["全部班级"].concat(this.data.classes.map((c) => c.name));
    wx.showActionSheet({
      itemList: names,
      success: (res) => {
        if (res.tapIndex === 0) {
          this.setData({ classId: "", className: "全部班级" }, () =>
            this.load(),
          );
        } else {
          const c = this.data.classes[res.tapIndex - 1];
          this.setData({ classId: c.id, className: c.name }, () => this.load());
        }
      },
    });
  },

  goCreate() {
    const classId = this.data.classId || getCurrentClassId() || "";
    wx.navigateTo({
      url: `/pages/teacher/assignments/create${classId ? `?classId=${classId}` : ""}`,
    });
  },

  goCreateOnline() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create-online" });
  },

  goCreateDrill() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create-drill" });
  },

  goCreateCheckin() {
    wx.navigateTo({ url: "/pages/teacher/assignments/create-checkin" });
  },

  goQuestions() {
    wx.reLaunch({ url: "/pages/teacher/questions/list" });
  },

  goDetail(e) {
    // If any swipe is open, close first instead of navigating
    const openOne = this.data.assignments.find((a) => a.open);
    if (openOne) {
      this.closeAllSwipes();
      return;
    }
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/teacher/assignments/detail?id=${id}`,
    });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/teacher/home/home" });
  },

  goClasses() {
    wx.reLaunch({ url: "/pages/teacher/classes/list" });
  },

  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});
