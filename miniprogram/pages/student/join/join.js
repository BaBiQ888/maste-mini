const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");

Page({
  data: {
    inviteCode: "",
    loading: false,
  },

  onLoad(q) {
    if (q.code) {
      this.setData({ inviteCode: parseInvitePayload(q.code) });
    }
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user || user.role !== "student") {
      routeByUser(user);
    }
  },

  onCode(e) {
    this.setData({ inviteCode: (e.detail.value || "").toUpperCase() });
  },

  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        const code = parseInvitePayload(res.result || "");
        if (!code) {
          wx.showToast({ title: "无法识别邀请码", icon: "none" });
          return;
        }
        this.setData({ inviteCode: code });
        this.onSubmit();
      },
      fail: () => {
        wx.showToast({ title: "已取消扫码", icon: "none" });
      },
    });
  },

  async onSubmit() {
    const inviteCode = parseInvitePayload(this.data.inviteCode || "");
    if (!inviteCode) {
      wx.showToast({ title: "请输入邀请码", icon: "none" });
      return;
    }
    this.setData({ loading: true, inviteCode });
    try {
      const data = await request({
        url: "/api/v1/classes/join",
        method: "POST",
        data: { inviteCode },
      });
      wx.showToast({ title: "已加入", icon: "success" });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/student/classes/list?highlight=${data.class.id}`,
        });
      }, 400);
    } catch (e) {
      wx.showToast({ title: e.message || "加入失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
});

function parseInvitePayload(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  // URL ?code=XXX
  const m = s.match(/[?&]code=([A-Za-z0-9]+)/i);
  if (m) s = m[1];
  s = s.replace(/^SUANBEN:/i, "").trim().toUpperCase();
  return s;
}
