const { request, getBase } = require("./request");

/**
 * Choose images and upload as base64 to API.
 * @param {number} count max remaining slots
 * @returns {Promise<string[]>} photo url paths
 */
function chooseAndUpload(count = 3) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: Math.min(count, 6),
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success(res) {
        const files = res.tempFiles || [];
        const oversized = files.find((f) => f.size > 2 * 1024 * 1024);
        if (oversized) {
          reject(new Error("单张图片不能超过 2MB，请压缩后重试"));
          return;
        }
        Promise.all(files.map((f) => uploadFilePath(f.tempFilePath)))
          .then(resolve)
          .catch(reject);
      },
      fail(err) {
        if (err.errMsg && err.errMsg.includes("cancel")) {
          resolve([]);
          return;
        }
        // fallback older API
        wx.chooseImage({
          count: Math.min(count, 6),
          sizeType: ["compressed"],
          sourceType: ["album", "camera"],
          success(r) {
            Promise.all((r.tempFilePaths || []).map(uploadFilePath))
              .then(resolve)
              .catch(reject);
          },
          fail: () => reject(new Error("选择图片失败")),
        });
      },
    });
  });
}

function uploadFilePath(filePath) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath,
      encoding: "base64",
      success: async (res) => {
        try {
          const mime = guessMime(filePath);
          const data = await request({
            url: "/api/v1/uploads/photo",
            method: "POST",
            data: { data: res.data, mime },
          });
          resolve(data.url);
        } catch (e) {
          reject(e);
        }
      },
      fail: () => reject(new Error("读取图片失败")),
    });
  });
}

function guessMime(p) {
  const lower = (p || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function fullUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return getBase() + path;
}

const STATUS_LABEL = {
  not_started: "未开始",
  in_progress: "作答中",
  submitted: "待批改",
  pending_correction: "待订正",
  completed: "已完成",
  resubmit_required: "需重交",
  draft: "草稿",
  published: "已发布",
  revoked: "已下架",
};

const RESULT_LABEL = {
  correct: "正确",
  partial: "部分正确",
  incorrect: "错误",
};

module.exports = {
  chooseAndUpload,
  fullUrl,
  STATUS_LABEL,
  RESULT_LABEL,
};
