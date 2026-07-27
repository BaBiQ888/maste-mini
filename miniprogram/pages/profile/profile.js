const {
  getToken,
  getUser,
  setUser,
  clearAuth,
  routeByUser,
} = require("../../utils/auth");
const { request } = require("../../utils/request");

Page({
  data: {
    nickname: "",
    avatarUrl: "",
    roleLabel: "",
    loading: false,
    showStudentTab: false,
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user) {
      routeByUser(null);
      return;
    }
    this.setData({
      nickname: user.nickname || "",
      avatarUrl: user.avatarUrl || "",
      roleLabel:
        user.role === "teacher"
          ? "老师"
          : user.role === "student"
            ? "学生"
            : "未选择",
      showStudentTab: user.role === "student",
    });
  },

  onNickname(e) {
    this.setData({ nickname: e.detail.value });
  },

  async onSave() {
    const nickname = (this.data.nickname || "").trim();
    if (!nickname) {
      wx.showToast({ title: "请填写昵称", icon: "none" });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = await request({
        url: "/api/v1/me",
        method: "PATCH",
        data: {
          nickname,
          avatarUrl: this.data.avatarUrl || undefined,
        },
      });
      setUser(data.user);
      getApp().setUser(data.user);
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (e) {
      wx.showToast({ title: e.message || "保存失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onLogout() {
    wx.showModal({
      title: "退出登录",
      content: "确定退出当前账号吗？",
      confirmText: "退出",
      confirmColor: "#a63d3d",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({ url: "/api/v1/auth/logout", method: "POST" });
        } catch (_) {
          /* ignore */
        }
        clearAuth();
        getApp().setUser(null);
        wx.reLaunch({ url: "/pages/login/login" });
      },
    });
  },
});
