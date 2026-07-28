const { getToken, getUser, setUser, routeByUser } = require("../../utils/auth");
const { request } = require("../../utils/request");
const { showError } = require("../../utils/errors");

Page({
  data: {
    role: "student",
    teacherCode: "",
    loading: false,
    changing: false,
    intro: "选好后进入对应工作台。选错可在「我的」里再改。",
  },

  onLoad(q) {
    const changing = q.change === "1" || q.change === "true";
    const user = getUser();
    this.setData({
      changing,
      role: (user && user.role) || "student",
      intro: changing
        ? "切换身份后将进入对应工作台。成为老师需填写开通码。"
        : "选好后进入对应工作台。选错可在「我的」里再改。",
    });
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    // Re-entry for role change: stay on page even if role already set
    if (!this.data.changing && user && user.role) {
      routeByUser(user);
    }
  },

  pickTeacher() {
    this.setData({ role: "teacher" });
  },

  pickStudent() {
    this.setData({ role: "student" });
  },

  onTeacherCodeInput(e) {
    this.setData({ teacherCode: (e.detail.value || "").trim() });
  },

  onConfirm() {
    if (this.data.loading) return;
    const isTeacher = this.data.role === "teacher";
    if (isTeacher && !this.data.teacherCode) {
      wx.showToast({ title: "请填写教师开通码", icon: "none" });
      return;
    }
    const user = getUser();
    const sameRole = user && user.role === this.data.role;
    if (sameRole && !isTeacher) {
      routeByUser(user);
      return;
    }
    wx.showModal({
      title: this.data.changing ? "确认切换身份" : "确认身份",
      content: isTeacher
        ? "将以「老师」进入工作台，确定吗？"
        : "将以「学生」进入今日任务，确定吗？",
      confirmText: "确定",
      success: (res) => {
        if (res.confirm) this.doConfirm();
      },
    });
  },

  async doConfirm() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const isTeacher = this.data.role === "teacher";
      const user = getUser();
      // Keep existing nickname; only seed default when empty
      let nickname = (user && user.nickname) || "";
      if (!nickname) {
        nickname = isTeacher ? "老师" : "同学";
      }
      const payload = {
        role: this.data.role,
        nickname,
      };
      if (isTeacher) {
        payload.teacherCode = this.data.teacherCode;
      }
      const data = await request({
        url: "/api/v1/me",
        method: "PATCH",
        data: payload,
      });
      setUser(data.user);
      getApp().setUser(data.user);
      routeByUser(data.user);
    } catch (e) {
      showError(e, { fallback: "设置失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
