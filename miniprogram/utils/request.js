const { getToken, clearAuth } = require("./auth");

/** Cloud hosting defaults (override via app.globalData). */
const CLOUD_DEFAULTS = {
  env: "prod-d3gbci34xbe09e370",
  service: "express-gy84",
};

function getAppSafe() {
  try {
    return getApp();
  } catch {
    return null;
  }
}

function getBase() {
  const app = getAppSafe();
  return (
    (app && app.globalData && app.globalData.apiBase) ||
    "https://express-gy84-287111-10-1458458765.sh.run.tcloudbase.com"
  );
}

function useCloudCall() {
  const app = getAppSafe();
  if (!app || !app.globalData) return false;
  // Explicit flag; default true when cloudEnv is set
  if (app.globalData.useCloud === false) return false;
  if (app.globalData.useCloud === true) return true;
  return Boolean(app.globalData.cloudEnv);
}

function cloudConfig() {
  const app = getAppSafe();
  const g = (app && app.globalData) || {};
  return {
    env: g.cloudEnv || CLOUD_DEFAULTS.env,
    service: g.cloudService || CLOUD_DEFAULTS.service,
  };
}

function handleResponse(res, resolve, reject) {
  const status = res.statusCode;
  const data = res.data;
  if (status === 401) {
    clearAuth();
    reject(
      Object.assign(new Error((data && data.message) || "未登录"), {
        code: "UNAUTHORIZED",
        statusCode: 401,
      }),
    );
    return;
  }
  if (status >= 200 && status < 300) {
    resolve(data);
    return;
  }
  reject(
    Object.assign(new Error((data && data.message) || "请求失败"), {
      code: data && data.code,
      statusCode: status,
    }),
  );
}

/**
 * @param {{ url: string, method?: string, data?: any, retry?: boolean }} opts
 */
function request({ url, method = "GET", data, retry = true }) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const attempt = (isRetry) => {
      if (useCloudCall() && wx.cloud && wx.cloud.callContainer) {
        const { env, service } = cloudConfig();
        wx.cloud.callContainer({
          config: { env },
          path: url.startsWith("/") ? url : `/${url}`,
          method,
          data: data || {},
          header: {
            "Content-Type": "application/json",
            "X-WX-SERVICE": service,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          success(res) {
            handleResponse(res, resolve, reject);
          },
          fail(err) {
            if (retry && !isRetry) {
              setTimeout(() => attempt(true), 400);
              return;
            }
            reject(
              Object.assign(
                new Error("网络错误，请检查云托管服务是否部署成功"),
                err,
              ),
            );
          },
        });
        return;
      }

      wx.request({
        url: getBase() + url,
        method,
        data,
        header: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        success(res) {
          handleResponse(res, resolve, reject);
        },
        fail(err) {
          if (retry && !isRetry) {
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

module.exports = { request, getBase, useCloudCall, cloudConfig };
