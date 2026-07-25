const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { getCurrentClassId } = require("../../../utils/class-context");

Page({
  data: {
    classes: [],
    classId: "",
    className: "请选择班级",
    title: "",
    description: "",
    loading: false,
  },

  onLoad(q) {
    if (q.classId) this.setData({ classId: q.classId });
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
    this.loadClasses();
  },

  async loadClasses() {
    try {
      const data = await request({ url: "/api/v1/classes", method: "GET" });
      const classes = data.classes || [];
      let classId = this.data.classId || getCurrentClassId() || "";
      if (classId && !classes.find((c) => c.id === classId)) classId = "";
      const found = classes.find((c) => c.id === classId);
      this.setData({
        classes,
        classId: found ? found.id : "",
        className: found ? found.name : "请选择班级",
      });
    } catch (e) {
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  pickClass() {
    if (!this.data.classes.length) {
      wx.showToast({ title: "请先创建班级", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: this.data.classes.map((c) => c.name),
      success: (res) => {
        const c = this.data.classes[res.tapIndex];
        this.setData({ classId: c.id, className: c.name });
      },
    });
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },
  onDesc(e) {
    this.setData({ description: e.detail.value });
  },

  async submit(publish) {
    if (this.data.loading) return;
    if (!this.data.classId) {
      wx.showToast({ title: "请选择班级", icon: "none" });
      return;
    }
    const title = (this.data.title || "").trim();
    if (!title) {
      wx.showToast({ title: "请填写标题", icon: "none" });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = await request({
        url: "/api/v1/assignments",
        method: "POST",
        data: {
          classId: this.data.classId,
          type: "photo_homework",
          title,
          description: (this.data.description || "").trim() || undefined,
          publish,
        },
      });
      wx.showToast({
        title: publish ? "已发布" : "草稿已存",
        icon: "success",
      });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/teacher/assignments/detail?id=${data.assignment.id}`,
        });
      }, 400);
    } catch (e) {
      wx.showToast({ title: e.message || "失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  saveDraft() {
    this.submit(false);
  },
  publishNow() {
    this.submit(true);
  },
});
