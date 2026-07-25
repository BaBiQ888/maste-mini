const { getToken, clearAuth } = require("./auth");

function getBase() {
  const app = getApp();
  return (app && app.globalData && app.globalData.apiBase) || "http://127.0.0.1:3000";
}

/**
 * @param {{ url: string, method?: string, data?: any, retry?: boolean }} opts
 */
function request({ url, method = "GET", data, retry = true }) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const attempt = (isRetry) => {
      wx.request({
        url: getBase() + url,
        method,
        data,
        header: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        success(res) {
          if (res.statusCode === 401) {
            clearAuth();
            reject(
              Object.assign(new Error(res.data?.message || "未登录"), {
                code: "UNAUTHORIZED",
                statusCode: 401,
              }),
            );
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data);
            return;
          }
          reject(
            Object.assign(new Error(res.data?.message || "请求失败"), {
              code: res.data?.code,
              statusCode: res.statusCode,
            }),
          );
        },
        fail(err) {
          if (retry && !isRetry) {
            // one automatic retry on network failure
            setTimeout(() => attempt(true), 400);
            return;
          }
          reject(
            Object.assign(
              new Error("网络错误，请检查后端是否启动后下拉重试"),
              err,
            ),
          );
        },
      });
    };
    attempt(false);
  });
}

module.exports = { request, getBase };
