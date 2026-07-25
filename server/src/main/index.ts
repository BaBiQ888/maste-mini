import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../presentation/http/app.js";
import {
  openDatabase,
  resolveDbOptionsFromEnv,
} from "../infrastructure/persistence/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001);
const dataDir =
  process.env.DATA_DIR || path.join(__dirname, "../../data");
const sqliteFallback =
  process.env.DATABASE_PATH || path.join(dataDir, "math-mini.sqlite");

const appId = process.env.WECHAT_APPID || "";
const appSecret = process.env.WECHAT_SECRET || "";
const mock = process.env.WECHAT_MOCK === "1" || !appId || !appSecret;

const dbOpts = resolveDbOptionsFromEnv(sqliteFallback);
const codeVersion = process.env.CODE_VERSION || "dev";

// Diagnose env without printing secrets
const mysqlEnvProbe = {
  MYSQL_ADDRESS: process.env.MYSQL_ADDRESS || null,
  MYSQL_HOST: process.env.MYSQL_HOST || null,
  MYSQL_USERNAME: process.env.MYSQL_USERNAME ? "(set)" : null,
  MYSQL_USER: process.env.MYSQL_USER ? "(set)" : null,
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ? "(set)" : null,
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || null,
};
console.log(`[math-mini] codeVersion=${codeVersion}`);
console.log(`[math-mini] mysqlEnv=${JSON.stringify(mysqlEnvProbe)}`);
console.log(`[math-mini] PORT=${port} binding 0.0.0.0`);

if (dbOpts.driver !== "mysql") {
  console.warn(
    "[math-mini] WARNING: MySQL env not found — using SQLite. " +
      "Need MYSQL_ADDRESS (or MYSQL_HOST) + MYSQL_PASSWORD + MYSQL_DATABASE in the *running service* env, then rebuild & redeploy.",
  );
} else {
  console.log(
    `[math-mini] opening MySQL ${dbOpts.mysql.host}:${dbOpts.mysql.port}/${dbOpts.mysql.database} ...`,
  );
}

let db;
try {
  db = openDatabase(dbOpts);
  console.log("[math-mini] database ready");
} catch (err) {
  console.error("[math-mini] FATAL: database open failed", err);
  process.exit(1);
}

const dbLabel =
  dbOpts.driver === "mysql"
    ? `mysql://${dbOpts.mysql.host}:${dbOpts.mysql.port}/${dbOpts.mysql.database}`
    : `sqlite:${dbOpts.path}`;

const app = createApp(db, {
  wechat: { appId, appSecret, mock },
  dataDir,
  dbDriver: dbOpts.driver,
  dbLabel,
  codeVersion,
});

try {
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
  console.log(
    `[math-mini] listening on http://0.0.0.0:${port} (wechat mock=${mock}) db=${dbLabel}`,
  );
} catch (err) {
  console.error("[math-mini] FATAL: failed to bind port", port, err);
  process.exit(1);
}
