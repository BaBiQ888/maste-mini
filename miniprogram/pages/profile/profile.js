const {
  getToken,
  getUser,
  setUser,
  clearAuth,
  routeByUser,
} = require("../../utils/auth");
const { request } = require("../../utils/request");
const { resolveImageSrc } = require("../../utils/media");
const { showError } = require("../../utils/errors");

Page({
  data: {
    nickname: "",
    avatarUrl: "",
    displayAvatar: "",
    roleLabel: "",
    loading: false,
    tabRole: "",
    badge: 0,
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
    this.applyUser(user);
    this.loadBadge(user);
  },

  async applyUser(user) {
    const avatarUrl = user.avatarUrl || "";
    this.setData({
      nickname: user.nickname || "",
      avatarUrl,
      roleLabel:
        user.role === "teacher"
          ? "老师"
          : user.role === "student"
            ? "学生"
            : "未选择",
      tabRole: user.role === "teacher" || user.role === "student" ? user.role : "",
    });
    const displayAvatar = avatarUrl ? await resolveImageSrc(avatarUrl) : "";
    // Avoid clobbering a newer avatar if user changed while resolving
    if ((this.data.avatarUrl || "") === avatarUrl) {
      this.setData({ displayAvatar });
    }
  },

  async loadBadge(user) {
    if (user.role !== "teacher") {
      this.setData({ badge: 0 });
      return;
    }
    try {
      const data = await request({ url: "/api/v1/assignments", method: "GET" });
      this.setData({ badge: data.pendingGrade || 0 });
    } catch (_) {
      /* ignore */
    }
  },

  onNickname(e) {
    this.setData({ nickname: (e.detail.value || "").trim() });
  },

  async onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;
    this.setData({ loading: true });
    try {
      const url = await this.uploadAvatarFile(tempPath);
      const displayAvatar = await resolveImageSrc(url);
      this.setData({
        avatarUrl: url,
        displayAvatar: displayAvatar || tempPath,
        loading: false,
      });
      wx.showToast({ title: "头像已选，记得保存", icon: "none" });
    } catch (err) {
      this.setData({ loading: false });
      // Fallback: keep temp path for local preview only
      this.setData({
        avatarUrl: tempPath,
        displayAvatar: tempPath,
      });
      showError(err, {
        tag: "avatar.upload",
        fallback: "头像上传失败，可先保存其它信息",
      });
    }
  },

  uploadAvatarFile(filePath) {
    return new Promise((resolve, reject) => {
      const fs = wx.getFileSystemManager();
      fs.readFile({
        filePath,
        encoding: "base64",
        success: async (res) => {
          try {
            const lower = (filePath || "").toLowerCase();
            const mime = lower.indexOf(".png") >= 0 ? "image/png" : "image/jpeg";
            const data = await request({
              url: "/api/v1/uploads/photo",
              method: "POST",
              data: { data: res.data, mime },
            });
            resolve(data.url);
          } catch (e) {
            reject(e);
          }
        },
        fail: () => reject(new Error("读取头像失败")),
      });
    });
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
      this.applyUser(data.user);
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (e) {
      showError(e, { fallback: "保存失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onChangeRole() {
    wx.showModal({
      title: "切换身份",
      content:
        "将进入身份选择页。切到老师需要开通码；班级与作业数据仍按原账号保留。",
      confirmText: "去切换",
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: "/pages/role/role?change=1" });
        }
      },
    });
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
