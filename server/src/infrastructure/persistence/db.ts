/**
 * Persistence layer.
 * - Local / tests: better-sqlite3 (sync)
 * - WeChat Cloud Hosting: MySQL via mysql2, exposed with a better-sqlite3-compatible sync API
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import deasync from "deasync";

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

/** better-sqlite3-compatible surface used by services. */
export type AppDb = Database.Database;

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

  /**
   * WeChat Cloud Hosting injects:
   *   MYSQL_ADDRESS=host:port  MYSQL_USERNAME  MYSQL_PASSWORD  MYSQL_DATABASE
   * Local / docs use:
   *   MYSQL_HOST  MYSQL_PORT  MYSQL_USER  MYSQL_PASSWORD  MYSQL_DATABASE
   */
  const address = process.env.MYSQL_ADDRESS || "";
  let host = process.env.MYSQL_HOST || "";
  let port = Number(process.env.MYSQL_PORT || 3306);
  if (!host && address) {
    const [h, p] = address.split(":");
    host = h || "";
    if (p) port = Number(p) || 3306;
  }

  if (host) {
    return {
      driver: "mysql",
      mysql: {
        host,
        port,
        user:
          process.env.MYSQL_USER ||
          process.env.MYSQL_USERNAME ||
          "root",
        password: process.env.MYSQL_PASSWORD || "",
        database: process.env.MYSQL_DATABASE || "math_mini",
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

function sync<T>(promise: Promise<T>): T {
  let done = false;
  let result: T | undefined;
  let error: unknown;
  promise.then(
    (r) => {
      result = r;
      done = true;
    },
    (e) => {
      error = e;
      done = true;
    },
  );
  deasync.loopWhile(() => !done);
  if (error) throw error;
  return result as T;
}

export function openDatabase(opts?: string | OpenDatabaseOptions): AppDb {
  const options: OpenDatabaseOptions =
    typeof opts === "string"
      ? { driver: "sqlite", path: opts }
      : opts ?? resolveDbOptionsFromEnv();

  if (options.driver === "mysql") {
    const db = openMysqlAsSqliteCompat(options.mysql);
    migrateMysql(db);
    return db;
  }

  return openSqlite(options.path);
}

function openSqlite(dbPath: string): AppDb {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateSqlite(db);
  return db;
}

function migrateSqlite(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  for (const sql of INDEX_SQL) {
    try {
      db.exec(sql);
    } catch {
      /* exists */
    }
  }
  const subCols = db
    .prepare(`PRAGMA table_info(submissions)`)
    .all() as Array<{ name: string }>;
  if (!subCols.some((c) => c.name === "timer_started_at")) {
    db.exec(`ALTER TABLE submissions ADD COLUMN timer_started_at TEXT`);
  }
}

// ─── MySQL with better-sqlite3-like API ─────────────────────────────────────

type Stmt = {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number };
};

function openMysqlAsSqliteCompat(cfg: MysqlConfig): AppDb {
  const pool: Pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: true,
  });

  // Fail fast
  sync(pool.query("SELECT 1"));

  let txConn: import("mysql2/promise").PoolConnection | null = null;

  const runner = () => txConn ?? pool;

  const api = {
    prepare(sql: string): Stmt {
      return {
        get(...params: unknown[]) {
          const [rows] = sync(runner().query(sql, params as never[])) as [
            RowDataPacket[],
            unknown,
          ];
          return rows[0];
        },
        all(...params: unknown[]) {
          const [rows] = sync(runner().query(sql, params as never[])) as [
            RowDataPacket[],
            unknown,
          ];
          return rows as unknown[];
        },
        run(...params: unknown[]) {
          const [result] = sync(
            runner().execute(sql, params as never[]),
          ) as [ResultSetHeader, unknown];
          return { changes: result.affectedRows ?? 0 };
        },
      };
    },
    exec(sql: string) {
      const statements = sql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("--"));
      for (const stmt of statements) {
        sync(runner().query(stmt));
      }
    },
    pragma(_s: string) {
      /* no-op for MySQL */
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        if (txConn) return fn();
        const conn = sync(pool.getConnection());
        txConn = conn;
        try {
          sync(conn.beginTransaction());
          try {
            const result = fn();
            sync(conn.commit());
            return result;
          } catch (e) {
            sync(conn.rollback());
            throw e;
          }
        } finally {
          txConn = null;
          conn.release();
        }
      };
    },
    close() {
      sync(pool.end());
    },
  };

  // Cast: services only use prepare/exec/transaction subset
  return api as unknown as AppDb;
}

function migrateMysql(db: AppDb): void {
  db.exec(SCHEMA_SQL);
  for (const sql of INDEX_SQL) {
    try {
      db.exec(sql);
    } catch {
      /* exists */
    }
  }
  try {
    const cols = db.prepare(`SHOW COLUMNS FROM submissions`).all() as Array<{
      Field: string;
    }>;
    if (!cols.some((c) => c.Field === "timer_started_at")) {
      db.exec(
        `ALTER TABLE submissions ADD COLUMN timer_started_at VARCHAR(40) NULL`,
      );
    }
  } catch {
    /* schema already includes column */
  }
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

/** Best-effort indexes (ignore if already exist / dialect differences). */
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
