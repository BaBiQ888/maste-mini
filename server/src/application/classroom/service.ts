import type Database from "better-sqlite3";
import { createId, nowIso } from "../../infrastructure/persistence/db.js";
import { AppError } from "../../domain/shared/errors.js";

export type Grade = 3 | 4 | 5 | 6;

export interface ClassRow {
  id: string;
  name: string;
  grade: number;
  teacher_id: string;
  invite_code: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface PublicClass {
  id: string;
  name: string;
  grade: number;
  teacherId: string;
  inviteCode: string;
  archived: boolean;
  memberCount: number;
  studentCount: number;
  createdAt: string;
}

export interface PublicMember {
  userId: string;
  nickname: string | null;
  avatarUrl: string | null;
  role: "teacher" | "student";
  joinedAt: string;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export class ClassRoomService {
  constructor(private db: Database.Database) {}

  createClass(teacherId: string, input: { name: string; grade: Grade }): PublicClass {
    this.assertTeacher(teacherId);
    const name = input.name.trim();
    if (!name || name.length > 40) {
      throw new AppError("INVALID_NAME", "班级名称需 1–40 字");
    }
    if (![3, 4, 5, 6].includes(input.grade)) {
      throw new AppError("INVALID_GRADE", "年级只能是 3–6");
    }

    const id = createId("cls");
    const inviteCode = this.generateUniqueCode();
    const ts = nowIso();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO classes (id, name, grade, teacher_id, invite_code, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, name, input.grade, teacherId, inviteCode, ts, ts);

      this.db
        .prepare(
          `INSERT INTO class_memberships (class_id, user_id, role, joined_at)
           VALUES (?, ?, 'teacher', ?)`,
        )
        .run(id, teacherId, ts);
    });
    tx();

    return this.getClassForUser(id, teacherId)!;
  }

  listClassesForUser(userId: string, opts?: { includeArchived?: boolean }): PublicClass[] {
    const user = this.getUserRole(userId);
    if (!user) throw new AppError("NOT_FOUND", "用户不存在", 404);

    const includeArchived = opts?.includeArchived === true;
    const rows = this.db
      .prepare(
        `
        SELECT c.*
        FROM classes c
        JOIN class_memberships m ON m.class_id = c.id
        WHERE m.user_id = ?
          ${includeArchived ? "" : "AND c.archived = 0"}
        ORDER BY c.created_at DESC
        `,
      )
      .all(userId) as ClassRow[];

    return rows.map((r) => this.toPublic(r));
  }

  getClassForUser(classId: string, userId: string): PublicClass | null {
    const row = this.db
      .prepare("SELECT * FROM classes WHERE id = ?")
      .get(classId) as ClassRow | undefined;
    if (!row) return null;

    const member = this.db
      .prepare(
        `SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ?`,
      )
      .get(classId, userId);
    if (!member) {
      throw new AppError("FORBIDDEN", "无权查看该班级", 403);
    }
    return this.toPublic(row);
  }

  listMembers(classId: string, requesterId: string): PublicMember[] {
    // must be member
    this.getClassForUser(classId, requesterId);

    const rows = this.db
      .prepare(
        `
        SELECT m.user_id, m.role, m.joined_at, u.nickname, u.avatar_url
        FROM class_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.class_id = ?
        ORDER BY m.role DESC, m.joined_at ASC
        `,
      )
      .all(classId) as Array<{
      user_id: string;
      role: "teacher" | "student";
      joined_at: string;
      nickname: string | null;
      avatar_url: string | null;
    }>;

    return rows.map((r) => ({
      userId: r.user_id,
      nickname: r.nickname,
      avatarUrl: r.avatar_url,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  }

  joinByCode(studentId: string, inviteCode: string): PublicClass {
    this.assertStudent(studentId);
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      throw new AppError("INVALID_CODE", "请输入邀请码");
    }

    const row = this.db
      .prepare(`SELECT * FROM classes WHERE invite_code = ?`)
      .get(code) as ClassRow | undefined;

    if (!row) {
      throw new AppError("INVALID_CODE", "邀请码无效，请核对后重试");
    }
    if (row.archived) {
      throw new AppError("CLASS_ARCHIVED", "该班级已归档，无法加入");
    }

    const existing = this.db
      .prepare(
        `SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ?`,
      )
      .get(row.id, studentId);
    if (existing) {
      return this.toPublic(row);
    }

    this.db
      .prepare(
        `INSERT INTO class_memberships (class_id, user_id, role, joined_at)
         VALUES (?, ?, 'student', ?)`,
      )
      .run(row.id, studentId, nowIso());

    return this.toPublic(row);
  }

  /** Teacher only: ensure ownership for future ops */
  assertOwnsClass(classId: string, teacherId: string): ClassRow {
    const row = this.db
      .prepare("SELECT * FROM classes WHERE id = ?")
      .get(classId) as ClassRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (row.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "只能管理自己的班级", 403);
    }
    return row;
  }

  /** Refresh invite code; previous code immediately invalid. */
  refreshInviteCode(classId: string, teacherId: string): PublicClass {
    this.assertOwnsClass(classId, teacherId);
    const inviteCode = this.generateUniqueCode();
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE classes SET invite_code = ?, updated_at = ? WHERE id = ?`,
      )
      .run(inviteCode, ts, classId);
    return this.getClassForUser(classId, teacherId)!;
  }

  /**
   * Remove a student from the class.
   * Cannot remove the owning teacher membership.
   */
  removeMember(
    classId: string,
    teacherId: string,
    targetUserId: string,
  ): void {
    const cls = this.assertOwnsClass(classId, teacherId);
    if (targetUserId === cls.teacher_id) {
      throw new AppError("INVALID_MEMBER", "不能移出班级创建老师");
    }

    const membership = this.db
      .prepare(
        `SELECT role FROM class_memberships WHERE class_id = ? AND user_id = ?`,
      )
      .get(classId, targetUserId) as { role: string } | undefined;

    if (!membership) {
      throw new AppError("NOT_FOUND", "该成员不在班级中", 404);
    }
    if (membership.role === "teacher") {
      throw new AppError("INVALID_MEMBER", "不能移出老师身份");
    }

    this.db
      .prepare(
        `DELETE FROM class_memberships WHERE class_id = ? AND user_id = ?`,
      )
      .run(classId, targetUserId);
  }

  /** Archive class: hidden from default lists; cannot join via invite. */
  archiveClass(classId: string, teacherId: string): PublicClass {
    this.assertOwnsClass(classId, teacherId);
    const ts = nowIso();
    this.db
      .prepare(`UPDATE classes SET archived = 1, updated_at = ? WHERE id = ?`)
      .run(ts, classId);

    // Owner remains member so they can still open with includeArchived
    const row = this.db
      .prepare("SELECT * FROM classes WHERE id = ?")
      .get(classId) as ClassRow;
    return this.toPublic(row);
  }

  /** Restore archived class to active list. */
  unarchiveClass(classId: string, teacherId: string): PublicClass {
    this.assertOwnsClass(classId, teacherId);
    const ts = nowIso();
    this.db
      .prepare(`UPDATE classes SET archived = 0, updated_at = ? WHERE id = ?`)
      .run(ts, classId);
    return this.getClassForUser(classId, teacherId)!;
  }

  private assertTeacher(userId: string): void {
    const role = this.getUserRole(userId);
    if (role !== "teacher") {
      throw new AppError("FORBIDDEN", "仅老师可创建班级", 403);
    }
  }

  private assertStudent(userId: string): void {
    const role = this.getUserRole(userId);
    if (role !== "student") {
      throw new AppError("FORBIDDEN", "仅学生可加入班级", 403);
    }
  }

  private getUserRole(userId: string): string | null {
    const row = this.db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(userId) as { role: string | null } | undefined;
    return row?.role ?? null;
  }

  private generateUniqueCode(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let i = 0; i < 6; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      const exists = this.db
        .prepare("SELECT 1 FROM classes WHERE invite_code = ?")
        .get(code);
      if (!exists) return code;
    }
    throw new AppError("INTERNAL", "生成邀请码失败，请重试", 500);
  }

  private toPublic(row: ClassRow): PublicClass {
    const counts = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS member_count,
          SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) AS student_count
        FROM class_memberships
        WHERE class_id = ?
        `,
      )
      .get(row.id) as { member_count: number; student_count: number };

    return {
      id: row.id,
      name: row.name,
      grade: row.grade,
      teacherId: row.teacher_id,
      inviteCode: row.invite_code,
      archived: row.archived === 1,
      memberCount: counts.member_count,
      studentCount: counts.student_count ?? 0,
      createdAt: row.created_at,
    };
  }
}
