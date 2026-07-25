const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { getCurrentClassId } = require("../../../utils/class-context");
const { STATUS_LABEL } = require("../../../utils/media");

Page({
  data: {
    assignments: [],
    classes: [],
    classId: "",
    className: "全部班级",
    pendingGrade: 0,
    loading: true,
    statusLabels: STATUS_LABEL,
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
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  async load() {
    try {
      const q = this.data.classId ? `?classId=${this.data.classId}` : "";
      const data = await request({
        url: `/api/v1/assignments${q}`,
        method: "GET",
      });
      this.setData({
        assignments: data.assignments || [],
        pendingGrade: data.pendingGrade || 0,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
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
    wx.navigateTo({
      url: `/pages/teacher/assignments/detail?id=${e.currentTarget.dataset.id}`,
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
