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
  // callContainer sometimes returns statusCode as string
  const code = Number(status);
  if (code === 401) {
    clearAuth();
    reject(
      Object.assign(new Error((data && data.message) || "未登录"), {
        code: "UNAUTHORIZED",
        statusCode: 401,
      }),
    );
    return;
  }
  if (code >= 200 && code < 300) {
    resolve(data);
    return;
  }
  // 服务还在启动 / DB 未就绪
  if (code === 503 && data && (data.phase === "starting" || data.phase === "connecting_db" || data.code === "STARTING")) {
    reject(
      Object.assign(new Error("服务启动中，请几秒后再试"), {
        code: "STARTING",
        statusCode: 503,
      }),
    );
    return;
  }
  reject(
    Object.assign(new Error((data && data.message) || "请求失败"), {
      code: data && data.code,
      statusCode: code,
    }),
  );
}

function httpRequest({ url, method, data, token, resolve, reject, retry, isRetry }) {
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
        setTimeout(
          () =>
            httpRequest({
              url,
              method,
              data,
              token,
              resolve,
              reject,
              retry,
              isRetry: true,
            }),
          400,
        );
        return;
      }
      const detail = (err && (err.errMsg || err.message)) || "";
      reject(
        Object.assign(
          new Error(
            detail.includes("url not in domain")
              ? "域名未配置：请在小程序后台添加 request 合法域名，或开发者工具关闭域名校验"
              : "网络错误，请检查后端地址与域名配置",
          ),
          err,
        ),
      );
    },
  });
}

/**
 * Prefer callContainer; on fail fall back to public HTTPS (apiBase).
 * @param {{ url: string, method?: string, data?: any, retry?: boolean }} opts
 */
function request({ url, method = "GET", data, retry = true }) {
  const token = getToken();
  const path = url.startsWith("/") ? url : `/${url}`;

  return new Promise((resolve, reject) => {
    const doHttp = (isRetry) =>
      httpRequest({
        url: path,
        method,
        data,
        token,
        resolve,
        reject,
        retry,
        isRetry,
      });

    if (!(useCloudCall() && wx.cloud && typeof wx.cloud.callContainer === "function")) {
      doHttp(false);
      return;
    }

    const { env, service } = cloudConfig();
    const payload = {
      config: { env },
      path,
      method,
      header: {
        "Content-Type": "application/json",
        "X-WX-SERVICE": service,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      success(res) {
        handleResponse(res, resolve, reject);
      },
      fail(err) {
        console.warn("[request] callContainer fail, fallback to HTTPS", err);
        // 云调用失败时改走公网域名（开发者工具 / 未开通云调用权限时很常见）
        doHttp(false);
      },
    };
    // GET 可不传 data，部分基础库对空对象敏感
    if (method !== "GET" && data !== undefined) {
      payload.data = data;
    } else if (method === "GET" && data && Object.keys(data).length) {
      payload.data = data;
    } else if (method !== "GET") {
      payload.data = data || {};
    }

    try {
      wx.cloud.callContainer(payload);
    } catch (e) {
      console.warn("[request] callContainer throw, fallback to HTTPS", e);
      doHttp(false);
    }
  });
}

module.exports = { request, getBase, useCloudCall, cloudConfig };
