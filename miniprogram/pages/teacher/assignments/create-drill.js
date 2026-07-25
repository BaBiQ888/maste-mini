const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { getCurrentClassId } = require("../../../utils/class-context");

Page({
  data: {
    classes: [],
    classId: "",
    className: "请选择班级",
    grade: 3,
    grades: [3, 4, 5, 6],
    operations: [],
    operationId: "",
    operationName: "请选择运算",
    count: 10,
    counts: [10, 15, 20, 30],
    difficulty: "normal",
    difficulties: [
      { id: "basic", label: "基础" },
      { id: "normal", label: "巩固" },
      { id: "challenge", label: "提高" },
    ],
    timeLimitSec: 0,
    timeOptions: [
      { sec: 0, label: "不限时" },
      { sec: 180, label: "3 分钟" },
      { sec: 300, label: "5 分钟" },
      { sec: 600, label: "10 分钟" },
    ],
    title: "",
    preview: [],
    seed: null,
    manuals: [],
    selectedManual: {},
    selectedManualCount: 0,
    loading: false,
    genBusy: false,
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
      const [cls, man] = await Promise.all([
        request({ url: "/api/v1/classes", method: "GET" }),
        request({ url: "/api/v1/questions", method: "GET" }),
      ]);
      const classes = cls.classes || [];
      let classId = getCurrentClassId() || "";
      const found = classes.find((c) => c.id === classId);
      const grade = found ? found.grade : 3;
      this.setData({
        classes,
        classId: found ? found.id : "",
        className: found ? found.name : "请选择班级",
        grade,
        manuals: man.questions || [],
        title: found ? `${found.name} · 每日计算` : "每日计算",
      });
      await this.loadOps(grade);
    } catch (e) {
      wx.showToast({ title: e.message || "加载失败", icon: "none" });
    }
  },

  async loadOps(grade) {
    const data = await request({
      url: `/api/v1/drill/operations?grade=${grade}`,
      method: "GET",
    });
    const operations = data.operations || [];
    const first = operations[0];
    this.setData({
      operations,
      operationId: first ? first.id : "",
      operationName: first ? first.name : "请选择运算",
      preview: [],
      seed: null,
    });
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
          title: `${c.name} · 每日计算`,
        });
        await this.loadOps(c.grade);
      },
    });
  },

  pickOp() {
    if (!this.data.operations.length) {
      wx.showToast({ title: "无可用运算", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: this.data.operations.map((o) => o.name),
      success: (res) => {
        const o = this.data.operations[res.tapIndex];
        this.setData({
          operationId: o.id,
          operationName: o.name,
          preview: [],
          seed: null,
        });
      },
    });
  },

  pickCount(e) {
    this.setData({ count: Number(e.currentTarget.dataset.n), preview: [] });
  },

  pickDiff(e) {
    this.setData({ difficulty: e.currentTarget.dataset.id, preview: [] });
  },

  pickTime(e) {
    this.setData({ timeLimitSec: Number(e.currentTarget.dataset.sec) });
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  toggleManual(e) {
    const id = e.currentTarget.dataset.id;
    const selectedManual = { ...this.data.selectedManual };
    if (selectedManual[id]) delete selectedManual[id];
    else selectedManual[id] = true;
    this.setData({
      selectedManual,
      selectedManualCount: Object.keys(selectedManual).length,
    });
  },

  async regenerate() {
    if (!this.data.operationId) {
      wx.showToast({ title: "请选择运算", icon: "none" });
      return;
    }
    this.setData({ genBusy: true });
    try {
      const data = await request({
        url: "/api/v1/questions/generate",
        method: "POST",
        data: {
          operationId: this.data.operationId,
          count: this.data.count,
          difficulty: this.data.difficulty,
        },
      });
      this.setData({
        preview: data.questions || [],
        seed: data.seed,
        genBusy: false,
      });
      wx.showToast({ title: `已生成 ${data.questions.length} 题`, icon: "none" });
    } catch (e) {
      this.setData({ genBusy: false });
      wx.showToast({ title: e.message || "生成失败", icon: "none" });
    }
  },

  async submit(publish) {
    if (this.data.loading) return;
    if (!this.data.classId) {
      wx.showToast({ title: "请选择班级", icon: "none" });
      return;
    }
    const title = (this.data.title || "").trim();
    if (!title) {
      wx.showToast({ title: "请填写标题", icon: "none" });
      return;
    }
    if (!this.data.preview.length) {
      wx.showToast({ title: "请先生成题目", icon: "none" });
      return;
    }
    this.setData({ loading: true });
    try {
      const questionIds = Object.keys(this.data.selectedManual);
      const data = await request({
        url: "/api/v1/assignments",
        method: "POST",
        data: {
          classId: this.data.classId,
          type: "daily_drill",
          title,
          publish,
          generatedSnapshots: this.data.preview.map((q) => ({
            type: q.type || "fill_blank",
            stem: q.stem,
            options: q.options || null,
            answer: q.answer,
            explanation: q.explanation || null,
            knowledgeNodeId: q.knowledgeNodeId || null,
            source: "generated",
          })),
          questionIds: questionIds.length ? questionIds : undefined,
          config: {
            operationId: this.data.operationId,
            count: this.data.count,
            difficulty: this.data.difficulty,
            timeLimitSec: this.data.timeLimitSec || null,
            seed: this.data.seed,
          },
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
      wx.showToast({ title: e.message || "失败", icon: "none" });
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
