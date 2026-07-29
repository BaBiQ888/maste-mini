const { request } = require("../../utils/request");
const { logError } = require("../../utils/errors");

const GRADES = [
  { grade: 3, label: "三" },
  { grade: 4, label: "四" },
  { grade: 5, label: "五" },
  { grade: 6, label: "六" },
];

Component({
  properties: {
    /** show sheet */
    show: {
      type: Boolean,
      value: false,
    },
    /** preselect knowledge node id */
    value: {
      type: String,
      value: "",
    },
    /** default grade tab */
    grade: {
      type: Number,
      value: 3,
    },
  },

  data: {
    grades: GRADES,
    activeGrade: 3,
    search: "",
    tree: [],
    draftId: "",
    draftName: "",
    draftPath: "",
    loading: false,
  },

  observers: {
    show(v) {
      if (v) {
        this.openSheet();
      }
    },
  },

  methods: {
    openSheet() {
      const g = this.properties.grade || 3;
      const value = this.properties.value || "";
      this.setData({
        activeGrade: g,
        search: "",
        draftId: value,
        draftName: "",
        draftPath: "",
      });
      this.loadTree(g).then(() => {
        if (value) this.syncDraftFromTree(value);
        else this.setData({ draftId: "", draftName: "", draftPath: "" });
      });
    },

    async loadTree(grade) {
      this.setData({ loading: true });
      try {
        const data = await request({
          url: `/api/v1/knowledge-nodes?tree=1&grade=${grade}`,
          method: "GET",
        });
        const draftId = this.data.draftId;
        const tree = (data.tree || []).map((block) => ({
          unit: block.unit,
          knowledge: (block.knowledge || []).map((k) => ({
            ...k,
            selected: k.id === draftId,
          })),
        }));
        this.setData({ tree, loading: false, activeGrade: grade });
      } catch (e) {
        this.setData({ loading: false, tree: [] });
        logError("knowledge-picker.loadTree", e, { grade });
        wx.showToast({ title: "知识树加载失败", icon: "none" });
      }
    },

    syncDraftFromTree(id) {
      for (const block of this.data.tree || []) {
        const unitName = (block.unit && block.unit.name) || "";
        for (const k of block.knowledge || []) {
          if (k.id === id) {
            this.setData({
              draftId: id,
              draftName: k.name || "",
              draftPath: unitName
                ? `${this.data.activeGrade}年级 · ${unitName}`
                : `${this.data.activeGrade}年级`,
            });
            return;
          }
        }
      }
      // fallback: fetch single node
      this.resolveNode(id);
    },

    async resolveNode(id) {
      if (!id) return;
      try {
        const data = await request({
          url: `/api/v1/knowledge-nodes/${encodeURIComponent(id)}`,
          method: "GET",
        });
        const n = data.node;
        if (!n) return;
        this.setData({
          draftId: n.id,
          draftName: n.name || "",
          draftPath: n.pathLabel || n.unitName || "",
        });
      } catch (e) {
        logError("knowledge-picker.resolve", e, { id });
      }
    },

    pickGrade(e) {
      const g = Number(e.currentTarget.dataset.grade);
      if (!g || g === this.data.activeGrade) return;
      this.setData({ search: "" });
      this.loadTree(g);
    },

    onSearch(e) {
      this.setData({ search: e.detail.value });
    },

    async doSearch() {
      const q = (this.data.search || "").trim();
      if (!q) {
        await this.loadTree(this.data.activeGrade);
        return;
      }
      this.setData({ loading: true });
      try {
        const data = await request({
          url: `/api/v1/knowledge-nodes?grade=${this.data.activeGrade}&type=knowledge&q=${encodeURIComponent(q)}`,
          method: "GET",
        });
        const draftId = this.data.draftId;
        this.setData({
          loading: false,
          tree: [
            {
              unit: { id: "search", name: "搜索结果" },
              knowledge: (data.nodes || []).map((k) => ({
                ...k,
                selected: k.id === draftId,
              })),
            },
          ],
        });
      } catch (e) {
        this.setData({ loading: false });
        logError("knowledge-picker.search", e, { q });
        wx.showToast({ title: "搜索失败", icon: "none" });
      }
    },

    pickKp(e) {
      const id = e.currentTarget.dataset.id;
      const name = e.currentTarget.dataset.name || "";
      const unit = e.currentTarget.dataset.unit || "";
      if (!id) return;
      const tree = (this.data.tree || []).map((block) => ({
        ...block,
        knowledge: (block.knowledge || []).map((k) => ({
          ...k,
          selected: k.id === id,
        })),
      }));
      this.setData({
        draftId: id,
        draftName: name,
        draftPath: unit
          ? `${this.data.activeGrade}年级 · ${unit}`
          : `${this.data.activeGrade}年级`,
        tree,
      });
    },

    onMask() {
      this.triggerEvent("close");
    },

    onCancel() {
      this.triggerEvent("close");
    },

    onClear() {
      this.setData({
        draftId: "",
        draftName: "",
        draftPath: "",
        tree: (this.data.tree || []).map((block) => ({
          ...block,
          knowledge: (block.knowledge || []).map((k) => ({
            ...k,
            selected: false,
          })),
        })),
      });
    },

    onConfirm() {
      const { draftId, draftName, draftPath } = this.data;
      this.triggerEvent("change", {
        id: draftId || "",
        name: draftName || "",
        pathLabel: draftPath || "",
      });
      this.triggerEvent("close");
    },

    noop() {},
  },
});
