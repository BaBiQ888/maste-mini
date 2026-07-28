/**
 * Error UX: log full details for debug; show short friendly text to users.
 */

/** Known API / domain codes → user-facing Chinese */
const CODE_MESSAGES = {
  UNAUTHORIZED: "登录已过期，请重新登录",
  FORBIDDEN: "没有权限做这个操作",
  VALIDATION: "填写内容有误，请检查后重试",
  INCOMPLETE: "还有题目没答完，请先完成再交卷",
  INVALID_STATUS: "当前状态不能这样操作",
  TIMER_ACTIVE: "限时还没结束，请继续作答",
  TEACHER_CODE_REQUIRED: "请填写教师开通码",
  TEACHER_CODE_INVALID: "教师开通码不正确，请核对后重试",
  ROLE_LOCKED: "身份暂不可更改",
  NOT_FOUND: "内容不存在或已删除",
  INTERNAL: "服务暂时出了点问题，请稍后重试",
  STARTING: "服务正在启动，请几秒后再试",
  DB_ERROR: "服务暂时不可用，请稍后重试",
  NOT_IMPLEMENTED: "该功能暂不可用",
  WECHAT_NETWORK: "微信登录暂时连不上，请稍后重试",
  WECHAT_ERROR: "微信登录失败，请稍后重试",
  INVALID_CODE: "登录凭证无效，请重新登录",
  INVALID_ROLE: "请选择老师或学生身份",
  INVALID_PHOTOS: "请检查照片后重试",
  INVALID_TYPE: "作业类型不正确",
  INVALID_QUESTIONS: "题目不完整，请联系老师",
  INVALID_QUESTION: "题目不属于该作业",
  INVALID_KNOWLEDGE: "请至少选择 1 个知识点",
  INVALID_MEMBER: "不能这样操作该成员",
  INVALID_CODE: "邀请码无效，请核对后重试",
  CLASS_ARCHIVED: "该班级已归档，无法加入",
  NETWORK: "网络不太稳定，请检查后重试",
  TIMEOUT: "请求超时，请稍后重试",
  CLOUD: "云服务暂时连不上，请稍后重试",
};

/** Substrings that must never surface to users as-is */
const TECH_PATTERNS = [
  /ECONN/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /request:fail/i,
  /callContainer/i,
  /jscode2session/i,
  /mysql/i,
  /SQLITE/i,
  /stack/i,
  /at\s+\w+\s+\(/i,
  /TypeError/i,
  /ReferenceError/i,
  /undefined is not/i,
  /Cannot read/i,
  /statusCode/i,
  /HTTP\s*\d{3}/i,
  /X-WX-/i,
  /openid/i,
  /Bearer/i,
  /\/api\/v1\//i,
  /Mock 未实现/i,
  /not in domain/i,
  /ERR_/i,
  /\{.*\}/,
  /\[object /i,
];

function logError(tag, err, extra) {
  const payload = {
    tag: tag || "error",
    message: err && err.message,
    rawMessage: err && err.rawMessage,
    code: err && err.code,
    statusCode: err && err.statusCode,
    body: err && err.body,
    errMsg: err && err.errMsg,
    stack: err && err.stack,
  };
  if (extra && typeof extra === "object") {
    Object.keys(extra).forEach((k) => {
      payload[k] = extra[k];
    });
  }
  try {
    console.error("[suanben]", payload);
  } catch (_) {
    /* ignore console failures */
  }
}

function isTechnicalText(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  if (s.length > 80) return true;
  for (let i = 0; i < TECH_PATTERNS.length; i++) {
    if (TECH_PATTERNS[i].test(s)) return true;
  }
  // Mostly ASCII / path-like → treat as technical
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk === 0 && s.length > 12) return true;
  return false;
}

/**
 * Prefer known code map; else short Chinese server message; else fallback.
 */
function friendlyMessage(err, fallback) {
  const fb = fallback || "操作失败，请稍后重试";
  if (!err) return fb;

  const code = err.code || (err.body && err.body.code);
  if (code && CODE_MESSAGES[code]) {
    return CODE_MESSAGES[code];
  }

  const status = Number(err.statusCode || 0);
  if (status === 401) return CODE_MESSAGES.UNAUTHORIZED;
  if (status === 403) return CODE_MESSAGES.FORBIDDEN;
  if (status === 404) return CODE_MESSAGES.NOT_FOUND;
  if (status === 503) return CODE_MESSAGES.STARTING;
  if (status >= 500) return CODE_MESSAGES.INTERNAL;

  const candidates = [
    err.userMessage,
    err.body && err.body.message,
    err.rawMessage,
    err.message,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c && !isTechnicalText(c)) {
      return String(c).trim().slice(0, 48);
    }
  }

  return fb;
}

/**
 * Build a user-facing Error while keeping raw fields for logs.
 */
function toUserError(raw, opts) {
  const options = opts || {};
  const statusCode =
    options.statusCode != null
      ? options.statusCode
      : raw && raw.statusCode != null
        ? raw.statusCode
        : undefined;
  const code =
    options.code ||
    (raw && raw.code) ||
    (raw && raw.body && raw.body.code) ||
    undefined;
  const body = options.body != null ? options.body : raw && raw.body;
  const rawMessage =
    options.rawMessage ||
    (raw && (raw.rawMessage || raw.message || raw.errMsg)) ||
    "";

  const draft = {
    code,
    statusCode,
    body,
    rawMessage: String(rawMessage || ""),
    message: rawMessage,
  };
  const userMsg = friendlyMessage(draft, options.fallback);

  const err = new Error(userMsg);
  err.code = code;
  err.statusCode = statusCode;
  err.body = body;
  err.rawMessage = draft.rawMessage;
  err.userMessage = userMsg;
  if (raw && raw.errMsg) err.errMsg = raw.errMsg;
  return err;
}

/**
 * Show friendly tip to user (toast for short, modal for long / serious).
 * Always logs full error first.
 *
 * @param {unknown} err
 * @param {{ tag?: string, fallback?: string, modal?: boolean, extra?: object }} [opts]
 */
function showError(err, opts) {
  const options = opts || {};
  logError(options.tag || "ui", err, options.extra);

  const text = friendlyMessage(err, options.fallback);
  const useModal =
    options.modal === true ||
    text.length > 22 ||
    (err && Number(err.statusCode) >= 500) ||
    (err && err.code === "UNAUTHORIZED");

  if (useModal) {
    wx.showModal({
      title: "提示",
      content: text,
      showCancel: false,
      confirmText: "知道了",
    });
  } else {
    wx.showToast({
      title: text,
      icon: "none",
      duration: 2800,
    });
  }
  return text;
}

/**
 * Map raw network / wx failure strings to friendly copy + code.
 */
function mapNetworkFailure(err, via) {
  const detail = String(
    (err && (err.errMsg || err.message || err.errCode)) || "",
  );
  let code = "NETWORK";
  let fallback = "网络不太稳定，请检查后重试";

  if (
    detail.indexOf("url not in domain") >= 0 ||
    detail.indexOf("not in domain list") >= 0
  ) {
    code = "NETWORK";
    fallback = "网络配置未就绪，请稍后重试或联系老师";
  } else if (detail.indexOf("Cloud API isn't enabled") >= 0) {
    code = "CLOUD";
    fallback = "云服务未就绪，请稍后重试";
  } else if (
    detail.indexOf("env") >= 0 &&
    (detail.indexOf("not found") >= 0 || detail.indexOf("invalid") >= 0)
  ) {
    code = "CLOUD";
    fallback = "云环境配置有误，请联系管理员";
  } else if (/timeout|超时/i.test(detail)) {
    code = "TIMEOUT";
    fallback = "请求超时，请稍后重试";
  } else if (via === "cloud") {
    code = "CLOUD";
    fallback = "云服务暂时连不上，请稍后重试";
  }

  return toUserError(err, {
    code,
    statusCode: 0,
    rawMessage: detail,
    fallback,
  });
}

module.exports = {
  CODE_MESSAGES,
  logError,
  friendlyMessage,
  toUserError,
  showError,
  mapNetworkFailure,
  isTechnicalText,
};
