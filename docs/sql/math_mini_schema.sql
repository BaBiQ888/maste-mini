-- 算本 math_mini 表结构（微信云托管 MySQL）
-- 在控制台选择库 math_mini 后整段执行

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
  wrong_reason VARCHAR(32),
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE (submission_id, assignment_question_id)
);

CREATE TABLE IF NOT EXISTS mastery_items (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  class_id VARCHAR(64),
  knowledge_node_id VARCHAR(64),
  skill_key VARCHAR(128),
  status VARCHAR(32) NOT NULL,
  miss_count INT NOT NULL DEFAULT 0,
  pass_count INT NOT NULL DEFAULT 0,
  review_at VARCHAR(40) NOT NULL,
  last_result_at VARCHAR(40),
  last_wrong_reason VARCHAR(32),
  source_assignment_id VARCHAR(64),
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL
);

CREATE TABLE IF NOT EXISTS mastery_reviews (
  id VARCHAR(64) PRIMARY KEY,
  mastery_item_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  source VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  question_snapshots_json MEDIUMTEXT NOT NULL,
  answers_json TEXT,
  correct_count INT,
  total_count INT NOT NULL,
  passed INT,
  started_at VARCHAR(40) NOT NULL,
  completed_at VARCHAR(40)
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_classes_teacher ON classes(teacher_id);
-- invite_code already UNIQUE
CREATE INDEX idx_memberships_user ON class_memberships(user_id);
CREATE INDEX idx_assignments_class ON assignments(class_id);
CREATE INDEX idx_assignments_class_created ON assignments(class_id, created_at);
CREATE INDEX idx_assignments_status ON assignments(status);
CREATE INDEX idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX idx_submissions_student ON submissions(student_id);
CREATE INDEX idx_submissions_asg_status ON submissions(assignment_id, status);
CREATE INDEX idx_submissions_student_updated ON submissions(student_id, updated_at);
CREATE INDEX idx_questions_creator ON questions(created_by);
CREATE INDEX idx_questions_creator_updated ON questions(created_by, updated_at);
CREATE INDEX idx_questions_knowledge ON questions(knowledge_node_id);
CREATE INDEX idx_asg_questions ON assignment_questions(assignment_id);
CREATE INDEX idx_photo_assets_sub ON photo_assets(submission_id, sort_order);
CREATE INDEX idx_answer_items_sub ON answer_items(submission_id);
CREATE INDEX idx_answer_items_aq ON answer_items(assignment_question_id, is_correct);
CREATE INDEX idx_mastery_user_status ON mastery_items(user_id, status);
CREATE INDEX idx_mastery_user_review ON mastery_items(user_id, review_at);
-- Unique per user+knowledge / user+skill. MySQL/SQLite: NULL is distinct in UNIQUE.
CREATE UNIQUE INDEX idx_mastery_user_kn_uq ON mastery_items(user_id, knowledge_node_id);
CREATE UNIQUE INDEX idx_mastery_user_sk_uq ON mastery_items(user_id, skill_key);
CREATE INDEX idx_mastery_reviews_user ON mastery_reviews(user_id, status);
CREATE INDEX idx_mastery_reviews_item ON mastery_reviews(mastery_item_id);
