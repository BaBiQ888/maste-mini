/**
 * Persistence: SQLite (local/tests) + MySQL (WeChat Cloud).
 * All query APIs are async — never use deasync (blocks event loop → MySQL hangs).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import mysql from "mysql2/promise";
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from "mysql2/promise";

/**
 * Per-async-context MySQL connection for transactions.
 * Module-level stack was shared across concurrent requests and could
 * route queries onto the wrong connection under load.
 */
const mysqlTxAls = new AsyncLocalStorage<PoolConnection>();

export type UserRole = "teacher" | "student";

export interface UserRow {
  id: string;
  openid: string;
  role: UserRole | null;
  nickname: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface AppDatabase {
  get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined>;
  all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type MysqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export type OpenDatabaseOptions =
  | { driver: "sqlite"; path: string }
  | { driver: "mysql"; mysql: MysqlConfig };

export function resolveDbOptionsFromEnv(
  fallbackSqlitePath?: string,
): OpenDatabaseOptions {
  const url = process.env.DATABASE_URL;
  if (url?.startsWith("mysql")) {
    const u = new URL(url);
    return {
      driver: "mysql",
      mysql: {
        host: u.hostname,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.replace(/^\//, "") || "math_mini",
      },
    };
  }

  const address = (process.env.MYSQL_ADDRESS || "").trim();
  let host = (process.env.MYSQL_HOST || "").trim();
  let port = Number((process.env.MYSQL_PORT || "3306").trim() || 3306);
  if (!host && address) {
    const idx = address.lastIndexOf(":");
    if (idx > 0 && /^\d+$/.test(address.slice(idx + 1))) {
      host = address.slice(0, idx).trim();
      port = Number(address.slice(idx + 1)) || 3306;
    } else {
      host = address;
    }
  }

  if (host) {
    return {
      driver: "mysql",
      mysql: {
        host,
        port,
        user: (
          process.env.MYSQL_USER ||
          process.env.MYSQL_USERNAME ||
          "root"
        ).trim(),
        password: (process.env.MYSQL_PASSWORD || "").trim(),
        database: (process.env.MYSQL_DATABASE || "math_mini").trim(),
      },
    };
  }

  return {
    driver: "sqlite",
    path:
      fallbackSqlitePath ||
      process.env.DATABASE_PATH ||
      path.join(process.cwd(), "data", "math-mini.sqlite"),
  };
}

export async function openDatabase(
  opts?: string | OpenDatabaseOptions,
): Promise<AppDatabase> {
  const options: OpenDatabaseOptions =
    typeof opts === "string"
      ? { driver: "sqlite", path: opts }
      : opts ?? resolveDbOptionsFromEnv();

  if (options.driver === "mysql") {
    const { db, pool } = await openMysqlDatabase(options.mysql);
    await migrateMysql(db, pool);
    return db;
  }

  const db = openSqliteDatabase(options.path);
  await migrateSqlite(db);
  return db;
}

// ─── SQLite ─────────────────────────────────────────────────────────────────

function openSqliteDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");

  return {
    async get<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, ...params: unknown[]) {
      const info = raw.prepare(sql).run(...params);
      return { changes: info.changes };
    },
    async exec(sql: string) {
      raw.exec(sql);
    },
    async transaction<T>(fn: () => Promise<T>) {
      raw.exec("BEGIN");
      try {
        const result = await fn();
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    async close() {
      raw.close();
    },
  };
}

async function migrateSqlite(db: AppDatabase): Promise<void> {
  await db.exec(SCHEMA_SQL);
  for (const sql of INDEX_SQL) {
    try {
      await db.exec(sql);
    } catch {
      /* exists */
    }
  }
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(submissions)`);
  if (!cols.some((c) => c.name === "timer_started_at")) {
    await db.exec(`ALTER TABLE submissions ADD COLUMN timer_started_at TEXT`);
  }
}

// ─── MySQL (async only) ─────────────────────────────────────────────────────

/** Network / idle-drop errors common on cloud MySQL — safe to retry. */
function isTransientMysqlError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string };
  const code = e?.code || "";
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR" ||
    code === "PROTOCOL_ENQUEUE_AFTER_QUIT" ||
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT"
  ) {
    return true;
  }
  const msg = String(e?.message || "");
  return /ECONNRESET|Connection lost|server has gone away/i.test(msg);
}

/** Idempotent DDL: index/table already exists — not an error. */
function isIgnorableSchemaError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  const code = e?.code || "";
  // 1061 ER_DUP_KEYNAME, 1050 ER_TABLE_EXISTS_ERROR, 1062 duplicate entry (rare on DDL)
  return (
    code === "ER_DUP_KEYNAME" ||
    code === "ER_TABLE_EXISTS_ERROR" ||
    e?.errno === 1061 ||
    e?.errno === 1050
  );
}

async function withMysqlRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (isIgnorableSchemaError(err)) {
        // CREATE INDEX already exists, etc.
        throw err;
      }
      const code = (err as { code?: string })?.code || "ERR";
      if (!isTransientMysqlError(err) || i === attempts - 1) {
        console.error(`[math-mini] mysql ${label} failed (${code}):`, err);
        throw err;
      }
      const delay = 80 * (i + 1) * (i + 1);
      console.warn(
        `[math-mini] mysql ${label} ${code}, retry ${i + 1}/${attempts - 1} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

async function openMysqlDatabase(
  cfg: MysqlConfig,
): Promise<{ db: AppDatabase; pool: Pool }> {
  console.log(
    `[math-mini] mysql pool → ${cfg.host}:${cfg.port}/${cfg.database} user=${cfg.user}`,
  );
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 30_000,
    queueLimit: 0,
    connectTimeout: 15_000,
    decimalNumbers: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 5_000,
  });

  try {
    await withMysqlRetry("bootstrap SELECT 1", async () => {
      const [rows] = await pool.query("SELECT 1 AS ok");
      console.log("[math-mini] mysql SELECT 1 ok", rows);
    });
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }

  return { db: createMysqlAppDatabase(pool), pool };
}

function createMysqlAppDatabase(pool: Pool): AppDatabase {
  const runner = () => mysqlTxAls.getStore() ?? pool;

  return {
    async get<T>(sql: string, ...params: unknown[]) {
      return withMysqlRetry("get", async () => {
        const [rows] = await runner().query(sql, params as never[]);
        const list = rows as RowDataPacket[];
        return (list[0] as T) ?? undefined;
      });
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return withMysqlRetry("all", async () => {
        const [rows] = await runner().query(sql, params as never[]);
        return rows as T[];
      });
    },
    async run(sql: string, ...params: unknown[]) {
      return withMysqlRetry("run", async () => {
        const [result] = await runner().execute(sql, params as never[]);
        const header = result as ResultSetHeader;
        return { changes: header.affectedRows ?? 0 };
      });
    },
    async exec(sql: string) {
      return withMysqlRetry("exec", async () => {
        const r = runner();
        const statements = sql
          .split(/;\s*\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !s.startsWith("--"));
        for (const stmt of statements) {
          await r.query(stmt);
        }
      });
    },
    async transaction<T>(fn: () => Promise<T>) {
      // Nested: reuse the same connection bound to this async context
      if (mysqlTxAls.getStore()) return fn();
      return withMysqlRetry("transaction", async () => {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          try {
            const result = await mysqlTxAls.run(connection, fn);
            await connection.commit();
            return result;
          } catch (e) {
            try {
              await connection.rollback();
            } catch {
              /* ignore rollback errors on dead connection */
            }
            throw e;
          }
        } finally {
          connection.release();
        }
      });
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Run one DDL statement; skip quietly if object already exists.
 * Avoids withMysqlRetry error spam for ER_DUP_KEYNAME.
 */
async function execSchemaStatement(
  pool: Pool,
  sql: string,
): Promise<void> {
  try {
    await pool.query(sql);
  } catch (err) {
    if (isIgnorableSchemaError(err)) {
      return;
    }
    throw err;
  }
}

async function migrateMysql(db: AppDatabase, pool?: Pool): Promise<void> {
  // Tables (IF NOT EXISTS)
  await db.exec(SCHEMA_SQL);

  // Indexes: may already exist from manual SQL or prior boots — skip duplicates
  const indexRunner = pool
    ? (sql: string) => execSchemaStatement(pool, sql)
    : async (sql: string) => {
        try {
          await db.exec(sql);
        } catch (err) {
          if (isIgnorableSchemaError(err)) return;
          throw err;
        }
      };

  for (const sql of INDEX_SQL) {
    await indexRunner(sql);
  }

  try {
    const cols = await db.all<{ Field: string }>(
      `SHOW COLUMNS FROM submissions`,
    );
    if (!cols.some((c) => c.Field === "timer_started_at")) {
      await db.exec(
        `ALTER TABLE submissions ADD COLUMN timer_started_at VARCHAR(40) NULL`,
      );
    }
  } catch {
    /* ok */
  }
  console.log("[math-mini] mysql schema migrate done (indexes skipped if exist)");
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      openid VARCHAR(128) NOT NULL UNIQUE,
      role VARCHAR(32),
      nickname VARCHAR(128),
      avatar_url TEXT,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      expires_at VARCHAR(40) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS classes (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      grade INT NOT NULL,
      teacher_id VARCHAR(64) NOT NULL,
      invite_code VARCHAR(16) NOT NULL UNIQUE,
      archived INT NOT NULL DEFAULT 0,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS class_memberships (
      class_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      role VARCHAR(32) NOT NULL,
      joined_at VARCHAR(40) NOT NULL,
      PRIMARY KEY (class_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id VARCHAR(64) PRIMARY KEY,
      class_id VARCHAR(64) NOT NULL,
      type VARCHAR(32) NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      status VARCHAR(32) NOT NULL,
      due_at VARCHAR(40),
      config_json TEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      published_at VARCHAR(40)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id VARCHAR(64) PRIMARY KEY,
      assignment_id VARCHAR(64) NOT NULL,
      student_id VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL,
      overdue INT NOT NULL DEFAULT 0,
      score DOUBLE,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      submitted_at VARCHAR(40),
      timer_started_at VARCHAR(40),
      UNIQUE (assignment_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS photo_assets (
      id VARCHAR(64) PRIMARY KEY,
      submission_id VARCHAR(64) NOT NULL,
      url TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at VARCHAR(40) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photo_grades (
      submission_id VARCHAR(64) PRIMARY KEY,
      result VARCHAR(32) NOT NULL,
      score DOUBLE,
      comment TEXT,
      require_resubmit INT NOT NULL DEFAULT 0,
      graded_by VARCHAR(64) NOT NULL,
      graded_at VARCHAR(40) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      id VARCHAR(64) PRIMARY KEY,
      created_by VARCHAR(64) NOT NULL,
      type VARCHAR(32) NOT NULL,
      stem TEXT NOT NULL,
      options_json TEXT,
      answer_json TEXT NOT NULL,
      explanation TEXT,
      knowledge_node_id VARCHAR(64),
      source VARCHAR(32) NOT NULL DEFAULT 'manual',
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assignment_questions (
      id VARCHAR(64) PRIMARY KEY,
      assignment_id VARCHAR(64) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      source_question_id VARCHAR(64),
      question_snapshot MEDIUMTEXT NOT NULL,
      created_at VARCHAR(40) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS answer_items (
      id VARCHAR(64) PRIMARY KEY,
      submission_id VARCHAR(64) NOT NULL,
      assignment_question_id VARCHAR(64) NOT NULL,
      response_json TEXT,
      is_correct INT,
      correction_round INT NOT NULL DEFAULT 0,
      updated_at VARCHAR(40) NOT NULL,
      UNIQUE (submission_id, assignment_question_id)
    );
`;

const INDEX_SQL = [
  "CREATE INDEX idx_sessions_user ON sessions(user_id)",
  "CREATE INDEX idx_classes_teacher ON classes(teacher_id)",
  "CREATE INDEX idx_classes_invite ON classes(invite_code)",
  "CREATE INDEX idx_memberships_user ON class_memberships(user_id)",
  "CREATE INDEX idx_assignments_class ON assignments(class_id)",
  "CREATE INDEX idx_assignments_status ON assignments(status)",
  "CREATE INDEX idx_submissions_assignment ON submissions(assignment_id)",
  "CREATE INDEX idx_submissions_student ON submissions(student_id)",
  "CREATE INDEX idx_questions_creator ON questions(created_by)",
  "CREATE INDEX idx_questions_knowledge ON questions(knowledge_node_id)",
  "CREATE INDEX idx_asg_questions ON assignment_questions(assignment_id)",
  "CREATE INDEX idx_answer_items_sub ON answer_items(submission_id)",
];

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
