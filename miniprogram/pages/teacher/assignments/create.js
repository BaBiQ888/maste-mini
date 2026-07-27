const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { getCurrentClassId } = require("../../../utils/class-context");

/**
 * 布置作业统一入口：选类型 → 跳转对应创建页
 * 拍照表单见 create-photo
 */
Page({
  data: {
    classId: "",
  },

  onLoad(q) {
    const classId = q.classId || getCurrentClassId() || "";
    this.setData({ classId });
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

  qs() {
    const id = this.data.classId;
    return id ? `?classId=${id}` : "";
  },

  goPhoto() {
    wx.navigateTo({
      url: `/pages/teacher/assignments/create-photo${this.qs()}`,
    });
  },
  goDrill() {
    wx.navigateTo({
      url: `/pages/teacher/assignments/create-drill${this.qs()}`,
    });
  },
  goCheckin() {
    wx.navigateTo({
      url: `/pages/teacher/assignments/create-checkin${this.qs()}`,
    });
  },
  goOnline() {
    wx.navigateTo({
      url: `/pages/teacher/assignments/create-online${this.qs()}`,
    });
  },
});
