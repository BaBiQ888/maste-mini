const { getToken, getUser, setUser, routeByUser } = require("../../utils/auth");
const { request } = require("../../utils/request");

Page({
  data: {
    role: "student",
    teacherCode: "",
    loading: false,
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (user && user.role) {
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
    wx.showModal({
      title: "确认身份",
      content: isTeacher
        ? "将以「老师」进入。选定后不可更改，确定吗？"
        : "将以「学生」进入。选定后不可更改，确定吗？",
      confirmText: "确定进入",
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
      const nickname = isTeacher ? "老师" : "同学";
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
      wx.showToast({ title: e.message || "设置失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
