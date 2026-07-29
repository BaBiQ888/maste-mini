/**
 * Cloud-safe boot order:
 * 1) Bind :PORT immediately so readiness probes pass
 * 2) Open DB (MySQL/SQLite) in background
 * 3) Swap in full Hono app when ready
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../presentation/http/app.js";
import {
  openDatabase,
  purgeExpiredSessions,
  resolveDbOptionsFromEnv,
  type OpenDatabaseOptions,
  type AppDatabase,
} from "../infrastructure/persistence/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001) || 80;
const dataDir =
  process.env.DATA_DIR || path.join(__dirname, "../../data");
const sqliteFallback =
  process.env.DATABASE_PATH || path.join(dataDir, "math-mini.sqlite");

const appId = (
  process.env.WECHAT_APPID ||
  process.env.WX_APPID ||
  ""
).trim();
const appSecret = (
  process.env.WECHAT_SECRET ||
  process.env.WECHAT_APPSECRET ||
  process.env.WX_SECRET ||
  ""
).trim();
/** Force mock only when WECHAT_MOCK=1; otherwise real login if AppId+Secret present */
const mock = process.env.WECHAT_MOCK === "1" || !appId || !appSecret;
const codeVersion = process.env.CODE_VERSION || "dev";

const dbOpts = resolveDbOptionsFromEnv(sqliteFallback);

const mysqlEnvProbe = {
  MYSQL_ADDRESS: process.env.MYSQL_ADDRESS || null,
  MYSQL_HOST: process.env.MYSQL_HOST || null,
  MYSQL_USERNAME: process.env.MYSQL_USERNAME ? "(set)" : null,
  MYSQL_USER: process.env.MYSQL_USER ? "(set)" : null,
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ? "(set)" : null,
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || null,
};

type BootState = {
  phase: "listening" | "connecting_db" | "ready" | "db_error";
  dbDriver: "sqlite" | "mysql" | "unknown";
  dbLabel: string;
  dbError: string | null;
};

const boot: BootState = {
  phase: "listening",
  dbDriver: "unknown",
  dbLabel: "",
  dbError: null,
};

function healthPayload() {
  return {
    /** Process is up (liveness). Use `ready` for full app readiness. */
    ok: true,
    ready: boot.phase === "ready",
    service: "math-mini",
    codeVersion,
    phase: boot.phase,
    dbDriver: boot.dbDriver,
    dbLabel: boot.dbLabel,
    dbError: boot.dbError,
    /** Real login reuses account by WeChat openid when mock=false */
    wechat: {
      appIdConfigured: Boolean(appId),
      secretConfigured: Boolean(appSecret),
      mock,
      mode: mock ? "mock" : "real",
    },
    mysqlEnv: {
      MYSQL_ADDRESS: Boolean(process.env.MYSQL_ADDRESS),
      MYSQL_HOST: Boolean(process.env.MYSQL_HOST),
      MYSQL_USERNAME: Boolean(process.env.MYSQL_USERNAME),
      MYSQL_USER: Boolean(process.env.MYSQL_USER),
      MYSQL_PASSWORD: Boolean(process.env.MYSQL_PASSWORD),
      MYSQL_DATABASE: process.env.MYSQL_DATABASE || null,
    },
  };
}

/** Placeholder app until real routes are mounted */
const bootstrap = new Hono();
bootstrap.get("/health", (c) => c.json(healthPayload()));
bootstrap.get("/", (c) => c.json(healthPayload()));
bootstrap.all("*", (c) =>
  c.json(
    {
      code: boot.phase === "db_error" ? "DB_ERROR" : "STARTING",
      message:
        boot.phase === "db_error"
          ? boot.dbError || "数据库初始化失败"
          : "服务启动中，请稍后重试",
      ...healthPayload(),
    },
    boot.phase === "db_error" ? 503 : 503,
  ),
);

// Mutable fetch target — probes hit this from the first millisecond
type AppFetch = (req: Request) => Response | Promise<Response>;
let activeFetch: AppFetch = (req) => bootstrap.fetch(req);

console.log(`[math-mini] codeVersion=${codeVersion}`);
console.log(`[math-mini] mysqlEnv=${JSON.stringify(mysqlEnvProbe)}`);
console.log(`[math-mini] PORT=${port} binding 0.0.0.0 (before DB)`);

try {
  serve({
    fetch: (req: Request) => activeFetch(req),
    port,
    hostname: "0.0.0.0",
  });
  console.log(
    `[math-mini] listening on http://0.0.0.0:${port} (probes can pass; DB still loading)`,
  );
} catch (err) {
  console.error("[math-mini] FATAL: failed to bind port", port, err);
  process.exit(1);
}

function dbLabelOf(opts: OpenDatabaseOptions): string {
  if (opts.driver === "mysql") {
    return `mysql://${opts.mysql.host}:${opts.mysql.port}/${opts.mysql.database}`;
  }
  return `sqlite:${opts.path}`;
}

/** Open DB after listen so readiness probes succeed */
async function bootDatabase(): Promise<void> {
  boot.phase = "connecting_db";
  boot.dbDriver = dbOpts.driver;
  boot.dbLabel = dbLabelOf(dbOpts);

  if (dbOpts.driver !== "mysql") {
    console.warn(
      "[math-mini] WARNING: MySQL env not found — using SQLite. " +
        "Set MYSQL_ADDRESS + MYSQL_USERNAME + MYSQL_PASSWORD + MYSQL_DATABASE.",
    );
  } else {
    console.log(
      `[math-mini] opening MySQL ${dbOpts.mysql.host}:${dbOpts.mysql.port}/${dbOpts.mysql.database} ...`,
    );
  }

  try {
    const db = await openDatabase(dbOpts);
    console.log("[math-mini] database ready");

    const teacherAccessCode =
      process.env.TEACHER_ACCESS_CODE || undefined;

    const app = createApp(db, {
      wechat: { appId, appSecret, mock },
      dataDir,
      dbDriver: dbOpts.driver,
      dbLabel: boot.dbLabel,
      codeVersion,
      teacherAccessCode,
    });

    activeFetch = (req) => app.fetch(req);
    boot.phase = "ready";
    boot.dbError = null;
    scheduleSessionPurge(db);
    console.log(
      `[math-mini] full app ready (wechat mock=${mock}) db=${boot.dbLabel}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    boot.phase = "db_error";
    boot.dbError = msg;
    console.error("[math-mini] database open failed:", msg);
    if (stack) console.error(stack);
    // Keep process alive + /health on :80 so deploy probes pass; fix DB and redeploy
  }
}

// Defer DB init so the event loop can accept probe connections first
setImmediate(() => {
  bootDatabase().catch((err) => {
    console.error("[math-mini] unexpected boot error", err);
    boot.phase = "db_error";
    boot.dbError = err instanceof Error ? err.message : String(err);
  });
});

/** Purge expired sessions every 6h (also runs once inside openDatabase). */
function scheduleSessionPurge(db: AppDatabase): void {
  const SIX_H = 6 * 60 * 60 * 1000;
  setInterval(() => {
    purgeExpiredSessions(db).catch((err) => {
      console.warn("[math-mini] scheduled session purge failed:", err);
    });
  }, SIX_H).unref?.();
}
