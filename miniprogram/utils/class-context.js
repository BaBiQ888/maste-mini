const CURRENT_CLASS_KEY = "suanben_current_class_id";

function getCurrentClassId() {
  return wx.getStorageSync(CURRENT_CLASS_KEY) || "";
}

function setCurrentClassId(id) {
  if (id) {
    wx.setStorageSync(CURRENT_CLASS_KEY, id);
  } else {
    wx.removeStorageSync(CURRENT_CLASS_KEY);
  }
}

module.exports = {
  getCurrentClassId,
  setCurrentClassId,
};
