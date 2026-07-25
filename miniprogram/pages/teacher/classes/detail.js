const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const {
  getCurrentClassId,
  setCurrentClassId,
} = require("../../../utils/class-context");

Page({
  data: {
    id: "",
    cls: null,
    members: [],
    students: [],
    loading: true,
    busy: false,
    showQr: false,
    qrDataUrl: "",
  },

  onLoad(query) {
    this.setData({ id: query.id || "" });
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
      // archived classes need include path: get by id still works if member
      const [c, m] = await Promise.all([
        request({ url: `/api/v1/classes/${this.data.id}`, method: "GET" }),
        request({
          url: `/api/v1/classes/${this.data.id}/members`,
          method: "GET",
        }),
      ]);
      const members = m.members || [];
      const students = members.filter((x) => x.role === "student");
      this.setData({
        cls: c.class,
        members,
        students,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  copyCode() {
    const code = this.data.cls && this.data.cls.inviteCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: "邀请码已复制", icon: "success" }),
    });
  },

  copyShareText() {
    const cls = this.data.cls;
    if (!cls || cls.archived) return;
    const text = `【算本】邀请你加入班级「${cls.name}」（${cls.grade}年级），邀请码：${cls.inviteCode}`;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: "文案已复制", icon: "success" }),
    });
  },

  setAsCurrent() {
    if (this.data.cls && this.data.cls.archived) {
      wx.showToast({ title: "归档班不能设为当前", icon: "none" });
      return;
    }
    setCurrentClassId(this.data.id);
    wx.showToast({ title: "已设为当前班", icon: "success" });
  },

  goStudentStats(e) {
    const userId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/teacher/students/stats?classId=${this.data.id}&userId=${userId}`,
    });
  },

  refreshCode() {
    if (this.data.busy || !this.data.cls || this.data.cls.archived) return;
    wx.showModal({
      title: "刷新邀请码",
      content: "旧邀请码将立即失效，已在班学生不受影响。确定刷新？",
      confirmColor: "#C45C26",
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        try {
          const data = await request({
            url: `/api/v1/classes/${this.data.id}/invite/refresh`,
            method: "POST",
          });
          this.setData({ cls: data.class, busy: false });
          wx.showToast({ title: "已刷新", icon: "success" });
        } catch (e) {
          this.setData({ busy: false });
          wx.showToast({ title: e.message || "刷新失败", icon: "none" });
        }
      },
    });
  },

  removeStudent(e) {
    if (this.data.busy || !this.data.cls || this.data.cls.archived) return;
    const userId = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || "该学生";
    wx.showModal({
      title: "移出学生",
      content: `确定将「${name}」移出本班？`,
      confirmColor: "#A63D3D",
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        try {
          await request({
            url: `/api/v1/classes/${this.data.id}/members/${userId}`,
            method: "DELETE",
          });
          this.setData({ busy: false });
          wx.showToast({ title: "已移出", icon: "success" });
          this.load();
        } catch (e) {
          this.setData({ busy: false });
          wx.showToast({ title: e.message || "操作失败", icon: "none" });
        }
      },
    });
  },

  archiveClass() {
    if (this.data.busy || !this.data.cls || this.data.cls.archived) return;
    wx.showModal({
      title: "归档班级",
      content: "归档后不再出现在日常列表，且不能用邀请码新加入。可稍后恢复。",
      confirmColor: "#C45C26",
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        try {
          const data = await request({
            url: `/api/v1/classes/${this.data.id}/archive`,
            method: "POST",
          });
          if (getCurrentClassId() === this.data.id) {
            setCurrentClassId("");
          }
          this.setData({ cls: data.class, busy: false });
          wx.showToast({ title: "已归档", icon: "success" });
        } catch (e) {
          this.setData({ busy: false });
          wx.showToast({ title: e.message || "归档失败", icon: "none" });
        }
      },
    });
  },

  unarchiveClass() {
    if (this.data.busy || !this.data.cls || !this.data.cls.archived) return;
    this.setData({ busy: true });
    request({
      url: `/api/v1/classes/${this.data.id}/unarchive`,
      method: "POST",
    })
      .then((data) => {
        this.setData({ cls: data.class, busy: false });
        wx.showToast({ title: "已恢复", icon: "success" });
      })
      .catch((e) => {
        this.setData({ busy: false });
        wx.showToast({ title: e.message || "恢复失败", icon: "none" });
      });
  },

  async showQr() {
    if (!this.data.cls || this.data.cls.archived) return;
    try {
      wx.showLoading({ title: "生成中" });
      const data = await request({
        url: `/api/v1/classes/${this.data.id}/invite-qr`,
        method: "GET",
      });
      wx.hideLoading();
      this.setData({ qrDataUrl: data.dataUrl, showQr: true });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || "生成失败", icon: "none" });
    }
  },

  hideQr() {
    this.setData({ showQr: false });
  },

  previewQr() {
    if (!this.data.qrDataUrl) return;
    wx.previewImage({ urls: [this.data.qrDataUrl] });
  },
});
