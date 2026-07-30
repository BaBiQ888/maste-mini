const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { getCurrentClassId } = require("../../../utils/class-context");
const { showError } = require("../../../utils/errors");
const { attachKnowledgeLabels } = require("../../../utils/knowledge");

Page({
  data: {
    classes: [],
    classId: "",
    className: "请选择班级",
    grade: 3,
    title: "",
    tree: [],
    selectedKp: {},
    selectedKpCount: 0,
    questions: [],
    selectedQ: {},
    selectedQCount: 0,
    search: "",
    loading: false,
    /** Field-level validation messages (shown near inputs) */
    errors: {
      classId: "",
      title: "",
      knowledge: "",
      questions: "",
    },
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
    this.bootstrap();
  },

  async bootstrap() {
    try {
      const [cls, qs] = await Promise.all([
        request({ url: "/api/v1/classes", method: "GET" }),
        request({ url: "/api/v1/questions", method: "GET" }),
      ]);
      const classes = cls.classes || [];
      let classId = getCurrentClassId() || "";
      const found = classes.find((c) => c.id === classId);
      const grade = found ? found.grade : 3;
      const questions = await attachKnowledgeLabels(qs.questions || []);
      this.setData({
        classes,
        classId: found ? found.id : "",
        className: found ? found.name : "请选择班级",
        grade,
        title: found ? `${found.name} · 知识点打卡` : "知识点打卡",
        questions,
      });
      await this.loadTree(grade);
    } catch (e) {
      showError(e, { fallback: "加载失败" });
    }
  },

  async loadTree(grade) {
    const data = await request({
      url: `/api/v1/knowledge-nodes?tree=1&grade=${grade}`,
      method: "GET",
    });
    const tree = (data.tree || []).map((block) => ({
      ...block,
      unit: block.unit,
      knowledge: (block.knowledge || []).map((k) => ({
        ...k,
        selected: !!this.data.selectedKp[k.id],
      })),
    }));
    this.setData({ tree });
  },

  pickClass() {
    if (!this.data.classes.length) {
      wx.showToast({ title: "请先创建班级", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: this.data.classes.map((c) => `${c.name}（${c.grade}年级）`),
      success: async (res) => {
        const c = this.data.classes[res.tapIndex];
        this.setData({
          classId: c.id,
          className: c.name,
          grade: c.grade,
          title: `${c.name} · 知识点打卡`,
          selectedKp: {},
          selectedKpCount: 0,
          "errors.classId": "",
          "errors.title": "",
        });
        await this.loadTree(c.grade);
      },
    });
  },

  onTitle(e) {
    this.setData({
      title: e.detail.value,
      "errors.title": "",
    });
  },

  onSearch(e) {
    this.setData({ search: e.detail.value });
  },

  async doSearch() {
    const q = (this.data.search || "").trim();
    if (!q) {
      await this.loadTree(this.data.grade);
      return;
    }
    try {
      const data = await request({
        url: `/api/v1/knowledge-nodes?grade=${this.data.grade}&type=knowledge&q=${encodeURIComponent(q)}`,
        method: "GET",
      });
      // flatten search hits into one pseudo unit
      this.setData({
        tree: [
          {
            unit: { id: "search", name: "搜索结果" },
            knowledge: (data.nodes || []).map((k) => ({
              ...k,
              selected: !!this.data.selectedKp[k.id],
            })),
          },
        ],
      });
    } catch (e) {
      showError(e, { fallback: "搜索失败" });
    }
  },

  toggleKp(e) {
    const id = e.currentTarget.dataset.id;
    const selectedKp = { ...this.data.selectedKp };
    if (selectedKp[id]) delete selectedKp[id];
    else selectedKp[id] = true;
    const tree = this.data.tree.map((block) => ({
      ...block,
      knowledge: block.knowledge.map((k) => ({
        ...k,
        selected: !!selectedKp[k.id],
      })),
    }));
    this.setData({
      selectedKp,
      selectedKpCount: Object.keys(selectedKp).length,
      tree,
      "errors.knowledge": "",
    });
    this.filterQuestionsByKp(selectedKp);
  },

  filterQuestionsByKp(selectedKp) {
    // auto-select questions tagged with selected knowledge
    const ids = Object.keys(selectedKp);
    if (!ids.length) return;
    const selectedQ = { ...this.data.selectedQ };
    for (const q of this.data.questions) {
      if (q.knowledgeNodeId && selectedKp[q.knowledgeNodeId]) {
        selectedQ[q.id] = true;
      }
    }
    this.setData({
      selectedQ,
      selectedQCount: Object.keys(selectedQ).length,
    });
  },

  toggleQ(e) {
    const id = e.currentTarget.dataset.id;
    const selectedQ = { ...this.data.selectedQ };
    if (selectedQ[id]) delete selectedQ[id];
    else selectedQ[id] = true;
    this.setData({
      selectedQ,
      selectedQCount: Object.keys(selectedQ).length,
      "errors.questions": "",
    });
  },

  goQuestionBank() {
    wx.navigateTo({ url: "/pages/teacher/questions/list" });
  },

  /** Collect field errors; returns first toast message or "" if valid */
  validateForm() {
    const title = (this.data.title || "").trim();
    const knowledgeNodeIds = Object.keys(this.data.selectedKp);
    const questionIds = Object.keys(this.data.selectedQ);
    const errors = {
      classId: this.data.classId ? "" : "请选择班级",
      title: title ? "" : "请填写标题",
      knowledge: knowledgeNodeIds.length ? "" : "请选择知识点",
      questions: questionIds.length
        ? ""
        : "请选择题目（可先在题库挂知识点）",
    };
    this.setData({ errors });
    return (
      errors.classId ||
      errors.title ||
      errors.knowledge ||
      errors.questions ||
      ""
    );
  },

  async submit(publish) {
    if (this.data.loading) return;
    const firstErr = this.validateForm();
    if (firstErr) {
      wx.showToast({ title: firstErr, icon: "none" });
      return;
    }
    const title = (this.data.title || "").trim();
    const knowledgeNodeIds = Object.keys(this.data.selectedKp);
    const questionIds = Object.keys(this.data.selectedQ);
    this.setData({ loading: true });
    try {
      const data = await request({
        url: "/api/v1/assignments",
        method: "POST",
        data: {
          classId: this.data.classId,
          type: "knowledge_checkin",
          title,
          publish,
          questionIds,
          config: { knowledgeNodeIds },
        },
      });
      wx.showToast({
        title: publish ? "已发布" : "草稿已存",
        icon: "success",
      });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/teacher/assignments/detail?id=${data.assignment.id}`,
        });
      }, 400);
    } catch (e) {
      showError(e, { fallback: "布置失败，请稍后重试" });
    } finally {
      this.setData({ loading: false });
    }
  },

  saveDraft() {
    this.submit(false);
  },
  publishNow() {
    this.submit(true);
  },
});
