import type { AppDatabase } from "../../infrastructure/persistence/db.js";
import {
  createId,
  nowIso,
  type SessionRow,
  type UserRole,
  type UserRow,
} from "../../infrastructure/persistence/db.js";
import { AuthError, codeToSession, type WechatConfig } from "../../infrastructure/wechat/code2session.js";

const SESSION_DAYS = 30;

/** Default teacher gate code when TEACHER_ACCESS_CODE is unset (change in production). */
export const DEFAULT_TEACHER_ACCESS_CODE = "SUANBEN-TEACHER";

export interface PublicUser {
  id: string;
  role: UserRole | null;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface LoginResult {
  token: string;
  user: PublicUser;
  isNewUser: boolean;
}

export interface IdentityOptions {
  /** Shared code required the first time a user chooses role=teacher */
  teacherAccessCode?: string;
}

export class IdentityService {
  private teacherAccessCode: string;

  constructor(
    private db: AppDatabase,
    private wechat: WechatConfig,
    options?: IdentityOptions,
  ) {
    this.teacherAccessCode = (
      options?.teacherAccessCode ||
      process.env.TEACHER_ACCESS_CODE ||
      DEFAULT_TEACHER_ACCESS_CODE
    ).trim();
  }

  async loginWithWeChat(input: {
    code?: string;
    nickname?: string;
    avatarUrl?: string;
    /** Stable client id; used in mock mode so logout → re-login reuses the same user */
    deviceId?: string;
    /**
     * Preferred on WeChat Cloud Hosting: openid injected by callContainer
     * (X-WX-OPENID / X-WX-FROM-OPENID). Avoids container outbound jscode2session.
     */
    openidFromGateway?: string;
  }): Promise<LoginResult> {
    let openid: string;

    const gatewayOpenid = (input.openidFromGateway || "").trim();
    if (gatewayOpenid) {
      // Trusted only when set by cloud hosting gateway (see HTTP layer)
      openid = gatewayOpenid;
    } else {
      const code = (input.code || "").trim();
      if (!code) {
        throw new AuthError(
          "INVALID_CODE",
          "缺少登录凭证：请使用小程序 callContainer 调用，或传入 wx.login code",
        );
      }
      try {
        const session = await codeToSession(code, this.wechat, {
          deviceId: input.deviceId,
        });
        openid = session.openid;
      } catch (e) {
        // Cloud containers often cannot reach api.weixin.qq.com when open-api proxy is on/off
        if (
          e instanceof AuthError &&
          (e.code === "WECHAT_NETWORK" || e.code === "WECHAT_ERROR") &&
          input.deviceId &&
          this.wechat.mock
        ) {
          const session = await codeToSession(code, { ...this.wechat, mock: true }, {
            deviceId: input.deviceId,
          });
          openid = session.openid;
        } else if (e instanceof AuthError && e.code === "WECHAT_NETWORK") {
          throw new AuthError(
            "WECHAT_NETWORK",
            "容器无法访问微信登录接口。请用小程序 wx.cloud.callContainer 登录（网关会注入 openid），不要只用公网 HTTPS 调 /auth/wechat",
            e.detail,
          );
        } else {
          throw e;
        }
      }
    }

    const existing = await this.db.get("SELECT * FROM users WHERE openid = ?", openid) as UserRow | undefined;

    const ts = nowIso();
    let user: UserRow;
    let isNewUser = false;

    if (existing) {
      const nickname = input.nickname ?? existing.nickname;
      const avatarUrl = input.avatarUrl ?? existing.avatar_url;
      await this.db.run(`UPDATE users SET nickname = ?, avatar_url = ?, updated_at = ? WHERE id = ?`, nickname, avatarUrl, ts, existing.id);
      user = {
        ...existing,
        nickname,
        avatar_url: avatarUrl,
        updated_at: ts,
      };
    } else {
      isNewUser = true;
      const id = createId("usr");
      await this.db.run(`INSERT INTO users (id, openid, role, nickname, avatar_url, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?)`, id,
          openid,
          input.nickname ?? null,
          input.avatarUrl ?? null,
          ts,
          ts,);
      user = await this.db.get("SELECT * FROM users WHERE id = ?", id) as UserRow;
      if (!user) {
        throw new AuthError("INTERNAL", "创建用户失败，请检查数据库表 users 是否已建");
      }
    }

    const token = createId("tok");
    const expires = new Date();
    expires.setDate(expires.getDate() + SESSION_DAYS);
    try {
      await this.db.run(
        `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        token,
        user.id,
        ts,
        expires.toISOString(),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new AuthError("INTERNAL", `创建会话失败：${msg}`);
    }

    return { token, user: toPublic(user), isNewUser };
  }

  async getUserByToken(token: string | undefined | null): Promise<PublicUser | null> {
    if (!token) return null;
    const row = await this.db.get(`SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`, token, nowIso()) as UserRow | undefined;
    return row ? toPublic(row) : null;
  }

  async getUserById(id: string): Promise<PublicUser | null> {
    const row = await this.db.get("SELECT * FROM users WHERE id = ?", id) as UserRow | undefined;
    return row ? toPublic(row) : null;
  }

  async updateProfile(
    userId: string,
    patch: {
      nickname?: string;
      avatarUrl?: string;
      role?: UserRole;
      /** Required when first selecting role=teacher */
      teacherCode?: string;
    },
  ): Promise<PublicUser> {
    const current = await this.db.get("SELECT * FROM users WHERE id = ?", userId) as UserRow | undefined;
    if (!current) {
      throw new AuthError("NOT_FOUND", "用户不存在");
    }

    let role = current.role;
    if (patch.role !== undefined) {
      if (current.role && current.role !== patch.role) {
        throw new AuthError("ROLE_LOCKED", "身份已选定，不可更改");
      }
      if (patch.role !== "teacher" && patch.role !== "student") {
        throw new AuthError("INVALID_ROLE", "身份只能是 teacher 或 student");
      }

      // First-time teacher selection requires access code
      if (patch.role === "teacher" && !current.role) {
        const provided = (patch.teacherCode || "").trim();
        if (!provided) {
          throw new AuthError(
            "TEACHER_CODE_REQUIRED",
            "选择老师身份需要填写教师开通码",
          );
        }
        if (provided !== this.teacherAccessCode) {
          throw new AuthError(
            "TEACHER_CODE_INVALID",
            "教师开通码不正确",
          );
        }
      }

      role = patch.role;
    }

    const nickname =
      patch.nickname !== undefined ? patch.nickname : current.nickname;
    const avatarUrl =
      patch.avatarUrl !== undefined ? patch.avatarUrl : current.avatar_url;
    const ts = nowIso();

    await this.db.run(`UPDATE users SET role = ?, nickname = ?, avatar_url = ?, updated_at = ? WHERE id = ?`, role, nickname, avatarUrl, ts, userId);

    const __v = await this.getUserById(userId); if (!__v) throw new Error("not found"); return __v;
  }

  async logout(token: string): Promise<void> {
    await this.db.run("DELETE FROM sessions WHERE token = ?", token);
  }

  /** Test helper */
  async countUsersByOpenid(openid: string): Promise<number> {
    const row = await this.db.get("SELECT COUNT(*) AS c FROM users WHERE openid = ?", openid) as { c: number };
    return row.c;
  }

  async getSession(token: string): Promise<SessionRow | undefined> {
    return await this.db.get("SELECT * FROM sessions WHERE token = ?", token) as SessionRow | undefined;
  }
}

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    role: row.role,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  };
}

export { AuthError };
