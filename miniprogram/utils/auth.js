const TOKEN_KEY = "suanben_token";
const USER_KEY = "suanben_user";

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

function clearAuth() {
  setToken("");
  setUser(null);
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
  clearAuth,
  routeByUser,
};
