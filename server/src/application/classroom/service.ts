import type { AppDatabase } from "../../infrastructure/persistence/db.js";
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
  constructor(private db: AppDatabase) {}

  async createClass(teacherId: string, input: { name: string; grade: Grade }): Promise<PublicClass> {
    await this.assertTeacher(teacherId);
    const name = input.name.trim();
    if (!name || name.length > 40) {
      throw new AppError("INVALID_NAME", "班级名称需 1–40 字");
    }
    if (![3, 4, 5, 6].includes(input.grade)) {
      throw new AppError("INVALID_GRADE", "年级只能是 3–6");
    }

    const id = createId("cls");
    const inviteCode = await this.generateUniqueCode();
    const ts = nowIso();

    await this.db.transaction(async () => {
      await this.db.run(`INSERT INTO classes (id, name, grade, teacher_id, invite_code, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`, id, name, input.grade, teacherId, inviteCode, ts, ts);

      await this.db.run(`INSERT INTO class_memberships (class_id, user_id, role, joined_at)
           VALUES (?, ?, 'teacher', ?)`, id, teacherId, ts);
    });

    const __v = await this.getClassForUser(id, teacherId); if (!__v) throw new Error("not found"); return __v;
  }

  async listClassesForUser(userId: string, opts?: { includeArchived?: boolean }): Promise<PublicClass[]> {
    const user = await this.getUserRole(userId);
    if (!user) throw new AppError("NOT_FOUND", "用户不存在", 404);

    const includeArchived = opts?.includeArchived === true;
    const rows = await this.db.all(`
        SELECT c.*
        FROM classes c
        JOIN class_memberships m ON m.class_id = c.id
        WHERE m.user_id = ?
          ${includeArchived ? "" : "AND c.archived = 0"}
        ORDER BY c.created_at DESC
        `, userId) as ClassRow[];

    if (!rows.length) return [];
    const countMap = await this.loadMemberCounts(rows.map((r) => r.id));
    return rows.map((r) =>
      this.mapToPublic(r, countMap.get(r.id) ?? { memberCount: 0, studentCount: 0 }),
    );
  }

  async getClassForUser(classId: string, userId: string): Promise<PublicClass | null> {
    const row = await this.db.get("SELECT * FROM classes WHERE id = ?", classId) as ClassRow | undefined;
    if (!row) return null;

    const member = await this.db.get(`SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ?`, classId, userId);
    if (!member) {
      throw new AppError("FORBIDDEN", "无权查看该班级", 403);
    }
    return await this.toPublic(row);
  }

  async listMembers(classId: string, requesterId: string): Promise<PublicMember[]> {
    // must be member
    await this.getClassForUser(classId, requesterId);

    const rows = await this.db.all(`
        SELECT m.user_id, m.role, m.joined_at, u.nickname, u.avatar_url
        FROM class_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.class_id = ?
        ORDER BY m.role DESC, m.joined_at ASC
        `, classId) as Array<{
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

  async joinByCode(studentId: string, inviteCode: string): Promise<PublicClass> {
    await this.assertStudent(studentId);
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      throw new AppError("INVALID_CODE", "请输入邀请码");
    }

    const row = await this.db.get(`SELECT * FROM classes WHERE invite_code = ?`, code) as ClassRow | undefined;

    if (!row) {
      throw new AppError("INVALID_CODE", "邀请码无效，请核对后重试");
    }
    if (row.archived) {
      throw new AppError("CLASS_ARCHIVED", "该班级已归档，无法加入");
    }

    const existing = await this.db.get(`SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ?`, row.id, studentId);
    if (existing) {
      return await this.toPublic(row);
    }

    await this.db.run(`INSERT INTO class_memberships (class_id, user_id, role, joined_at)
         VALUES (?, ?, 'student', ?)`, row.id, studentId, nowIso());

    return await this.toPublic(row);
  }

  /** Teacher only: ensure ownership for future ops */
  async assertOwnsClass(classId: string, teacherId: string): Promise<ClassRow> {
    const row = await this.db.get("SELECT * FROM classes WHERE id = ?", classId) as ClassRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (row.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "只能管理自己的班级", 403);
    }
    return row;
  }

  /** Refresh invite code; previous code immediately invalid. */
  async refreshInviteCode(classId: string, teacherId: string): Promise<PublicClass> {
    await this.assertOwnsClass(classId, teacherId);
    const inviteCode = await this.generateUniqueCode();
    const ts = nowIso();
    await this.db.run(`UPDATE classes SET invite_code = ?, updated_at = ? WHERE id = ?`, inviteCode, ts, classId);
    const __v = await this.getClassForUser(classId, teacherId); if (!__v) throw new Error("not found"); return __v;
  }

  /**
   * Remove a student from the class.
   * Cannot remove the owning teacher membership.
   */
  async removeMember(
    classId: string,
    teacherId: string,
    targetUserId: string,
  ): Promise<void> {
    const cls = await this.assertOwnsClass(classId, teacherId);
    if (targetUserId === cls.teacher_id) {
      throw new AppError("INVALID_MEMBER", "不能移出班级创建老师");
    }

    const membership = await this.db.get(`SELECT role FROM class_memberships WHERE class_id = ? AND user_id = ?`, classId, targetUserId) as { role: string } | undefined;

    if (!membership) {
      throw new AppError("NOT_FOUND", "该成员不在班级中", 404);
    }
    if (membership.role === "teacher") {
      throw new AppError("INVALID_MEMBER", "不能移出老师身份");
    }

    await this.db.run(`DELETE FROM class_memberships WHERE class_id = ? AND user_id = ?`, classId, targetUserId);
  }

  /** Archive class: hidden from default lists; cannot join via invite. */
  async archiveClass(classId: string, teacherId: string): Promise<PublicClass> {
    await this.assertOwnsClass(classId, teacherId);
    const ts = nowIso();
    await this.db.run(`UPDATE classes SET archived = 1, updated_at = ? WHERE id = ?`, ts, classId);

    // Owner remains member so they can still open with includeArchived
    const row = await this.db.get("SELECT * FROM classes WHERE id = ?", classId) as ClassRow;
    return await this.toPublic(row);
  }

  /** Restore archived class to active list. */
  async unarchiveClass(classId: string, teacherId: string): Promise<PublicClass> {
    await this.assertOwnsClass(classId, teacherId);
    const ts = nowIso();
    await this.db.run(`UPDATE classes SET archived = 0, updated_at = ? WHERE id = ?`, ts, classId);
    const __v = await this.getClassForUser(classId, teacherId); if (!__v) throw new Error("not found"); return __v;
  }

  private async assertTeacher(userId: string): Promise<void> {
    const role = await this.getUserRole(userId);
    if (role !== "teacher") {
      throw new AppError("FORBIDDEN", "仅老师可创建班级", 403);
    }
  }

  private async assertStudent(userId: string): Promise<void> {
    const role = await this.getUserRole(userId);
    if (role !== "student") {
      throw new AppError("FORBIDDEN", "仅学生可加入班级", 403);
    }
  }

  private async getUserRole(userId: string): Promise<string | null> {
    const row = await this.db.get("SELECT role FROM users WHERE id = ?", userId) as { role: string | null } | undefined;
    return row?.role ?? null;
  }

  private async generateUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let i = 0; i < 6; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      const exists = await this.db.get("SELECT 1 FROM classes WHERE invite_code = ?", code);
      if (!exists) return code;
    }
    throw new AppError("INTERNAL", "生成邀请码失败，请重试", 500);
  }

  /** One GROUP BY query for all class ids (avoids N+1 on list). */
  private async loadMemberCounts(
    classIds: string[],
  ): Promise<Map<string, { memberCount: number; studentCount: number }>> {
    const map = new Map<string, { memberCount: number; studentCount: number }>();
    if (!classIds.length) return map;
    const placeholders = classIds.map(() => "?").join(",");
    const rows = (await this.db.all(
      `
        SELECT
          class_id,
          COUNT(*) AS member_count,
          SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) AS student_count
        FROM class_memberships
        WHERE class_id IN (${placeholders})
        GROUP BY class_id
        `,
      ...classIds,
    )) as Array<{ class_id: string; member_count: number; student_count: number | null }>;
    for (const r of rows) {
      map.set(r.class_id, {
        memberCount: Number(r.member_count) || 0,
        studentCount: Number(r.student_count) || 0,
      });
    }
    return map;
  }

  private mapToPublic(
    row: ClassRow,
    counts: { memberCount: number; studentCount: number },
  ): PublicClass {
    return {
      id: row.id,
      name: row.name,
      grade: row.grade,
      teacherId: row.teacher_id,
      inviteCode: row.invite_code,
      archived: row.archived === 1,
      memberCount: counts.memberCount,
      studentCount: counts.studentCount,
      createdAt: row.created_at,
    };
  }

  private async toPublic(row: ClassRow): Promise<PublicClass> {
    const countMap = await this.loadMemberCounts([row.id]);
    return this.mapToPublic(
      row,
      countMap.get(row.id) ?? { memberCount: 0, studentCount: 0 },
    );
  }
}
