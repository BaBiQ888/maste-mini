import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AppDatabase } from "../../infrastructure/persistence/db.js";
import path from "node:path";
import {
  AuthError,
  IdentityService,
  type PublicUser,
} from "../../application/identity/service.js";
import type { WechatConfig } from "../../infrastructure/wechat/code2session.js";
import { ClassRoomService } from "../../application/classroom/service.js";
import { AssignmentService } from "../../application/assignment/service.js";
import { ProgressService } from "../../application/progress/service.js";
import { QuestionBankService } from "../../application/questionbank/service.js";
import {
  generateDrillQuestions,
  listOperations,
} from "../../domain/drill/generator.js";
import { KnowledgeTreeService } from "../../application/knowledge/service.js";
import {
  ensureUploadDir,
  saveBase64Image,
} from "../../infrastructure/storage/upload-store.js";
import { AppError } from "../../domain/shared/errors.js";
import { z } from "zod";

export type AppEnv = {
  Variables: {
    user: PublicUser;
    token: string;
  };
};

export interface AppOptions {
  wechat: WechatConfig;
  /** Absolute path to server data dir (sqlite parent / uploads) */
  dataDir: string;
  /** Runtime diagnostics for /health */
  dbDriver?: "sqlite" | "mysql";
  dbLabel?: string;
  codeVersion?: string;
  /** Shared code required the first time a user chooses role=teacher */
  teacherAccessCode?: string;
}

export function createApp(
  db: AppDatabase,
  options: AppOptions | WechatConfig,
) {
  const wechat: WechatConfig =
    "wechat" in options ? options.wechat : (options as WechatConfig);
  const dataDir =
    "dataDir" in options && options.dataDir
      ? options.dataDir
      : path.join(process.cwd(), "data");
  const dbDriver =
    "dbDriver" in options && options.dbDriver ? options.dbDriver : "sqlite";
  const dbLabel =
    "dbLabel" in options && options.dbLabel ? options.dbLabel : "";
  const codeVersion =
    "codeVersion" in options && options.codeVersion
      ? options.codeVersion
      : process.env.CODE_VERSION || "unknown";
  const teacherAccessCode =
    "teacherAccessCode" in options && options.teacherAccessCode
      ? options.teacherAccessCode
      : undefined;

  const identity = new IdentityService(db, wechat, { teacherAccessCode });
  const classroom = new ClassRoomService(db);
  const questionBank = new QuestionBankService(db);
  const assignments = new AssignmentService(db, questionBank);
  const progress = new ProgressService(db);
  const knowledge = new KnowledgeTreeService();
  const uploadDir = ensureUploadDir(dataDir);

  const app = new Hono<AppEnv>();

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "math-mini",
      codeVersion,
      dbDriver,
      dbLabel,
      /** Presence only — never expose secrets */
      mysqlEnv: {
        MYSQL_ADDRESS: Boolean(process.env.MYSQL_ADDRESS),
        MYSQL_HOST: Boolean(process.env.MYSQL_HOST),
        MYSQL_USERNAME: Boolean(process.env.MYSQL_USERNAME),
        MYSQL_USER: Boolean(process.env.MYSQL_USER),
        MYSQL_PASSWORD: Boolean(process.env.MYSQL_PASSWORD),
        MYSQL_DATABASE: process.env.MYSQL_DATABASE || null,
      },
    }),
  );

  app.use(
    "/uploads/*",
    serveStatic({
      root: dataDir,
      rewriteRequestPath: (p) => p.replace(/^\/uploads/, "/uploads"),
    }),
  );

  app.post("/api/v1/auth/wechat", async (c) => {
    try {
      const body = loginBody.parse(await c.req.json());
      const result = await identity.loginWithWeChat(body);
      return c.json(result);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/api/v1/auth/logout", async (c) => {
    const token = bearer(c.req.header("Authorization"));
    if (token) await identity.logout(token);
    return c.json({ ok: true });
  });

  const authed = new Hono<AppEnv>();
  authed.use("*", async (c, next) => {
    const token = bearer(c.req.header("Authorization"));
    const user = await identity.getUserByToken(token);
    if (!user || !token) {
      return c.json(
        { code: "UNAUTHORIZED", message: "未登录或会话已过期" },
        401,
      );
    }
    c.set("user", user);
    c.set("token", token);
    await next();
  });

  authed.get("/me", (c) => c.json({ user: c.get("user") }));

  authed.patch("/me", async (c) => {
    try {
      const body = patchBody.parse(await c.req.json());
      const user = await identity.updateProfile(c.get("user").id, {
        nickname: body.nickname,
        avatarUrl: body.avatarUrl ?? undefined,
        role: body.role,
        teacherCode: body.teacherCode,
      });
      return c.json({ user });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // —— ClassRoom ——
  authed.post("/classes", async (c) => {
    try {
      const body = createClassBody.parse(await c.req.json());
      const cls = await classroom.createClass(c.get("user").id, body);
      return c.json({ class: cls }, 201);
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/classes", async (c) => {
    try {
      const includeArchived = c.req.query("includeArchived") === "1";
      const classes = await classroom.listClassesForUser(c.get("user").id, {
        includeArchived,
      });
      return c.json({ classes });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/classes/:id", async (c) => {
    try {
      const cls = await classroom.getClassForUser(
        c.req.param("id"),
        c.get("user").id,
      );
      if (!cls) {
        return c.json({ code: "NOT_FOUND", message: "班级不存在" }, 404);
      }
      return c.json({ class: cls });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/classes/:id/members", async (c) => {
    try {
      const members = await classroom.listMembers(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ members });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/classes/join", async (c) => {
    try {
      const body = joinBody.parse(await c.req.json());
      const cls = await classroom.joinByCode(c.get("user").id, body.inviteCode);
      return c.json({ class: cls });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/classes/:id/invite/refresh", async (c) => {
    try {
      const cls = await classroom.refreshInviteCode(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ class: cls });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.delete("/classes/:id/members/:userId", async (c) => {
    try {
      await classroom.removeMember(
        c.req.param("id"),
        c.get("user").id,
        c.req.param("userId"),
      );
      return c.json({ ok: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/classes/:id/archive", async (c) => {
    try {
      const cls = await classroom.archiveClass(c.req.param("id"), c.get("user").id);
      return c.json({ class: cls });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/classes/:id/unarchive", async (c) => {
    try {
      const cls = await classroom.unarchiveClass(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ class: cls });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/classes/:id/invite-qr", async (c) => {
    try {
      if (c.get("user").role !== "teacher") {
        return c.json(
          { code: "FORBIDDEN", message: "仅老师可获取入班二维码" },
          403,
        );
      }
      const row = await classroom.assertOwnsClass(
        c.req.param("id"),
        c.get("user").id,
      );
      const payload = `SUANBEN:${row.invite_code}`;
      const QRCode = (await import("qrcode")).default;
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 280,
        margin: 2,
        color: { dark: "#2C2825", light: "#FFFcf7" },
      });
      return c.json({
        inviteCode: row.invite_code,
        payload,
        dataUrl,
        className: row.name,
      });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // —— Upload ——
  authed.post("/uploads/photo", async (c) => {
    try {
      const body = uploadBody.parse(await c.req.json());
      const saved = saveBase64Image(uploadDir, body);
      return c.json({ url: saved.urlPath, bytes: saved.bytes });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // —— Knowledge tree ——
  authed.get("/knowledge-nodes", async (c) => {
    try {
      const grade = c.req.query("grade");
      const type = c.req.query("type") as
        | "grade"
        | "unit"
        | "knowledge"
        | undefined;
      const q = c.req.query("q") || undefined;
      const g = grade != null && grade !== "" ? Number(grade) : undefined;
      if (c.req.query("tree") === "1" && g != null && !Number.isNaN(g)) {
        return c.json({ tree: await knowledge.treeByGrade(g) });
      }
      const nodes = await knowledge.list({
        grade: g != null && !Number.isNaN(g) ? g : undefined,
        type,
        q,
      });
      return c.json({ nodes });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/knowledge-nodes/:id", async (c) => {
    try {
      const node = await knowledge.getById(c.req.param("id"));
      if (!node) {
        return c.json({ code: "NOT_FOUND", message: "知识点不存在" }, 404);
      }
      return c.json({ node });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // —— Drill ——
  authed.get("/drill/operations", async (c) => {
    try {
      const grade = c.req.query("grade");
      const g = grade ? Number(grade) : undefined;
      const operations = listOperations(
        g != null && !Number.isNaN(g) ? g : undefined,
      ).map((op) => ({
        id: op.id,
        name: op.name,
        category: op.category,
        grades: op.grades,
      }));
      return c.json({ operations });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/questions/generate", async (c) => {
    try {
      if (c.get("user").role !== "teacher") {
        return c.json({ code: "FORBIDDEN", message: "仅老师可出题" }, 403);
      }
      const body = generateBody.parse(await c.req.json());
      const result = generateDrillQuestions(body);
      return c.json({
        operationId: result.operation.id,
        operationName: result.operation.name,
        seed: result.seed,
        questions: result.questions,
      });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // —— Question bank ——
  authed.post("/questions", async (c) => {
    try {
      const body = createQuestionBody.parse(await c.req.json());
      const question = await questionBank.create(c.get("user").id, body);
      return c.json({ question }, 201);
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/questions", async (c) => {
    try {
      const type = c.req.query("type") as
        | "fill_blank"
        | "choice"
        | "true_false"
        | undefined;
      const knowledgeNodeId = c.req.query("knowledgeNodeId") || undefined;
      const questions = await questionBank.listForTeacher(c.get("user").id, {
        type,
        knowledgeNodeId,
      });
      return c.json({ questions });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/questions/:id", async (c) => {
    try {
      const question = await questionBank.getById(
        c.req.param("id"),
        c.get("user").id,
      );
      if (!question) {
        return c.json({ code: "NOT_FOUND", message: "题目不存在" }, 404);
      }
      return c.json({ question });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.patch("/questions/:id", async (c) => {
    try {
      const body = updateQuestionBody.parse(await c.req.json());
      const question = await questionBank.update(
        c.req.param("id"),
        c.get("user").id,
        body,
      );
      return c.json({ question });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // —— Assignments ——
  authed.post("/assignments", async (c) => {
    try {
      const body = createAssignmentBody.parse(await c.req.json());
      const assignment = await assignments.create(c.get("user").id, {
        ...body,
        generatedSnapshots: body.generatedSnapshots as
          | import("../../domain/question/types.js").QuestionSnapshot[]
          | undefined,
      });
      return c.json({ assignment }, 201);
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments", async (c) => {
    try {
      const user = c.get("user");
      const classId = c.req.query("classId") || undefined;
      const status = c.req.query("status") as
        | "draft"
        | "published"
        | "revoked"
        | undefined;

      if (user.role === "teacher") {
        const list = await assignments.listForTeacher(user.id, { classId, status });
        const pendingGrade = await assignments.listPendingGradeCount(user.id);
        return c.json({ assignments: list, pendingGrade });
      }
      if (user.role === "student") {
        const list = await assignments.listForStudent(user.id);
        const incompleteCount = await progress.countStudentIncomplete(user.id);
        return c.json({ assignments: list, incompleteCount });
      }
      return c.json({ assignments: [] });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments/:id/summary", async (c) => {
    try {
      const summary = await progress.getAssignmentSummary(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ summary });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments/:id/reminder-text", async (c) => {
    try {
      const text = await progress.buildReminderText(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ text });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/classes/:id/dashboard", async (c) => {
    try {
      const dashboard = await progress.getClassDashboard(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ dashboard });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/classes/:id/students/:userId/stats", async (c) => {
    try {
      const days = Number(c.req.query("days") || 14);
      const stats = await progress.getStudentStats(
        c.req.param("id"),
        c.req.param("userId"),
        c.get("user").id,
        Number.isFinite(days) ? days : 14,
      );
      return c.json({ stats });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments/:id/question-stats", async (c) => {
    try {
      const stats = await progress.getQuestionStats(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json(stats);
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/me/calendar", async (c) => {
    try {
      const now = new Date();
      const year = Number(c.req.query("year") || now.getFullYear());
      const month = Number(c.req.query("month") || now.getMonth() + 1);
      const calendar = await progress.getStudentCalendar(
        c.get("user").id,
        year,
        month,
      );
      return c.json({ calendar });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/me/knowledge-progress", async (c) => {
    try {
      const items = await progress.getStudentKnowledgeDone(c.get("user").id);
      return c.json({ items });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments/:id", async (c) => {
    try {
      const assignment = await assignments.getAssignment(
        c.req.param("id"),
        c.get("user").id,
      );
      if (!assignment) {
        return c.json({ code: "NOT_FOUND", message: "作业不存在" }, 404);
      }
      return c.json({ assignment });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/assignments/:id/publish", async (c) => {
    try {
      const assignment = await assignments.publish(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ assignment });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/assignments/:id/revoke", async (c) => {
    try {
      const assignment = await assignments.revoke(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ assignment });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/assignments/:id/duplicate", async (c) => {
    try {
      const assignment = await assignments.duplicate(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ assignment }, 201);
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments/:id/my-submission", async (c) => {
    try {
      const submission = await assignments.getOrCreateMySubmission(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ submission });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments/:id/submissions", async (c) => {
    try {
      const list = await assignments.listSubmissionsForTeacher(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ submissions: list });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.get("/assignments/:id/questions", async (c) => {
    try {
      const questions = await assignments.listAssignmentQuestions(
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ questions });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.put("/assignments/:id/questions", async (c) => {
    try {
      const body = setQuestionsBody.parse(await c.req.json());
      const questions = await assignments.setQuestions(
        c.req.param("id"),
        c.get("user").id,
        body.questionIds,
      );
      return c.json({ questions });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/submissions/:id/photos", async (c) => {
    try {
      const body = submitPhotosBody.parse(await c.req.json());
      const submission = await assignments.submitPhotos(
        c.req.param("id"),
        c.get("user").id,
        body.photoUrls,
      );
      return c.json({ submission });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.put("/submissions/:id/draft", async (c) => {
    try {
      const body = onlineAnswersBody.parse(await c.req.json());
      const submission = await assignments.saveDraftAnswers(
        c.req.param("id"),
        c.get("user").id,
        body.answers,
      );
      return c.json({ submission });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/submissions/:id/answers", async (c) => {
    try {
      const body = onlineAnswersBody.parse(await c.req.json());
      const submission = await assignments.submitOnlineAnswers(
        c.req.param("id"),
        c.get("user").id,
        body.answers,
        { force: body.force === true },
      );
      return c.json({ submission });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/submissions/:id/correct", async (c) => {
    try {
      const body = onlineAnswersBody.parse(await c.req.json());
      const submission = await assignments.correctOnlineAnswers(
        c.req.param("id"),
        c.get("user").id,
        body.answers,
      );
      return c.json({ submission });
    } catch (e) {
      return handleError(c, e);
    }
  });

  authed.post("/submissions/:id/grade", async (c) => {
    try {
      const body = gradeBody.parse(await c.req.json());
      const submission = await assignments.gradePhoto(
        c.req.param("id"),
        c.get("user").id,
        body,
      );
      return c.json({ submission });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.route("/api/v1", authed);

  (app as unknown as { identity: IdentityService }).identity = identity;
  (app as unknown as { classroom: ClassRoomService }).classroom = classroom;
  (app as unknown as { assignments: AssignmentService }).assignments =
    assignments;
  (app as unknown as { progress: ProgressService }).progress = progress;
  return app;
}

const loginBody = z.object({
  code: z.string().min(1),
  nickname: z.string().max(64).optional(),
  avatarUrl: z.string().max(512).optional(),
  /** Client-stable id; mock login uses it so re-login reuses the same account */
  deviceId: z.string().min(1).max(128).optional(),
});

const patchBody = z.object({
  nickname: z.string().min(1).max(64).optional(),
  avatarUrl: z.string().max(512).optional().nullable(),
  role: z.enum(["teacher", "student"]).optional(),
  /** Required when first selecting role=teacher */
  teacherCode: z.string().min(1).max(64).optional(),
});

const createClassBody = z.object({
  name: z.string().min(1).max(40),
  grade: z.union([
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
  ]),
});

const joinBody = z.object({
  inviteCode: z.string().min(1).max(16),
});

const uploadBody = z.object({
  data: z.string().min(1),
  mime: z.string().optional(),
});

const generateBody = z.object({
  operationId: z.string().min(1),
  count: z.number().int().min(1).max(50),
  difficulty: z.enum(["basic", "normal", "challenge"]).optional(),
  seed: z.number().int().optional(),
});

const generatedSnapSchema = z.object({
  type: z.enum(["fill_blank", "choice", "true_false"]),
  stem: z.string().min(1),
  options: z
    .array(z.object({ id: z.string(), text: z.string() }))
    .nullable()
    .optional()
    .default(null),
  answer: z.union([z.string(), z.boolean()]),
  explanation: z.string().nullable().optional().default(null),
  knowledgeNodeId: z.string().nullable().optional().default(null),
  source: z.literal("generated").optional().default("generated"),
});

const createAssignmentBody = z.object({
  classId: z.string().min(1),
  type: z.enum(["daily_drill", "knowledge_checkin", "photo_homework"]),
  title: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
  dueAt: z.string().nullable().optional(),
  config: z.record(z.unknown()).optional(),
  publish: z.boolean().optional(),
  questionIds: z.array(z.string()).max(50).optional(),
  generatedSnapshots: z.array(generatedSnapSchema).max(50).optional(),
});

const setQuestionsBody = z.object({
  questionIds: z.array(z.string()).min(1).max(50),
});

const choiceOptionSchema = z.object({
  id: z.string().min(1).max(32),
  text: z.string().min(1).max(500),
});

const createQuestionBody = z.object({
  type: z.enum(["fill_blank", "choice", "true_false"]),
  stem: z.string().min(1).max(2000),
  options: z.array(choiceOptionSchema).optional().nullable(),
  answer: z.union([z.string(), z.boolean()]),
  explanation: z.string().max(2000).optional().nullable(),
  knowledgeNodeId: z.string().max(64).optional().nullable(),
});

const updateQuestionBody = z.object({
  type: z.enum(["fill_blank", "choice", "true_false"]).optional(),
  stem: z.string().min(1).max(2000).optional(),
  options: z.array(choiceOptionSchema).optional().nullable(),
  answer: z.union([z.string(), z.boolean()]).optional(),
  explanation: z.string().max(2000).optional().nullable(),
  knowledgeNodeId: z.string().max(64).optional().nullable(),
});

const submitPhotosBody = z.object({
  photoUrls: z.array(z.string()).min(1).max(6),
});

const onlineAnswersBody = z.object({
  answers: z
    .array(
      z.object({
        assignmentQuestionId: z.string().min(1),
        response: z.union([z.string(), z.boolean(), z.null()]),
      }),
    )
    .max(50),
  force: z.boolean().optional(),
});

const gradeBody = z.object({
  result: z.enum(["correct", "partial", "incorrect"]),
  score: z.number().min(0).max(100).nullable().optional(),
  comment: z.string().max(500).nullable().optional(),
  requireResubmit: z.boolean().optional(),
});

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function handleError(
  c: { json: (b: unknown, s?: number) => Response },
  e: unknown,
) {
  if (e instanceof AppError) {
    return c.json({ code: e.code, message: e.message }, e.status);
  }
  if (e instanceof AuthError) {
    const status =
      e.code === "NOT_FOUND"
        ? 404
        : e.code === "UNAUTHORIZED"
          ? 401
          : 400;
    return c.json({ code: e.code, message: e.message }, status);
  }
  if (e instanceof z.ZodError) {
    return c.json(
      { code: "VALIDATION", message: e.errors[0]?.message || "参数错误" },
      400,
    );
  }
  console.error(e);
  return c.json({ code: "INTERNAL", message: "服务器错误" }, 500);
}
