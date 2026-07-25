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

if (dbOpts.driver !== "mysql") {
  console.warn(
    "[math-mini] WARNING: MYSQL_HOST not set — using SQLite inside container. " +
      "Cloud MySQL tables will stay empty. Set MYSQL_HOST/MYSQL_DATABASE=math_mini etc.",
  );
}

const db = openDatabase(dbOpts);
const app = createApp(db, {
  wechat: { appId, appSecret, mock },
  dataDir,
});

const dbLabel =
  dbOpts.driver === "mysql"
    ? `mysql://${dbOpts.mysql.host}:${dbOpts.mysql.port}/${dbOpts.mysql.database}`
    : `sqlite:${dbOpts.path}`;

console.log(
  `[math-mini] listening on http://0.0.0.0:${port} (wechat mock=${mock}) db=${dbLabel}`,
);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
