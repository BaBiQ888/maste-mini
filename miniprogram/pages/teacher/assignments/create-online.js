const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { getCurrentClassId } = require("../../../utils/class-context");
const { showError } = require("../../../utils/errors");
const { attachKnowledgeLabels } = require("../../../utils/knowledge");

const TYPE_LABEL = {
  fill_blank: "填空",
  choice: "选择",
  true_false: "判断",
};

Page({
  data: {
    classes: [],
    classId: "",
    className: "请选择班级",
    title: "",
    asgType: "daily_drill",
    asgTypes: [
      { id: "daily_drill", label: "每日计算（选题）" },
      { id: "knowledge_checkin", label: "知识点打卡（选题）" },
    ],
    questions: [],
    selected: {},
    selectedCount: 0,
    typeLabels: TYPE_LABEL,
    loading: false,
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
      const questions = await attachKnowledgeLabels(qs.questions || []);
      this.setData({
        classes,
        classId: found ? found.id : "",
        className: found ? found.name : "请选择班级",
        questions,
      });
    } catch (e) {
      showError(e, { fallback: "加载失败" });
    }
  },

  pickClass() {
    if (!this.data.classes.length) {
      wx.showToast({ title: "请先创建班级", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: this.data.classes.map((c) => c.name),
      success: (res) => {
        const c = this.data.classes[res.tapIndex];
        this.setData({ classId: c.id, className: c.name });
      },
    });
  },

  pickAsgType(e) {
    this.setData({ asgType: e.currentTarget.dataset.id });
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id;
    const selected = { ...this.data.selected };
    if (selected[id]) delete selected[id];
    else selected[id] = true;
    this.setData({
      selected,
      selectedCount: Object.keys(selected).length,
    });
  },

  goQuestionBank() {
    wx.navigateTo({ url: "/pages/teacher/questions/list" });
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
    const questionIds = Object.keys(this.data.selected);
    if (!questionIds.length) {
      wx.showToast({ title: "请至少选题 1 道", icon: "none" });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = await request({
        url: "/api/v1/assignments",
        method: "POST",
        data: {
          classId: this.data.classId,
          type: this.data.asgType,
          title,
          questionIds,
          publish,
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
