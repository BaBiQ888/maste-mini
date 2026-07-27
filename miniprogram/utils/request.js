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
  const msg =
    (data && (data.message || data.errmsg || data.error)) ||
    (code === 500 ? "服务器错误" : "请求失败");
  reject(
    Object.assign(new Error(msg), {
      code: data && data.code,
      statusCode: code,
      body: data,
    }),
  );
}

function formatNetError(err, via) {
  const detail = (err && (err.errMsg || err.message || err.errCode)) || "";
  const text = String(detail);
  if (text.includes("url not in domain") || text.includes("not in domain list")) {
    return via === "http"
      ? "公网域名未加入 request 合法域名。正式请用 callContainer，不要依赖公网"
      : "云调用失败且公网域名未配置";
  }
  if (text.includes("Cloud API isn't enabled")) {
    return "云能力未就绪，请稍后重试或检查环境 ID";
  }
  if (text.includes("env") && (text.includes("not found") || text.includes("invalid"))) {
    return "云环境 ID 无效，请核对 app.js 的 cloudEnv";
  }
  const short = text.replace(/^request:fail\s*/i, "").slice(0, 120);
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
      const httpMsg = formatNetError(err, "http");
      const msg = cloudFailMsg
        ? `云调用失败：${cloudFailMsg}；回退公网：${httpMsg}`
        : httpMsg;
      reject(Object.assign(new Error(msg), err));
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
      reject(new Error("callContainer 不可用"));
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
 * Prefer callContainer (injects X-WX-OPENID for login); fall back to public HTTPS.
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
        doHttp(false, "当前环境不支持 callContainer");
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
        handleResponse(res, resolve, reject);
      } catch (err) {
        const cloudMsg = formatNetError(err, "cloud");
        console.warn("[request] callContainer fail → HTTPS fallback", {
          env,
          service,
          path,
          err,
        });
        // HTTPS fallback: works with WECHAT_MOCK=1 (deviceId openid).
        // Real WeChat needs either callContainer (X-WX-OPENID) or container
        // outbound jscode2session + request 合法域名.
        doHttp(false, cloudMsg);
      }
    };

    runCloud();
  });
}

module.exports = { request, getBase, useCloudCall, cloudConfig };
