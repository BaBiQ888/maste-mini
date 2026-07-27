export interface WechatSession {
  openid: string;
  sessionKey?: string;
  unionid?: string;
}

export interface WechatConfig {
  appId: string;
  appSecret: string;
  /** When true (default in dev without credentials), map identity → stable mock openid */
  mock: boolean;
}

/**
 * Resolve WeChat login code to openid.
 * Real path: jscode2session (openid stable per WeChat user).
 * Mock path: prefer deviceId for stable identity across logout/re-login
 * (wx.login codes change every time and would mint a new account).
 */
export async function codeToSession(
  code: string,
  config: WechatConfig,
  options?: { deviceId?: string },
): Promise<WechatSession> {
  if (!code || !code.trim()) {
    throw new AuthError("INVALID_CODE", "登录 code 不能为空");
  }

  const appId = (config.appId || "").trim();
  const appSecret = (config.appSecret || "").trim();
  const useMock = config.mock || !appId || !appSecret;

  if (useMock) {
    const seed =
      options?.deviceId && options.deviceId.trim()
        ? `device:${options.deviceId.trim()}`
        : `code:${code.trim()}`;
    const openid = `mock_${hashCode(seed)}`;
    return { openid, sessionKey: "mock_session_key" };
  }

  // Real WeChat login — reject obvious non-wx codes early
  if (code.startsWith("dev_fallback_") || code.startsWith("dev_")) {
    throw new AuthError(
      "INVALID_CODE",
      "未获取到有效微信登录 code，请用已关联 AppID 的真机/体验版重试",
    );
  }

  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", appId);
  url.searchParams.set("secret", appSecret);
  url.searchParams.set("js_code", code.trim());
  url.searchParams.set("grant_type", "authorization_code");

  let data: {
    openid?: string;
    session_key?: string;
    unionid?: string;
    errcode?: number;
    errmsg?: string;
  };

  try {
    const res = await fetch(url.toString());
    const text = await res.text();
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new AuthError(
        "WECHAT_ERROR",
        `微信接口返回非 JSON（HTTP ${res.status}）`,
        text.slice(0, 200),
      );
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new AuthError(
      "WECHAT_NETWORK",
      `无法连接微信登录接口：${msg}`,
      e,
    );
  }

  if (data.errcode || !data.openid) {
    const hint =
      data.errcode === 40029
        ? "（code 无效或已使用，请重试登录）"
        : data.errcode === 40163
          ? "（code 已被使用）"
          : data.errcode === 40125
            ? "（AppSecret 错误，请检查云托管 WECHAT_SECRET）"
            : data.errcode === 40013
              ? "（AppID 无效，请检查 WECHAT_APPID）"
              : "";
    throw new AuthError(
      "WECHAT_ERROR",
      `${data.errmsg || "微信登录失败"}${hint}`,
      data.errcode,
    );
  }

  return {
    openid: data.openid,
    sessionKey: data.session_key,
    unionid: data.unionid,
  };
}

function hashCode(input: string): string {
  // Simple stable hash for mock openids (not cryptographic)
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return (
    e instanceof AuthError ||
    (typeof e === "object" &&
      e !== null &&
      (e as { name?: string }).name === "AuthError" &&
      typeof (e as { code?: unknown }).code === "string" &&
      typeof (e as { message?: unknown }).message === "string")
  );
}
