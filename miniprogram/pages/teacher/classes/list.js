const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const {
  getCurrentClassId,
  setCurrentClassId,
} = require("../../../utils/class-context");

Page({
  data: {
    classes: [],
    currentId: "",
    loading: true,
    showArchived: false,
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
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const q = this.data.showArchived ? "?includeArchived=1" : "";
      const data = await request({ url: `/api/v1/classes${q}`, method: "GET" });
      let classes = data.classes || [];
      if (this.data.showArchived) {
        // 仅看归档时过滤；全量时已含活跃+归档
        // 列表展示：活跃在前
        classes = classes.slice().sort((a, b) => {
          if (a.archived === b.archived) return 0;
          return a.archived ? 1 : -1;
        });
      }
      let currentId = getCurrentClassId();
      const active = classes.filter((c) => !c.archived);
      if (active.length && !active.find((c) => c.id === currentId)) {
        currentId = active[0].id;
        setCurrentClassId(currentId);
      }
      if (!active.length) {
        if (currentId && !active.find((c) => c.id === currentId)) {
          setCurrentClassId("");
          currentId = "";
        }
      }
      this.setData({ classes, currentId, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  toggleArchived() {
    this.setData({ showArchived: !this.data.showArchived }, () => this.load());
  },

  goCreate() {
    wx.navigateTo({ url: "/pages/teacher/classes/create" });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/teacher/classes/detail?id=${id}` });
  },

  setCurrent(e) {
    const id = e.currentTarget.dataset.id;
    const archived = e.currentTarget.dataset.archived;
    if (archived) {
      wx.showToast({ title: "归档班不能设为当前", icon: "none" });
      return;
    }
    setCurrentClassId(id);
    this.setData({ currentId: id });
    wx.showToast({ title: "已切换当前班", icon: "success" });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/teacher/home/home" });
  },

  goAssignments() {
    wx.reLaunch({ url: "/pages/teacher/assignments/list" });
  },

  goQuestions() {
    wx.reLaunch({ url: "/pages/teacher/questions/list" });
  },

  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },
});
