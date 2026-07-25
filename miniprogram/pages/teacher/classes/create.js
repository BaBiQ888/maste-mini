const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { setCurrentClassId } = require("../../../utils/class-context");

Page({
  data: {
    name: "",
    grade: 4,
    grades: [3, 4, 5, 6],
    loading: false,
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user || user.role !== "teacher") {
      routeByUser(user);
    }
  },

  onName(e) {
    this.setData({ name: e.detail.value });
  },

  pickGrade(e) {
    this.setData({ grade: Number(e.currentTarget.dataset.g) });
  },

  async onSubmit() {
    const name = (this.data.name || "").trim();
    if (!name) {
      wx.showToast({ title: "请填写班级名称", icon: "none" });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = await request({
        url: "/api/v1/classes",
        method: "POST",
        data: { name, grade: this.data.grade },
      });
      setCurrentClassId(data.class.id);
      wx.showToast({ title: "已创建", icon: "success" });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/teacher/classes/detail?id=${data.class.id}`,
        });
      }, 400);
    } catch (e) {
      wx.showToast({ title: e.message || "创建失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
