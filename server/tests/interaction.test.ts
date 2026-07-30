import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

async function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-ix-"));
  const db = await openDatabase(":memory:");
  const app = createApp(db, {
    wechat: { appId: "", appSecret: "", mock: true },
    dataDir,
  });
  return { app, db };
}

async function loginAs(
  app: Awaited<ReturnType<typeof testApp>>["app"],
  code: string,
  role: "teacher" | "student",
  nickname: string,
) {
  const login = await (
    await app.request("/api/v1/auth/wechat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, nickname }),
    })
  ).json();
  await app.request("/api/v1/me", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${login.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role,
      nickname,
      ...(role === "teacher" ? { teacherCode: "SUANBEN-TEACHER" } : {}),
    }),
  });
  return { token: login.token as string, userId: login.user.id as string };
}

function auth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("Teacher-student interactions", () => {
  let app: Awaited<ReturnType<typeof testApp>>["app"];

  beforeEach(async () => {
    app = (await testApp()).app;
  });

  async function setupClass() {
    const teacher = await loginAs(app, "ixt", "teacher", "王老师");
    const student = await loginAs(app, "ixs", "student", "小明");
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "互动班", grade: 3 }),
      })
    ).json();
    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: cls.class.inviteCode }),
    });
    const q = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "2+2=",
          answer: "4",
        }),
      })
    ).json();
    const asg = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "daily_drill",
          title: "互动卷",
          questionIds: [q.question.id],
          publish: true,
          config: { requireCorrection: true, allowStuckReport: true },
        }),
      })
    ).json();
    const mine = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    const qs = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/questions`, {
        headers: auth(teacher.token),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [
          { assignmentQuestionId: qs.questions[0].id, response: "9" },
        ],
      }),
    });
    return {
      teacher,
      student,
      cls: cls.class,
      asg: asg.assignment,
      submissionId: mine.submission.id as string,
      aqId: qs.questions[0].id as string,
    };
  }

  it("teacher stamps student submission; student can list stamps", async () => {
    const { teacher, student, submissionId } = await setupClass();
    const res = await app.request(`/api/v1/submissions/${submissionId}/stamps`, {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ stampType: "progress", note: "进位有进步" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.stamp.label).toBe("进步");

    const bySub = await (
      await app.request(`/api/v1/submissions/${submissionId}/stamps`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(bySub.stamps.length).toBeGreaterThanOrEqual(1);

    const other = await loginAs(app, "ixs2", "student", "路人");
    const denied = await app.request(
      `/api/v1/submissions/${submissionId}/stamps`,
      { headers: auth(other.token) },
    );
    expect(denied.status).toBe(403);

    const mine = await (
      await app.request("/api/v1/me/stamps", {
        headers: auth(student.token),
      })
    ).json();
    expect(mine.stamps.length).toBeGreaterThanOrEqual(1);
    expect(mine.stamps[0].stampType).toBe("progress");
  });

  it("stuck report and teacher reply reaches student inbox", async () => {
    const { teacher, student, submissionId, aqId, cls } = await setupClass();
    const rep = await (
      await app.request(`/api/v1/submissions/${submissionId}/stuck`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          assignmentQuestionId: aqId,
          note: "进位不会",
        }),
      })
    ).json();
    expect(rep.report.status).toBe("open");

    // foreign question id rejected
    const badAq = await app.request(
      `/api/v1/submissions/${submissionId}/stuck`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          assignmentQuestionId: "aq_not_exists_xxx",
          note: "x",
        }),
      },
    );
    expect(badAq.status).toBe(400);

    const list = await (
      await app.request(`/api/v1/classes/${cls.id}/stuck-reports?status=open`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(list.reports.length).toBe(1);

    const replied = await (
      await app.request(`/api/v1/stuck-reports/${rep.report.id}/reply`, {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ reply: "先算个位再进位" }),
      })
    ).json();
    expect(replied.report.status).toBe("resolved");
    expect(replied.report.teacherReply).toContain("进位");

    const studentInbox = await (
      await app.request("/api/v1/me/stuck-reports", {
        headers: auth(student.token),
      })
    ).json();
    expect(
      studentInbox.reports.some(
        (r: { teacherReply?: string }) =>
          r.teacherReply && r.teacherReply.includes("进位"),
      ),
    ).toBe(true);
  });

  it("class focus and notes and week share", async () => {
    const { teacher, student, cls } = await setupClass();
    const focus = await (
      await app.request(`/api/v1/classes/${cls.id}/focus`, {
        method: "PUT",
        headers: auth(teacher.token),
        body: JSON.stringify({ label: "两位数进位加法", note: "先看个位" }),
      })
    ).json();
    expect(focus.focus.label).toContain("进位");

    const studentFocus = await (
      await app.request("/api/v1/me/class-focus", {
        headers: auth(student.token),
      })
    ).json();
    expect(studentFocus.items.length).toBeGreaterThanOrEqual(1);

    await app.request(`/api/v1/classes/${cls.id}/notes`, {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ body: "今晚记得订正哦", studentId: student.userId }),
    });
    const notes = await (
      await app.request("/api/v1/me/notes", {
        headers: auth(student.token),
      })
    ).json();
    expect(notes.notes.some((n: { body: string }) => n.body.includes("订正"))).toBe(
      true,
    );

    const share = await (
      await app.request("/api/v1/me/week-share", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          classId: cls.id,
          weekLabel: "本周",
          copyText: "完成 3 次练习",
        }),
      })
    ).json();
    expect(share.share.id).toBeTruthy();

    const shares = await (
      await app.request(`/api/v1/classes/${cls.id}/week-shares`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(shares.shares.length).toBe(1);

    await app.request(`/api/v1/week-shares/${share.share.id}/reply`, {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ reply: "下周重点练退位" }),
    });
    const replies = await (
      await app.request("/api/v1/me/week-share-replies", {
        headers: auth(student.token),
      })
    ).json();
    expect(replies.replies[0].teacherReply).toContain("退位");
  });

  it("layered reminder and top wrongs and map progress", async () => {
    const { teacher, asg, cls } = await setupClass();
    const layered = await (
      await app.request(
        `/api/v1/assignments/${asg.id}/reminder-text?layered=1`,
        { headers: auth(teacher.token) },
      )
    ).json();
    expect(layered.text).toContain("分层催交");
    expect(layered.layers).toBeTruthy();

    const top = await (
      await app.request(`/api/v1/assignments/${asg.id}/top-wrongs`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(top.questions.length).toBeGreaterThanOrEqual(1);

    const map = await (
      await app.request(`/api/v1/classes/${cls.id}/map-progress`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(map.progress.studentCount).toBe(1);
  });

  it("teacher badge and variant drill + student inbox ack", async () => {
    const { teacher, student, asg, submissionId, aqId, cls } =
      await setupClass();
    await app.request(`/api/v1/submissions/${submissionId}/stuck`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ assignmentQuestionId: aqId, note: "不会" }),
    });
    const badge = await (
      await app.request(
        `/api/v1/me/interaction-badge?classId=${cls.id}`,
        { headers: auth(teacher.token) },
      )
    ).json();
    expect(badge.badge.total).toBeGreaterThanOrEqual(1);
    expect(badge.badge.stuckOpen).toBeGreaterThanOrEqual(1);
    expect(badge.badge.classId).toBe(cls.id);

    const variant = await app.request(
      `/api/v1/assignments/${asg.id}/variant-drill`,
      {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ count: 6, publish: true }),
      },
    );
    expect(variant.status).toBe(201);
    const vbody = await variant.json();
    expect(vbody.assignment.type).toBe("daily_drill");
    expect(vbody.assignment.title).toContain("变式");
    expect(vbody.assignment.status).toBe("published");
    expect((vbody.assignment.questionCount || 0) >= 1).toBe(true);

    await app.request(`/api/v1/submissions/${submissionId}/stamps`, {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ stampType: "careful" }),
    });
    const sBadge = await (
      await app.request("/api/v1/me/interaction-badge", {
        headers: auth(student.token),
      })
    ).json();
    expect(sBadge.badge.total).toBeGreaterThanOrEqual(1);

    const inbox = await (
      await app.request("/api/v1/me/inbox", {
        headers: auth(student.token),
      })
    ).json();
    expect(inbox.items.length).toBeGreaterThanOrEqual(1);

    await app.request("/api/v1/me/inbox/ack", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({}),
    });
    const afterAck = await (
      await app.request("/api/v1/me/interaction-badge", {
        headers: auth(student.token),
      })
    ).json();
    expect(afterAck.badge.total).toBe(0);

    const studentHome = await (
      await app.request("/api/v1/me/student-home", {
        headers: auth(student.token),
      })
    ).json();
    expect(studentHome.home.badge).toBeTruthy();
    expect(Array.isArray(studentHome.home.focus)).toBe(true);
    expect(Array.isArray(studentHome.home.preview)).toBe(true);
  });
});
