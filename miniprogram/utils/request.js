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
  if (
    code === 503 &&
    data &&
    (data.phase === "starting" ||
      data.phase === "connecting_db" ||
      data.code === "STARTING")
  ) {
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

function formatNetError(err, via) {
  const detail = (err && (err.errMsg || err.message || err.errCode)) || "";
  const text = String(detail);
  if (text.includes("url not in domain") || text.includes("not in domain list")) {
    return via === "http"
      ? "公网域名未加入小程序 request 合法域名（正式环境请优先修复 callContainer）"
      : "云调用失败且公网域名未配置";
  }
  if (text.includes("cloud init") || text.includes("Cloud API isn't enabled")) {
    return "云能力未启用：请确认小程序已开通云托管且环境 ID 正确";
  }
  if (text.includes("env") && (text.includes("not found") || text.includes("invalid"))) {
    return "云环境 ID 无效，请核对 app.js 的 cloudEnv";
  }
  if (text.includes("SERVICE") || text.includes("service")) {
    return "云托管服务名无效，请核对 cloudService（express-gy84）";
  }
  // 截断过长 errMsg，便于 toast
  const short = text.replace(/^request:fail\s*/i, "").slice(0, 80);
  return short || (via === "cloud" ? "云调用失败" : "网络错误");
}

function httpRequest({ url, method, data, token, resolve, reject, retry, isRetry, cloudFailMsg }) {
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
              cloudFailMsg,
            }),
          400,
        );
        return;
      }
      // Prefer showing cloud error root cause when both failed
      const httpMsg = formatNetError(err, "http");
      const msg = cloudFailMsg
        ? `云调用失败：${cloudFailMsg}；回退公网：${httpMsg}`
        : httpMsg;
      reject(Object.assign(new Error(msg), err));
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

    if (!(useCloudCall() && wx.cloud && typeof wx.cloud.callContainer === "function")) {
      console.warn(
        "[request] callContainer unavailable",
        "wx.cloud=",
        !!wx.cloud,
        "useCloud=",
        useCloudCall(),
      );
      doHttp(false, "当前环境不支持 callContainer");
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
      timeout: 20000,
      success(res) {
        // callContainer may return non-2xx in success callback
        handleResponse(res, resolve, reject);
      },
      fail(err) {
        const cloudMsg = formatNetError(err, "cloud");
        console.warn("[request] callContainer fail → HTTPS fallback", {
          env,
          service,
          path,
          err,
        });
        doHttp(false, cloudMsg);
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
      const cloudMsg = formatNetError(e, "cloud");
      console.warn("[request] callContainer throw → HTTPS fallback", e);
      doHttp(false, cloudMsg);
    }
  });
}

module.exports = { request, getBase, useCloudCall, cloudConfig };
