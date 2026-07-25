import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

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

export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      openid TEXT NOT NULL UNIQUE,
      role TEXT CHECK (role IS NULL OR role IN ('teacher', 'student')),
      nickname TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      grade INTEGER NOT NULL CHECK (grade BETWEEN 3 AND 6),
      teacher_id TEXT NOT NULL REFERENCES users(id),
      invite_code TEXT NOT NULL UNIQUE,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_classes_invite ON classes(invite_code);

    CREATE TABLE IF NOT EXISTS class_memberships (
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (class_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_memberships_user ON class_memberships(user_id);

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id),
      type TEXT NOT NULL CHECK (type IN ('daily_drill', 'knowledge_checkin', 'photo_homework')),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'revoked')),
      due_at TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL,
      overdue INTEGER NOT NULL DEFAULT 0,
      score REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      timer_started_at TEXT,
      UNIQUE (assignment_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);

    CREATE TABLE IF NOT EXISTS photo_assets (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photo_grades (
      submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
      result TEXT NOT NULL CHECK (result IN ('correct', 'partial', 'incorrect')),
      score REAL,
      comment TEXT,
      require_resubmit INTEGER NOT NULL DEFAULT 0,
      graded_by TEXT NOT NULL REFERENCES users(id),
      graded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK (type IN ('fill_blank', 'choice', 'true_false')),
      stem TEXT NOT NULL,
      options_json TEXT,
      answer_json TEXT NOT NULL,
      explanation TEXT,
      knowledge_node_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_questions_creator ON questions(created_by);
    CREATE INDEX IF NOT EXISTS idx_questions_knowledge ON questions(knowledge_node_id);

    CREATE TABLE IF NOT EXISTS assignment_questions (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      source_question_id TEXT,
      question_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_asg_questions ON assignment_questions(assignment_id);

    CREATE TABLE IF NOT EXISTS answer_items (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      assignment_question_id TEXT NOT NULL,
      response_json TEXT,
      is_correct INTEGER,
      correction_round INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE (submission_id, assignment_question_id)
    );

    CREATE INDEX IF NOT EXISTS idx_answer_items_sub ON answer_items(submission_id);
  `);

  // Additive migrations for existing databases
  const subCols = db
    .prepare(`PRAGMA table_info(submissions)`)
    .all() as Array<{ name: string }>;
  if (!subCols.some((c) => c.name === "timer_started_at")) {
    db.exec(`ALTER TABLE submissions ADD COLUMN timer_started_at TEXT`);
  }
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
