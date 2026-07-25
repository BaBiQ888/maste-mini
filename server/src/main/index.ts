import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../presentation/http/app.js";
import { openDatabase } from "../infrastructure/persistence/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001);
// server/src/main → server/data
const dataDir =
  process.env.DATA_DIR || path.join(__dirname, "../../data");
const dbPath =
  process.env.DATABASE_PATH || path.join(dataDir, "math-mini.sqlite");

const appId = process.env.WECHAT_APPID || "";
const appSecret = process.env.WECHAT_SECRET || "";
const mock = process.env.WECHAT_MOCK === "1" || !appId || !appSecret;

const db = openDatabase(dbPath);
const app = createApp(db, {
  wechat: { appId, appSecret, mock },
  dataDir,
});

console.log(
  `[math-mini] listening on http://127.0.0.1:${port} (wechat mock=${mock}) data=${dataDir}`,
);
serve({ fetch: app.fetch, port });
