/**
 * Student mastery / completion copy (S1). Keep low-pressure, paper-notebook tone.
 */

/**
 * @param {{ type?: string, knowledgePoints?: Array<{ name?: string }> } | null} assignment
 * @param {{ status?: string } | null} submission
 * @param {{ kind?: "complete" | "pending_correct" | "still_wrong" | "photo_submitted" }} opts
 */
function masteryHeadline(assignment, submission, opts) {
  const kind = (opts && opts.kind) || "complete";
  if (kind === "pending_correct") return "先订正标错的题";
  if (kind === "still_wrong") return "还差一点";
  if (kind === "photo_submitted") return "作业已交上";
  return "本页过关了";
}

/**
 * @param {{ type?: string, knowledgePoints?: Array<{ name?: string }> } | null} assignment
 * @param {{ kind?: string }} opts
 */
function masteryLine(assignment, opts) {
  const kind = (opts && opts.kind) || "complete";
  if (kind === "pending_correct") {
    return "改对之后，这页才算真正完成。";
  }
  if (kind === "still_wrong") {
    return "再检查一遍标错的题，慢慢来。";
  }
  if (kind === "photo_submitted") {
    return "老师批改后你会在这里看到结果。";
  }
  const kps = (assignment && assignment.knowledgePoints) || [];
  const name = kps[0] && kps[0].name;
  if (name) return `${name}，今天过关了。`;
  if (assignment && assignment.type === "daily_drill") {
    return "今日计算，这页可以折角了。";
  }
  if (assignment && assignment.type === "photo_homework") {
    return "书面作业已完成。";
  }
  return "这页可以折角了。";
}

/**
 * Build success panel fields after submit / correct.
 * @param {object} params
 */
function buildSuccessPanel(params) {
  const assignment = params.assignment || null;
  const submission = params.submission || null;
  const scoreBefore =
    params.scoreBefore != null ? Number(params.scoreBefore) : null;
  const scoreAfter =
    submission && submission.score != null ? Number(submission.score) : null;
  const status = submission && submission.status;
  const streakDays =
    params.streakDays != null ? Number(params.streakDays) : null;

  let kind = "complete";
  if (status === "pending_correction") kind = "pending_correct";
  else if (status === "submitted") kind = "photo_submitted";
  else if (status !== "completed" && status !== "submitted") {
    if (params.forceWrong) kind = "still_wrong";
  }

  const wrongCount = (params.items || []).filter(
    (it) => it.isCorrect === false,
  ).length;

  let scoreText = "";
  if (kind === "complete" && scoreAfter != null) {
    if (scoreBefore != null && scoreBefore !== scoreAfter) {
      scoreText = `正确率 ${scoreBefore}% → ${scoreAfter}%`;
    } else {
      scoreText = `正确率 ${scoreAfter}%`;
    }
  } else if (kind === "pending_correct" && scoreAfter != null) {
    scoreText =
      wrongCount > 0
        ? `正确率 ${scoreAfter}% · ${wrongCount} 题待订正`
        : `正确率 ${scoreAfter}%`;
  } else if (kind === "still_wrong" && scoreAfter != null) {
    scoreText =
      wrongCount > 0
        ? `仍有 ${wrongCount} 题 · 正确率 ${scoreAfter}%`
        : `正确率 ${scoreAfter}%`;
  }

  let streakText = "";
  if (kind === "complete" && streakDays != null && streakDays > 0) {
    streakText =
      streakDays === 1
        ? "今天点亮了一格"
        : `连续点亮 ${streakDays} 天`;
  }

  return {
    show: true,
    kind,
    headline: masteryHeadline(assignment, submission, { kind }),
    line: masteryLine(assignment, { kind }),
    scoreText,
    streakText,
    isComplete: kind === "complete",
  };
}

module.exports = {
  masteryHeadline,
  masteryLine,
  buildSuccessPanel,
};
