const TOKEN_KEY = "suanben_token";
const USER_KEY = "suanben_user";
/** Survives logout — mock login uses this so re-login reuses the same account */
const DEVICE_ID_KEY = "suanben_device_id";

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || "";
}

function setToken(token) {
  if (token) {
    wx.setStorageSync(TOKEN_KEY, token);
  } else {
    wx.removeStorageSync(TOKEN_KEY);
  }
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null;
}

function setUser(user) {
  if (user) {
    wx.setStorageSync(USER_KEY, user);
  } else {
    wx.removeStorageSync(USER_KEY);
  }
}

/**
 * Stable device id for mock/dev identity (and as fallback).
 * NOT cleared on logout — required so teachers/students get the same account.
 */
function getOrCreateDeviceId() {
  let id = wx.getStorageSync(DEVICE_ID_KEY);
  if (id && typeof id === "string" && id.length >= 8) {
    return id;
  }
  id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  wx.setStorageSync(DEVICE_ID_KEY, id);
  return id;
}

function clearAuth() {
  setToken("");
  setUser(null);
  // keep DEVICE_ID_KEY on purpose
}

function routeByUser(user) {
  if (!user) {
    wx.reLaunch({ url: "/pages/login/login" });
    return;
  }
  if (!user.role) {
    wx.reLaunch({ url: "/pages/role/role" });
    return;
  }
  if (user.role === "teacher") {
    wx.reLaunch({ url: "/pages/teacher/home/home" });
    return;
  }
  wx.reLaunch({ url: "/pages/student/home/home" });
}

module.exports = {
  getToken,
  setToken,
  getUser,
  setUser,
  getOrCreateDeviceId,
  clearAuth,
  routeByUser,
};
