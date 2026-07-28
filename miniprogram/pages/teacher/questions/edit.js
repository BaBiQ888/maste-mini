const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");

Page({
  data: {
    id: "",
    type: "fill_blank",
    types: [
      { id: "fill_blank", label: "填空" },
      { id: "choice", label: "选择" },
      { id: "true_false", label: "判断" },
    ],
    stem: "",
    answer: "",
    explanation: "",
    knowledgeNodeId: "",
    optA: "",
    optB: "",
    optC: "",
    optD: "",
    choiceAnswer: "a",
    tfAnswer: true,
    loading: false,
  },

  onLoad(q) {
    if (q.id) this.setData({ id: q.id });
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user || user.role !== "teacher") {
      routeByUser(user);
      return;
    }
    if (this.data.id) this.load();
  },

  async load() {
    try {
      const data = await request({
        url: `/api/v1/questions/${this.data.id}`,
        method: "GET",
      });
      const q = data.question;
      const patch = {
        type: q.type,
        stem: q.stem,
        explanation: q.explanation || "",
        knowledgeNodeId: q.knowledgeNodeId || "",
      };
      if (q.type === "fill_blank") {
        patch.answer = String(q.answer);
      } else if (q.type === "true_false") {
        patch.tfAnswer = !!q.answer;
      } else if (q.type === "choice") {
        const opts = q.options || [];
        patch.optA = (opts[0] && opts[0].text) || "";
        patch.optB = (opts[1] && opts[1].text) || "";
        patch.optC = (opts[2] && opts[2].text) || "";
        patch.optD = (opts[3] && opts[3].text) || "";
        patch.choiceAnswer = q.answer || "a";
      }
      this.setData(patch);
    } catch (e) {
      showError(e, { fallback: "加载失败" });
    }
  },

  pickType(e) {
    this.setData({ type: e.currentTarget.dataset.id });
  },
  onStem(e) {
    this.setData({ stem: e.detail.value });
  },
  onAnswer(e) {
    this.setData({ answer: e.detail.value });
  },
  onExpl(e) {
    this.setData({ explanation: e.detail.value });
  },
  onKnowledge(e) {
    this.setData({ knowledgeNodeId: e.detail.value });
  },
  onOptA(e) {
    this.setData({ optA: e.detail.value });
  },
  onOptB(e) {
    this.setData({ optB: e.detail.value });
  },
  onOptC(e) {
    this.setData({ optC: e.detail.value });
  },
  onOptD(e) {
    this.setData({ optD: e.detail.value });
  },
  pickChoiceAns(e) {
    this.setData({ choiceAnswer: e.currentTarget.dataset.id });
  },
  pickTf(e) {
    this.setData({ tfAnswer: e.currentTarget.dataset.v === "1" });
  },

  buildPayload() {
    const stem = (this.data.stem || "").trim();
    if (!stem) throw new Error("请填写题干");
    const base = {
      type: this.data.type,
      stem,
      explanation: (this.data.explanation || "").trim() || null,
      knowledgeNodeId: (this.data.knowledgeNodeId || "").trim() || null,
    };
    if (this.data.type === "fill_blank") {
      const answer = (this.data.answer || "").trim();
      if (!answer) throw new Error("请填写答案");
      return { ...base, answer };
    }
    if (this.data.type === "true_false") {
      return { ...base, answer: this.data.tfAnswer };
    }
    const texts = [
      this.data.optA,
      this.data.optB,
      this.data.optC,
      this.data.optD,
    ]
      .map((t) => (t || "").trim())
      .filter(Boolean);
    if (texts.length < 2) throw new Error("至少 2 个选项");
    const options = texts.map((text, i) => ({
      id: String.fromCharCode(97 + i),
      text,
    }));
    const choiceAnswer = this.data.choiceAnswer;
    if (!options.some((o) => o.id === choiceAnswer)) {
      throw new Error("请选择正确答案");
    }
    return { ...base, options, answer: choiceAnswer };
  },

  async save() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const payload = this.buildPayload();
      if (this.data.id) {
        await request({
          url: `/api/v1/questions/${this.data.id}`,
          method: "PATCH",
          data: payload,
        });
      } else {
        await request({
          url: "/api/v1/questions",
          method: "POST",
          data: payload,
        });
      }
      wx.showToast({ title: "已保存", icon: "success" });
      setTimeout(() => wx.navigateBack(), 400);
    } catch (e) {
      showError(e, { fallback: "保存失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
