const { getToken, clearAuth } = require("./auth");
const mockApi = require("./mock-api");
const {
  logError,
  toUserError,
  mapNetworkFailure,
  friendlyMessage,
} = require("./errors");

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

function useMockData() {
  const app = getAppSafe();
  if (app && app.globalData && app.globalData.useMockData === true) return true;
  try {
    const g = getApp();
    if (g && g.globalData && g.globalData.useMockData) return true;
  } catch (_) {
    /* ignore */
  }
  return false;
}

function useCloudCall() {
  if (useMockData()) return false;
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

/**
 * Turn HTTP response into a user-safe Error; full payload goes to console only.
 */
function handleResponse(res, resolve, reject, meta) {
  const status = res.statusCode;
  const data = res.data;
  const code = Number(status);
  const path = (meta && meta.path) || "";
  const method = (meta && meta.method) || "";

  if (code === 401) {
    clearAuth();
    const err = toUserError(
      { code: "UNAUTHORIZED", statusCode: 401, body: data },
      {
        code: "UNAUTHORIZED",
        statusCode: 401,
        body: data,
        rawMessage: (data && data.message) || "未登录",
        fallback: "登录已过期，请重新登录",
      },
    );
    logError("http.401", err, { method, path, status: code, body: data });
    reject(err);
    return;
  }

  if (code >= 200 && code < 300) {
    resolve(data);
    return;
  }

  if (
    code === 503 &&
    data &&
    (data.phase === "starting" ||
      data.phase === "connecting_db" ||
      data.code === "STARTING" ||
      data.code === "DB_ERROR")
  ) {
    const err = toUserError(
      { code: data.code || "STARTING", statusCode: 503, body: data },
      {
        code: data.code === "DB_ERROR" ? "DB_ERROR" : "STARTING",
        statusCode: 503,
        body: data,
        rawMessage: (data && data.message) || "服务启动中",
        fallback:
          data.code === "DB_ERROR"
            ? "服务暂时不可用，请稍后重试"
            : "服务正在启动，请几秒后再试",
      },
    );
    logError("http.503", err, { method, path, status: code, body: data });
    reject(err);
    return;
  }

  const apiCode = data && data.code;
  const rawMessage =
    (data && (data.message || data.errmsg || data.error)) ||
    (code === 500 ? "服务器错误" : "请求失败");

  const err = toUserError(
    { code: apiCode, statusCode: code, body: data, message: rawMessage },
    {
      code: apiCode,
      statusCode: code,
      body: data,
      rawMessage: String(rawMessage),
      fallback: code >= 500 ? "服务暂时出了点问题，请稍后重试" : "操作失败，请稍后重试",
    },
  );
  logError("http.error", err, {
    method,
    path,
    status: code,
    apiCode,
    body: data,
  });
  reject(err);
}

function httpRequest({
  url,
  method,
  data,
  token,
  resolve,
  reject,
  retry,
  isRetry,
  cloudFailMsg,
}) {
  wx.request({
    url: getBase() + url,
    method,
    data,
    header: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    success(res) {
      handleResponse(res, resolve, reject, { path: url, method });
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
              cloudFailMsg,
            }),
          400,
        );
        return;
      }
      const mapped = mapNetworkFailure(err, "http");
      if (cloudFailMsg) {
        logError("http.fail.afterCloud", err, {
          method,
          path: url,
          cloudFailMsg,
          raw: err && (err.errMsg || err.message),
        });
        // User only sees one clear line; details stay in log
        const combined = toUserError(err, {
          code: mapped.code || "NETWORK",
          statusCode: 0,
          rawMessage: `cloud:${cloudFailMsg}; http:${mapped.rawMessage || ""}`,
          fallback: "网络不太稳定，请稍后重试",
        });
        reject(combined);
        return;
      }
      logError("http.fail", err, {
        method,
        path: url,
        raw: err && (err.errMsg || err.message),
      });
      reject(mapped);
    },
  });
}

function callContainerOnce({ path, method, data, token, env, service, cloudApi }) {
  return new Promise((resolve, reject) => {
    const header = {
      "Content-Type": "application/json",
      "X-WX-SERVICE": service,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const payload = {
      config: { env },
      path,
      method,
      header,
      timeout: 15000,
      success: resolve,
      fail: reject,
    };
    if (method !== "GET" && data !== undefined) {
      payload.data = data;
    } else if (method === "GET" && data && Object.keys(data).length) {
      payload.data = data;
    } else if (method !== "GET") {
      payload.data = data || {};
    }

    const api = cloudApi || wx.cloud;
    if (!api || typeof api.callContainer !== "function") {
      reject(
        toUserError(null, {
          code: "CLOUD",
          rawMessage: "callContainer 不可用",
          fallback: "云服务未就绪，请稍后重试",
        }),
      );
      return;
    }
    try {
      api.callContainer(payload);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Prefer local mock (no network), else callContainer, else public HTTPS.
 * Rejects always carry friendly .message; full detail is logged.
 */
function request({ url, method = "GET", data, retry = true }) {
  const token = getToken();
  const path = url.startsWith("/") ? url : `/${url}`;

  if (useMockData()) {
    return mockApi.handle(path, method, data).catch((e) => {
      const err = toUserError(e, {
        code: e && e.code,
        statusCode: e && e.statusCode,
        rawMessage: e && e.message,
        fallback: "操作失败，请稍后重试",
      });
      logError("mock-api", err, { method, path, raw: e && e.message });
      return Promise.reject(err);
    });
  }

  return new Promise((resolve, reject) => {
    const doHttp = (isRetry, cloudFailMsg) =>
      httpRequest({
        url: path,
        method,
        data,
        token,
        resolve,
        reject,
        retry,
        isRetry,
        cloudFailMsg,
      });

    if (!useCloudCall()) {
      doHttp(false);
      return;
    }

    const runCloud = async () => {
      const app = getAppSafe();
      if (app && typeof app.ensureCloud === "function") {
        try {
          await app.ensureCloud();
        } catch (_) {
          /* continue with wx.cloud */
        }
      }
      const { env, service } = cloudConfig();
      const cloudApi =
        (app && app.globalData && app.globalData.cloud) || wx.cloud;

      if (!cloudApi || typeof cloudApi.callContainer !== "function") {
        logError("cloud.unavailable", null, { env, service, path });
        doHttp(false, "当前环境不支持云调用");
        return;
      }

      try {
        const res = await callContainerOnce({
          path,
          method,
          data,
          token,
          env,
          service,
          cloudApi,
        });
        handleResponse(res, resolve, reject, { path, method });
      } catch (err) {
        const cloudMsg = friendlyMessage(
          mapNetworkFailure(err, "cloud"),
          "云调用失败",
        );
        logError("cloud.fail", err, {
          env,
          service,
          path,
          method,
          cloudMsg,
          raw: err && (err.errMsg || err.message),
        });
        // Fallback HTTPS — still one user-facing path
        doHttp(false, cloudMsg);
      }
    };

    runCloud();
  });
}

module.exports = {
  request,
  getBase,
  useCloudCall,
  useMockData,
  cloudConfig,
};
