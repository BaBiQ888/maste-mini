const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError, logError } = require("../../../utils/errors");

Page({
  data: {
    items: [],
    loading: true,
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user || user.role !== "student") {
      routeByUser(user);
      return;
    }
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const data = await request({ url: "/api/v1/me/inbox", method: "GET" });
      this.setData({ items: data.items || [], loading: false });
      // Ack so badge clears
      await request({
        url: "/api/v1/me/inbox/ack",
        method: "POST",
        data: {},
      }).catch((err) => {
        logError("inbox.ack", err, {});
      });
    } catch (e) {
      this.setData({ loading: false });
      showError(e, { tag: "inbox.load", fallback: "加载失败" });
    }
  },
});
