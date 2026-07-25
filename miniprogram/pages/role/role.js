const { getToken, getUser, setUser, routeByUser } = require("../../utils/auth");
const { request } = require("../../utils/request");

Page({
  data: {
    role: "teacher",
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

  async onConfirm() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const nickname =
        this.data.role === "teacher" ? "老师" : "同学";
      const data = await request({
        url: "/api/v1/me",
        method: "PATCH",
        data: {
          role: this.data.role,
          nickname,
        },
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
