const { getToken, getUser, routeByUser } = require("../../../utils/auth");
const { request } = require("../../../utils/request");
const { showError } = require("../../../utils/errors");
const {
  chooseAndUpload,
  resolveImageSrcs,
  STATUS_LABEL,
  RESULT_LABEL,
} = require("../../../utils/media");
const { buildSuccessPanel } = require("../../../utils/mastery-copy");

Page({
  data: {
    id: "",
    assignment: null,
    submission: null,
    localUrls: [],
    displayUrls: [],
    loading: true,
    loadError: false,
    busy: false,
    statusLabels: STATUS_LABEL,
    resultLabels: RESULT_LABEL,
    canEdit: false,
    success: null,
  },

  _bootstrapped: false,

  onLoad(q) {
    this._bootstrapped = false;
    this.setData({ id: q.id || "" });
  },

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const user = getUser();
    if (!user || user.role !== "student") {
      routeByUser(user);
      return;
    }
    // Preserve local photo picks / success overlay across resume
    if (
      this._bootstrapped &&
      !this.data.loadError &&
      this.data.submission &&
      (this.data.canEdit || this.data.success)
    ) {
      return;
    }
    if (this.data.id) this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    try {
      const [a, s] = await Promise.all([
        request({ url: `/api/v1/assignments/${this.data.id}`, method: "GET" }),
        request({
          url: `/api/v1/assignments/${this.data.id}/my-submission`,
          method: "GET",
        }),
      ]);
      const submission = s.submission;
      const localUrls = (submission.photos || []).map((p) => p.url);
      // Freeze after submit — only first attempt or teacher-required resubmit
      const canEdit =
        submission.status === "not_started" ||
        submission.status === "resubmit_required";
      const displayUrls = await resolveImageSrcs(localUrls);
      this._bootstrapped = true;
      this.setData({
        assignment: a.assignment,
        submission,
        localUrls,
        displayUrls,
        canEdit,
        loading: false,
        loadError: false,
      });
    } catch (e) {
      this._bootstrapped = false;
      this.setData({ loading: false, loadError: true });
      showError(e, { fallback: "加载失败" });
    }
  },

  async addPhotos() {
    if (!this.data.canEdit || this.data.busy) return;
    const remain = 6 - this.data.localUrls.length;
    if (remain <= 0) {
      wx.showToast({ title: "最多 6 张", icon: "none" });
      return;
    }
    this.setData({ busy: true });
    try {
      const urls = await chooseAndUpload(remain);
      if (!urls.length) {
        this.setData({ busy: false });
        return;
      }
      const localUrls = this.data.localUrls.concat(urls);
      const displayUrls = await resolveImageSrcs(localUrls);
      this.setData({
        localUrls,
        displayUrls,
        busy: false,
      });
    } catch (e) {
      this.setData({ busy: false });
      showError(e, { fallback: "上传失败" });
    }
  },

  async removePhoto(e) {
    if (!this.data.canEdit) return;
    const idx = e.currentTarget.dataset.index;
    const localUrls = this.data.localUrls.slice();
    localUrls.splice(idx, 1);
    const displayUrls = await resolveImageSrcs(localUrls);
    this.setData({
      localUrls,
      displayUrls,
    });
  },

  preview(e) {
    wx.previewImage({
      urls: this.data.displayUrls,
      current: e.currentTarget.dataset.src,
    });
  },

  async submit() {
    if (!this.data.canEdit || this.data.busy) return;
    if (!this.data.localUrls.length) {
      wx.showToast({ title: "请先添加照片", icon: "none" });
      return;
    }
    this.setData({ busy: true });
    try {
      const data = await request({
        url: `/api/v1/submissions/${this.data.submission.id}/photos`,
        method: "POST",
        data: { photoUrls: this.data.localUrls },
      });
      const submission = data.submission;
      const localUrls = (submission.photos || []).map((p) => p.url);
      const displayUrls = await resolveImageSrcs(localUrls);
      const success = buildSuccessPanel({
        assignment: this.data.assignment,
        submission,
        items: [],
      });
      this.setData({
        submission,
        localUrls,
        displayUrls,
        canEdit:
          submission.status === "not_started" ||
          submission.status === "resubmit_required",
        busy: false,
        success,
      });
    } catch (e) {
      this.setData({ busy: false });
      showError(e, { fallback: "提交失败" });
    }
  },

  goHome() {
    wx.reLaunch({ url: "/pages/student/home/home" });
  },

  dismissSuccess() {
    this.setData({ success: null });
  },
});
