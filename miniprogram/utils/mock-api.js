/**
 * Offline mock API for UI walkthrough without server/domain.
 * Enable: app.globalData.useMockData = true
 */
const store = require("./mock-store");
const { getToken, setToken, setUser, getUser, clearAuth } = require("./auth");

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    role: u.role,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl || null,
    createdAt: u.createdAt,
  };
}

function requireUser() {
  const token = getToken();
  if (!token) {
    const err = new Error("未登录");
    err.code = "UNAUTHORIZED";
    err.statusCode = 401;
    throw err;
  }
  const db = store.load();
  const userId = db.sessions[token];
  const user = userId ? db.users[userId] : null;
  if (!user) {
    clearAuth();
    const err = new Error("会话已失效");
    err.code = "UNAUTHORIZED";
    err.statusCode = 401;
    throw err;
  }
  return { db, user, token };
}

function seedDemoIfEmpty(db, teacherId) {
  if (db.classes.some((c) => c.teacherId === teacherId)) return;

  const classId = store.id("cls");
  const inviteCode = "DEMO88";
  const cls = {
    id: classId,
    name: "体验班 · 四年级",
    grade: 4,
    teacherId,
    inviteCode,
    archived: false,
    createdAt: nowIso(),
  };
  db.classes.push(cls);
  db.memberships.push({
    classId,
    userId: teacherId,
    role: "teacher",
    joinedAt: nowIso(),
  });

  // Sample questions
  const q1 = {
    id: store.id("q"),
    ownerId: teacherId,
    type: "fill",
    stem: "计算：25 × 4 = ?",
    answer: "100",
    options: null,
    knowledgeNodeIds: [],
    createdAt: nowIso(),
  };
  const q2 = {
    id: store.id("q"),
    ownerId: teacherId,
    type: "fill",
    stem: "计算：120 ÷ 5 = ?",
    answer: "24",
    options: null,
    knowledgeNodeIds: [],
    createdAt: nowIso(),
  };
  db.questions.push(q1, q2);

  const asgId = store.id("asg");
  db.assignments.push({
    id: asgId,
    classId,
    teacherId,
    type: "daily_drill",
    title: "体验 · 每日计算",
    status: "published",
    dueAt: null,
    questions: [
      { id: q1.id, stem: q1.stem, type: q1.type, answer: q1.answer },
      { id: q2.id, stem: q2.stem, type: q2.type, answer: q2.answer },
    ],
    knowledgePoints: [{ id: "n1", name: "四则运算" }],
    createdAt: nowIso(),
  });

  store.save(db);
}

function matchRoute(path, pattern) {
  // pattern like /api/v1/assignments/:id/my-submission
  const pp = pattern.split("/").filter(Boolean);
  const ap = path.split("?")[0].split("/").filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
    } else if (pp[i] !== ap[i]) {
      return null;
    }
  }
  return params;
}

/** Align with server normalizeText + simple math equivalence */
function normalizeAnswer(s) {
  return String(s == null ? "" : s)
    .trim()
    .replace(/[\uFF10-\uFF19]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
    )
    .replace(/\uFF0E/g, ".")
    .replace(/\u2212/g, "-")
    .replace(/\uFF0D/g, "-")
    .replace(/商/g, "")
    .replace(/余/g, "...")
    .replace(/\s+/g, "");
}

function parseMathNumber(s) {
  const t = normalizeAnswer(s);
  if (!t) return null;
  const frac = t.match(/^(-?\d+)\/(\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    if (!den) return null;
    return Number(frac[1]) / den;
  }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
}

function answersMatch(expected, actual) {
  const a = normalizeAnswer(expected);
  const b = normalizeAnswer(actual);
  if (a === b) return true;
  const na = parseMathNumber(a);
  const nb = parseMathNumber(b);
  if (na != null && nb != null) return Math.abs(na - nb) < 1e-9;
  return false;
}

function mockError(message, code, statusCode) {
  const err = new Error(message || "请求失败");
  err.code = code || "NOT_FOUND";
  err.statusCode = statusCode || 404;
  return err;
}

function expandSubmissionAnswers(assignment, sub) {
  const qs = (assignment && assignment.questions) || [];
  const existing = sub.answers || [];
  const byQ = {};
  existing.forEach((a) => {
    const key = a.assignmentQuestionId || a.questionId;
    if (key) byQ[key] = a;
  });
  return qs.map((q) => {
    const prev = byQ[q.id] || {};
    return {
      assignmentQuestionId: q.id,
      questionId: q.id,
      stem: q.stem,
      type: q.type || "fill_blank",
      options: q.options || null,
      response: prev.response != null ? prev.response : null,
      isCorrect:
        prev.isCorrect === true || prev.isCorrect === false
          ? prev.isCorrect
          : null,
      correctAnswer:
        prev.isCorrect === true || prev.isCorrect === false
          ? q.answer
          : undefined,
    };
  });
}

async function handle(url, method = "GET", data) {
  await delay(80);
  const path = (url || "").split("?")[0];
  const m = (method || "GET").toUpperCase();
  const q = {};
  if (url && url.includes("?")) {
    url
      .split("?")[1]
      .split("&")
      .forEach((pair) => {
        const [k, v] = pair.split("=");
        if (k) q[k] = decodeURIComponent(v || "");
      });
  }

  // —— Auth ——
  if (path === "/api/v1/auth/wechat" && m === "POST") {
    const db = store.load();
    const deviceId = (data && data.deviceId) || "demo_device";
    // Stable mock user per device
    let user = Object.values(db.users).find((u) => u.deviceId === deviceId);
    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      const uid = store.id("usr");
      user = {
        id: uid,
        deviceId,
        openid: `mock_dev_${deviceId}`,
        role: null,
        nickname: "体验用户",
        avatarUrl: null,
        createdAt: nowIso(),
      };
      db.users[uid] = user;
    }
    const token = store.id("tok");
    db.sessions[token] = user.id;
    store.save(db);
    setToken(token);
    setUser(publicUser(user));
    return { token, user: publicUser(user), isNewUser };
  }

  if (path === "/api/v1/auth/logout" && m === "POST") {
    const token = getToken();
    if (token) {
      const db = store.load();
      delete db.sessions[token];
      store.save(db);
    }
    clearAuth();
    return { ok: true };
  }

  if (path === "/api/v1/me" && m === "GET") {
    const { user } = requireUser();
    return { user: publicUser(user) };
  }

  if (path === "/api/v1/me" && m === "PATCH") {
    const { db, user } = requireUser();
    if (data && data.role) {
      if (data.role !== "teacher" && data.role !== "student") {
        throw mockError("身份只能是 teacher 或 student", "INVALID_ROLE", 400);
      }
      // Align with server: allow switch; teacher always needs code
      if (data.role !== user.role) {
        if (data.role === "teacher") {
          const code = (data.teacherCode || "").trim();
          if (!code) {
            throw mockError(
              "选择老师身份需要填写教师开通码",
              "TEACHER_CODE_REQUIRED",
              400,
            );
          }
          const ok =
            code === "SUANBEN-TEACHER" ||
            code === "DEMO" ||
            code.length >= 4;
          if (!ok) {
            throw mockError(
              "教师开通码不正确（体验可用 DEMO 或 SUANBEN-TEACHER）",
              "TEACHER_CODE_INVALID",
              400,
            );
          }
        }
        user.role = data.role;
      }
    }
    if (data && data.nickname) user.nickname = data.nickname;
    if (data && data.avatarUrl !== undefined) user.avatarUrl = data.avatarUrl;
    db.users[user.id] = user;
    store.save(db);
    if (user.role === "teacher") seedDemoIfEmpty(db, user.id);
    setUser(publicUser(user));
    return { user: publicUser(user) };
  }

  // —— Classes ——
  if (path === "/api/v1/classes" && m === "GET") {
    const { db, user } = requireUser();
    const mine = db.memberships
      .filter((x) => x.userId === user.id)
      .map((x) => db.classes.find((c) => c.id === x.classId))
      .filter(Boolean)
      .filter((c) => !c.archived);
    return {
      classes: mine.map((c) => ({
        id: c.id,
        name: c.name,
        grade: c.grade,
        inviteCode: c.inviteCode,
        teacherId: c.teacherId,
        archived: !!c.archived,
        createdAt: c.createdAt,
      })),
    };
  }

  if (path === "/api/v1/classes" && m === "POST") {
    const { db, user } = requireUser();
    if (user.role !== "teacher") {
      const err = new Error("仅老师可建班");
      err.code = "FORBIDDEN";
      throw err;
    }
    const cls = {
      id: store.id("cls"),
      name: (data && data.name) || "新班级",
      grade: (data && data.grade) || 4,
      teacherId: user.id,
      inviteCode: `M${String(Math.floor(Math.random() * 9000) + 1000)}`,
      archived: false,
      createdAt: nowIso(),
    };
    db.classes.push(cls);
    db.memberships.push({
      classId: cls.id,
      userId: user.id,
      role: "teacher",
      joinedAt: nowIso(),
    });
    store.save(db);
    return { class: cls };
  }

  let p = matchRoute(path, "/api/v1/classes/:id");
  if (p && m === "GET") {
    const { db, user } = requireUser();
    const cls = db.classes.find((c) => c.id === p.id);
    if (!cls) {
      const err = new Error("班级不存在");
      err.code = "NOT_FOUND";
      throw err;
    }
    const mem = db.memberships.find(
      (x) => x.classId === cls.id && x.userId === user.id,
    );
    if (!mem) {
      const err = new Error("无权查看");
      err.code = "FORBIDDEN";
      throw err;
    }
    return { class: cls };
  }

  if (path === "/api/v1/classes/join" && m === "POST") {
    const { db, user } = requireUser();
    if (user.role !== "student") {
      const err = new Error("仅学生可加入班级");
      err.code = "FORBIDDEN";
      throw err;
    }
    const code = String((data && data.inviteCode) || "")
      .trim()
      .toUpperCase();
    const cls = db.classes.find(
      (c) => String(c.inviteCode).toUpperCase() === code && !c.archived,
    );
    if (!cls) {
      // Auto-create demo class if joining DEMO88 and none exists
      if (code === "DEMO88" || code === "DEMO") {
        // find any teacher class or create orphan demo
        let any = db.classes[0];
        if (!any) {
          any = {
            id: store.id("cls"),
            name: "体验班 · 四年级",
            grade: 4,
            teacherId: "usr_demo_teacher",
            inviteCode: "DEMO88",
            archived: false,
            createdAt: nowIso(),
          };
          db.classes.push(any);
        }
        const exists = db.memberships.find(
          (x) => x.classId === any.id && x.userId === user.id,
        );
        if (!exists) {
          db.memberships.push({
            classId: any.id,
            userId: user.id,
            role: "student",
            joinedAt: nowIso(),
          });
        }
        store.save(db);
        return { class: any };
      }
      const err = new Error("邀请码无效（体验可试 DEMO88）");
      err.code = "INVALID_CODE";
      throw err;
    }
    const exists = db.memberships.find(
      (x) => x.classId === cls.id && x.userId === user.id,
    );
    if (!exists) {
      db.memberships.push({
        classId: cls.id,
        userId: user.id,
        role: "student",
        joinedAt: nowIso(),
      });
      store.save(db);
    }
    return { class: cls };
  }

  p = matchRoute(path, "/api/v1/classes/:id/members");
  if (p && m === "GET") {
    const { db } = requireUser();
    const members = db.memberships
      .filter((x) => x.classId === p.id)
      .map((x) => {
        const u = db.users[x.userId] || {
          id: x.userId,
          nickname: "同学",
          role: x.role,
        };
        return {
          userId: x.userId,
          nickname: u.nickname || "同学",
          avatarUrl: u.avatarUrl || null,
          role: x.role,
          joinedAt: x.joinedAt,
        };
      });
    return { members };
  }

  p = matchRoute(path, "/api/v1/classes/:id/dashboard");
  if (p && m === "GET") {
    const { db } = requireUser();
    const asgs = db.assignments.filter((a) => a.classId === p.id);
    const students = db.memberships.filter(
      (x) => x.classId === p.id && x.role === "student",
    );
    return {
      dashboard: {
        studentCount: students.length,
        assignmentCount: asgs.length,
        completionRate: students.length ? 60 : 0,
        pendingGrade: 0,
        recentAssignments: asgs.slice(0, 5).map((a) => ({
          id: a.id,
          title: a.title,
          type: a.type,
          completionRate: 50,
          status: a.status,
        })),
      },
    };
  }

  p = matchRoute(path, "/api/v1/classes/:id/invite/refresh");
  if (p && m === "POST") {
    const { db, user } = requireUser();
    const cls = db.classes.find((c) => c.id === p.id);
    if (!cls || cls.teacherId !== user.id) {
      const err = new Error("无权操作");
      err.code = "FORBIDDEN";
      throw err;
    }
    cls.inviteCode = `M${String(Math.floor(Math.random() * 9000) + 1000)}`;
    store.save(db);
    return { class: cls };
  }

  p = matchRoute(path, "/api/v1/classes/:id/invite-qr");
  if (p && m === "GET") {
    const { db } = requireUser();
    const cls = db.classes.find((c) => c.id === p.id);
    return {
      payload: `SUANBEN:${cls ? cls.inviteCode : "DEMO88"}`,
      dataUrl: "",
      inviteCode: cls ? cls.inviteCode : "DEMO88",
    };
  }

  // —— Questions ——
  if (path === "/api/v1/questions" && m === "GET") {
    const { db, user } = requireUser();
    const list = db.questions.filter(
      (q) => q.ownerId === user.id || user.role === "student",
    );
    return { questions: list };
  }

  if (path === "/api/v1/questions" && m === "POST") {
    const { db, user } = requireUser();
    const q = {
      id: store.id("q"),
      ownerId: user.id,
      type: (data && data.type) || "fill",
      stem: (data && data.stem) || "示例题",
      answer: (data && data.answer) || "",
      options: (data && data.options) || null,
      knowledgeNodeIds: (data && data.knowledgeNodeIds) || [],
      createdAt: nowIso(),
    };
    db.questions.push(q);
    store.save(db);
    return { question: q };
  }

  p = matchRoute(path, "/api/v1/questions/:id");
  if (p && m === "GET") {
    const { db } = requireUser();
    const q = db.questions.find((x) => x.id === p.id);
    return { question: q };
  }
  if (p && (m === "PATCH" || m === "PUT")) {
    const { db, user } = requireUser();
    const q = db.questions.find((x) => x.id === p.id);
    if (q && q.ownerId === user.id) {
      Object.assign(q, data || {});
      store.save(db);
    }
    return { question: q };
  }

  if (path === "/api/v1/questions/generate" && m === "POST") {
    const items = [];
    const n = (data && data.count) || 5;
    for (let i = 0; i < n; i++) {
      const a = 10 + i;
      const b = 2 + (i % 5);
      items.push({
        type: "fill",
        stem: `计算：${a} × ${b} = ?`,
        answer: String(a * b),
        options: null,
      });
    }
    return { questions: items };
  }

  // —— Assignments ——
  if (path === "/api/v1/assignments" && m === "GET") {
    const { db, user } = requireUser();
    let list;
    if (user.role === "teacher") {
      list = db.assignments.filter((a) => a.teacherId === user.id);
    } else {
      const classIds = db.memberships
        .filter((x) => x.userId === user.id)
        .map((x) => x.classId);
      list = db.assignments.filter(
        (a) => classIds.includes(a.classId) && a.status === "published",
      );
    }
    let incompleteCount = 0;
    let pendingGrade = 0;
    if (user.role === "student") {
      for (const a of list) {
        const sub = db.submissions.find(
          (s) => s.assignmentId === a.id && s.studentId === user.id,
        );
        if (!sub || sub.status !== "completed") incompleteCount += 1;
      }
    }
    if (user.role === "teacher") {
      pendingGrade = db.submissions.filter(
        (s) =>
          s.status === "pending_grade" &&
          list.some((a) => a.id === s.assignmentId),
      ).length;
    }
    return {
      assignments: list.map((a) => ({
        id: a.id,
        classId: a.classId,
        type: a.type,
        title: a.title,
        status: a.status,
        dueAt: a.dueAt,
        knowledgePoints: a.knowledgePoints || [],
        createdAt: a.createdAt,
      })),
      incompleteCount,
      pendingGrade,
    };
  }

  if (path === "/api/v1/assignments" && m === "POST") {
    const { db, user } = requireUser();
    const asg = {
      id: store.id("asg"),
      classId: data.classId,
      teacherId: user.id,
      type: data.type || "daily_drill",
      title: data.title || "新作业",
      status: data.publish === false ? "draft" : "published",
      dueAt: data.dueAt || null,
      questions: data.questions || data.questionSnapshots || [],
      knowledgePoints: data.knowledgePoints || [],
      createdAt: nowIso(),
    };
    // If questionIds provided, snapshot from bank
    if (data.questionIds && data.questionIds.length) {
      asg.questions = data.questionIds.map((qid) => {
        const q = db.questions.find((x) => x.id === qid);
        return q
          ? {
              id: q.id,
              stem: q.stem,
              type: q.type,
              answer: q.answer,
              options: q.options,
            }
          : { id: qid, stem: "题目", type: "fill", answer: "" };
      });
    }
    db.assignments.push(asg);
    store.save(db);
    return { assignment: asg };
  }

  p = matchRoute(path, "/api/v1/assignments/:id");
  if (p && m === "GET") {
    const { db } = requireUser();
    const a = db.assignments.find((x) => x.id === p.id);
    if (!a) {
      const err = new Error("作业不存在");
      err.code = "NOT_FOUND";
      throw err;
    }
    return {
      assignment: {
        ...a,
        questions: a.questions || [],
      },
    };
  }

  p = matchRoute(path, "/api/v1/assignments/:id/publish");
  if (p && m === "POST") {
    const { db } = requireUser();
    const a = db.assignments.find((x) => x.id === p.id);
    if (a) a.status = "published";
    store.save(db);
    return { assignment: a };
  }

  p = matchRoute(path, "/api/v1/assignments/:id/summary");
  if (p && m === "GET") {
    return {
      summary: {
        total: 3,
        completed: 1,
        inProgress: 1,
        notStarted: 1,
        overdue: 0,
        pendingGrade: 0,
        completionRate: 33,
        unfinished: [{ userId: "u1", nickname: "小明" }],
      },
    };
  }

  p = matchRoute(path, "/api/v1/assignments/:id/reminder-text");
  if (p && m === "GET") {
    const { db } = requireUser();
    const a = db.assignments.find((x) => x.id === p.id);
    return {
      text: `【算本催交】请尽快完成作业「${a ? a.title : "作业"}」，谢谢！`,
    };
  }

  p = matchRoute(path, "/api/v1/assignments/:id/question-stats");
  if (p && m === "GET") {
    return { stats: [] };
  }

  p = matchRoute(path, "/api/v1/assignments/:id/submissions");
  if (p && m === "GET") {
    const { db } = requireUser();
    const list = db.submissions.filter((s) => s.assignmentId === p.id);
    return {
      submissions: list.map((s) => ({
        id: s.id,
        studentId: s.studentId,
        nickname: (db.users[s.studentId] || {}).nickname || "学生",
        status: s.status,
        score: s.score,
        submittedAt: s.submittedAt,
      })),
    };
  }

  p = matchRoute(path, "/api/v1/assignments/:id/my-submission");
  if (p && m === "GET") {
    const { db, user } = requireUser();
    const a = db.assignments.find((x) => x.id === p.id);
    let sub = db.submissions.find(
      (s) => s.assignmentId === p.id && s.studentId === user.id,
    );
    if (!sub) {
      sub = {
        id: store.id("sub"),
        assignmentId: p.id,
        studentId: user.id,
        status: "not_started",
        answers: [],
        photos: [],
        score: null,
        submittedAt: null,
      };
      db.submissions.push(sub);
      store.save(db);
    }
    if (a && a.type !== "photo_homework") {
      sub = {
        ...sub,
        answers: expandSubmissionAnswers(a, sub),
      };
    }
    return { submission: sub };
  }

  p = matchRoute(path, "/api/v1/submissions/:id/draft");
  if (p && m === "PUT") {
    const { db, user } = requireUser();
    const sub = db.submissions.find((s) => s.id === p.id);
    if (!sub || sub.studentId !== user.id) throw mockError("提交不存在", "NOT_FOUND", 404);
    if (sub.status === "completed") {
      throw mockError("已完成，不能再改", "INVALID_STATUS", 400);
    }
    const a = db.assignments.find((x) => x.id === sub.assignmentId);
    const incoming = (data && data.answers) || [];
    const byQ = {};
    (sub.answers || []).forEach((ans) => {
      byQ[ans.assignmentQuestionId || ans.questionId] = ans;
    });
    incoming.forEach((ans) => {
      const qid = ans.assignmentQuestionId || ans.questionId;
      byQ[qid] = {
        ...(byQ[qid] || {}),
        assignmentQuestionId: qid,
        questionId: qid,
        response: ans.response,
        isCorrect: null,
      };
    });
    sub.answers = Object.keys(byQ).map((k) => byQ[k]);
    if (sub.status === "not_started") sub.status = "in_progress";
    store.save(db);
    return {
      submission: {
        ...sub,
        answers: a ? expandSubmissionAnswers(a, sub) : sub.answers,
      },
    };
  }

  p = matchRoute(path, "/api/v1/submissions/:id/answers");
  if (p && m === "POST") {
    const { db, user } = requireUser();
    const sub = db.submissions.find((s) => s.id === p.id);
    if (!sub || sub.studentId !== user.id) throw mockError("提交不存在", "NOT_FOUND", 404);
    if (sub.status !== "not_started" && sub.status !== "in_progress") {
      throw mockError("当前状态不可整卷提交", "INVALID_STATUS", 400);
    }
    const a = db.assignments.find((x) => x.id === sub.assignmentId);
    const answers = (data && data.answers) || [];
    const force = data && data.force === true;
    const qs = (a && a.questions) || [];
    const byIncoming = {};
    answers.forEach((ans) => {
      byIncoming[ans.assignmentQuestionId || ans.questionId] = ans.response;
    });
    (sub.answers || []).forEach((ans) => {
      const qid = ans.assignmentQuestionId || ans.questionId;
      if (byIncoming[qid] === undefined && ans.response != null) {
        byIncoming[qid] = ans.response;
      }
    });
    if (!force) {
      for (let i = 0; i < qs.length; i++) {
        const r = byIncoming[qs[i].id];
        if (r === undefined || r === null || r === "") {
          throw mockError("请答完所有题目再提交", "INCOMPLETE", 400);
        }
      }
    }
    let correctCount = 0;
    const graded = qs.map((q) => {
      const response = byIncoming[q.id];
      const correct =
        response != null &&
        response !== "" &&
        answersMatch(q.answer, response);
      if (correct) correctCount += 1;
      return {
        assignmentQuestionId: q.id,
        questionId: q.id,
        stem: q.stem,
        type: q.type || "fill_blank",
        options: q.options || null,
        response: response != null ? response : null,
        isCorrect: correct,
        correctAnswer: q.answer,
      };
    });
    sub.answers = graded;
    sub.score = qs.length
      ? Math.round((correctCount / qs.length) * 100)
      : 0;
    sub.status =
      correctCount === qs.length ? "completed" : "pending_correction";
    sub.submittedAt = nowIso();
    store.save(db);
    return { submission: sub };
  }

  p = matchRoute(path, "/api/v1/submissions/:id/photos");
  if (p && m === "POST") {
    const { db, user } = requireUser();
    const sub = db.submissions.find((s) => s.id === p.id);
    if (!sub || sub.studentId !== user.id) throw mockError("提交不存在", "NOT_FOUND", 404);
    if (sub.status === "submitted") {
      throw mockError("已提交，等待老师批改，不能再修改", "INVALID_STATUS", 400);
    }
    if (sub.status === "completed") {
      throw mockError("作业已批改完成，不能再提交", "INVALID_STATUS", 400);
    }
    if (sub.status !== "not_started" && sub.status !== "resubmit_required") {
      throw mockError("当前状态不能提交照片", "INVALID_STATUS", 400);
    }
    const urls = ((data && data.photoUrls) || []).filter(Boolean);
    if (!urls.length) throw mockError("请至少上传 1 张照片", "INVALID_PHOTOS", 400);
    sub.photos = urls.map((url, i) => ({ url, sortOrder: i }));
    sub.status = "submitted";
    sub.submittedAt = nowIso();
    store.save(db);
    return { submission: sub };
  }

  p = matchRoute(path, "/api/v1/assignments/:id/submit");
  if (p && m === "POST") {
    const { db, user } = requireUser();
    const a = db.assignments.find((x) => x.id === p.id);
    let sub = db.submissions.find(
      (s) => s.assignmentId === p.id && s.studentId === user.id,
    );
    if (!sub) {
      sub = {
        id: store.id("sub"),
        assignmentId: p.id,
        studentId: user.id,
        status: "not_started",
        answers: [],
      };
      db.submissions.push(sub);
    }
    const answers = (data && data.answers) || [];
    let allCorrect = true;
    const graded = (a && a.questions ? a.questions : []).map((q, i) => {
      const ans = answers[i] || answers.find((x) => x.questionId === q.id);
      const response =
        ans && (ans.response != null ? ans.response : ans.answer);
      const correct = answersMatch(q.answer, response);
      if (!correct) allCorrect = false;
      return {
        assignmentQuestionId: q.id,
        questionId: q.id,
        stem: q.stem,
        type: q.type || "fill_blank",
        response,
        isCorrect: correct,
        correctAnswer: q.answer,
      };
    });
    sub.answers = graded;
    sub.status = allCorrect ? "completed" : "pending_correction";
    sub.submittedAt = nowIso();
    sub.score = allCorrect
      ? 100
      : Math.round(
          (graded.filter((g) => g.isCorrect).length /
            Math.max(graded.length, 1)) *
            100,
        );
    store.save(db);
    return { submission: sub };
  }

  p = matchRoute(path, "/api/v1/submissions/:id/correct");
  if (p && m === "POST") {
    const { db, user } = requireUser();
    const sub = db.submissions.find((s) => s.id === p.id);
    if (!sub || sub.studentId !== user.id) {
      throw mockError("提交不存在", "NOT_FOUND", 404);
    }
    const a = db.assignments.find((x) => x.id === sub.assignmentId);
    const fixes = (data && data.answers) || [];
    let allCorrect = true;
    sub.answers = (sub.answers || []).map((item) => {
      if (item.isCorrect) return item;
      const qid = item.assignmentQuestionId || item.questionId;
      const fix = fixes.find(
        (f) =>
          f.questionId === qid ||
          f.assignmentQuestionId === qid,
      );
      const q = (a && a.questions || []).find((x) => x.id === qid);
      const response = fix
        ? fix.response != null
          ? fix.response
          : fix.answer
        : item.response;
      const correct = q && answersMatch(q.answer, response);
      if (!correct) allCorrect = false;
      return {
        ...item,
        assignmentQuestionId: qid,
        questionId: qid,
        response,
        isCorrect: !!correct,
        correctAnswer: q ? q.answer : item.correctAnswer,
      };
    });
    sub.status = allCorrect ? "completed" : "pending_correction";
    if (allCorrect) sub.score = 100;
    store.save(db);
    return { submission: sub };
  }

  // Legacy singular path kept for older demos
  p = matchRoute(path, "/api/v1/submissions/:id/photo");
  if (p && m === "POST") {
    const { db, user } = requireUser();
    const sub = db.submissions.find((s) => s.id === p.id);
    if (!sub || sub.studentId !== user.id) {
      throw mockError("提交不存在", "NOT_FOUND", 404);
    }
    if (sub.status === "submitted" || sub.status === "completed") {
      throw mockError("当前状态不能提交照片", "INVALID_STATUS", 400);
    }
    const url = (data && data.url) || "mock://photo";
    sub.photos = [{ url, sortOrder: 0 }];
    sub.photoUrl = url;
    sub.status = "submitted";
    sub.submittedAt = nowIso();
    store.save(db);
    return { submission: sub };
  }

  p = matchRoute(path, "/api/v1/submissions/:id/grade");
  if (p && m === "POST") {
    const { db } = requireUser();
    const sub = db.submissions.find((s) => s.id === p.id);
    if (sub) {
      sub.status =
        data && data.requireResubmit ? "need_resubmit" : "completed";
      sub.score = data && data.score != null ? data.score : 90;
      sub.comment = (data && data.comment) || "";
      sub.gradeResult = (data && data.result) || "correct";
    }
    store.save(db);
    return { submission: sub };
  }

  if (path === "/api/v1/uploads/photo" && m === "POST") {
    // Mock as cloud fileID shape so UI path matches production
    return {
      url:
        "cloud://mock-env/homework/mock_" +
        Date.now().toString(36) +
        ".jpg",
      path: "/mock/photo.jpg",
    };
  }

  if (path.indexOf("/api/v1/uploads/content") === 0 && m === "GET") {
    // Tiny 1x1 PNG for mock display
    return {
      path: "/uploads/mock.png",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      bytes: 70,
    };
  }

  if (path === "/api/v1/me/knowledge-progress" && m === "GET") {
    // Align with server ProgressService: { items: KnowledgeDoneItem[] }
    return {
      items: [
        {
          knowledgeNodeId: "n1",
          name: "四则运算",
          pathLabel: "四则运算",
          doneAt: nowIso(),
        },
      ],
    };
  }

  if (path.indexOf("/api/v1/me/calendar") === 0 && m === "GET") {
    const day = nowIso().slice(0, 10);
    return {
      calendar: {
        year: Number(day.slice(0, 4)),
        month: Number(day.slice(5, 7)),
        days: [{ date: day, completedCount: 1 }],
        streakDays: 1,
        monthLitDays: 1,
      },
    };
  }

  if (path === "/api/v1/me/mastery/due" && m === "GET") {
    return { review: null };
  }
  if (path.indexOf("/api/v1/me/mastery-map") === 0 && m === "GET") {
    return {
      map: {
        grade: 3,
        units: [],
        stamps: [],
        summary: { dark: 0, half: 0, lit: 0 },
      },
    };
  }
  if (path.indexOf("/api/v1/me/mastery/week-summary") === 0 && m === "GET") {
    return {
      summary: {
        weekLabel: "本周",
        startYmd: "",
        endYmd: "",
        completedTaskCount: 0,
        litDays: 0,
        reviewPassedCount: 0,
        selfPracticeCount: 0,
        knowledgeNames: [],
        bullets: ["完成任务 0 次", "学习点亮 0 天", "本周暂无新巩固点，下周继续"],
        copyText: "【算本本周小结】\n· 完成任务 0 次\n· 学习点亮 0 天\n· 点亮/巩固：本周暂无新巩固点",
      },
    };
  }
  if (path === "/api/v1/me/mastery/self-practice" && m === "POST") {
    return {
      review: {
        id: "mrv_mock",
        masteryItemId: "mst_mock",
        source: "self_practice",
        status: "in_progress",
        title: "巩固：示例",
        knowledgeName: "示例",
        questions: [],
        totalCount: 0,
        correctCount: null,
        passed: null,
      },
    };
  }
  if (path.indexOf("/api/v1/me/mastery") === 0 && m === "GET") {
    return { items: [] };
  }

  p = matchRoute(path, "/api/v1/classes/:id/students/:userId/stats");
  if (p && m === "GET") {
    return {
      stats: {
        completionRate: 75,
        days: 14,
        recent: [],
      },
    };
  }

  // Knowledge tree (read-only stub)
  if (path.indexOf("/api/v1/knowledge") === 0) {
    return {
      tree: [],
      nodes: [],
      operations: [
        { id: "mul", name: "乘法" },
        { id: "div", name: "除法" },
      ],
    };
  }

  console.warn("[mock-api] unhandled", m, path, data);
  // Fail loud — soft-success caused false-green demos
  throw mockError(
    `Mock 未实现: ${m} ${path}`,
    "NOT_IMPLEMENTED",
    501,
  );
}

module.exports = { handle };
