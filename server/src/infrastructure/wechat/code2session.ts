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

  if (config.mock || !config.appId || !config.appSecret) {
    const seed =
      options?.deviceId && options.deviceId.trim()
        ? `device:${options.deviceId.trim()}`
        : `code:${code.trim()}`;
    const openid = `mock_${hashCode(seed)}`;
    return { openid, sessionKey: "mock_session_key" };
  }

  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", config.appId);
  url.searchParams.set("secret", config.appSecret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  const res = await fetch(url);
  const data = (await res.json()) as {
    openid?: string;
    session_key?: string;
    unionid?: string;
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode || !data.openid) {
    throw new AuthError(
      "WECHAT_ERROR",
      data.errmsg || "微信登录失败",
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
