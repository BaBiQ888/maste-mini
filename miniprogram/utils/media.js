const { request, getBase } = require("./request");
const { getToken } = require("./auth");
const { toUserError, logError } = require("./errors");

/** In-memory path → local file for this session */
const imageLocalCache = Object.create(null);

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
          logError("media.upload", e, { filePath });
          reject(e);
        }
      },
      fail: (err) => {
        logError("media.readFile", err, { filePath });
        reject(
          toUserError(err, {
            code: "INVALID_PHOTOS",
            rawMessage: (err && err.errMsg) || "读取图片失败",
            fallback: "读取图片失败，请换一张再试",
          }),
        );
      },
    });
  });
}

function guessMime(p) {
  const lower = (p || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function isLocalOrRemoteDisplayable(path) {
  if (!path) return false;
  if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) {
    return true;
  }
  // WeChat temp / user files
  if (
    path.indexOf("wxfile://") === 0 ||
    path.indexOf("http://tmp") === 0 ||
    path.indexOf("wx://") === 0
  ) {
    return true;
  }
  // Absolute device path (chooseAvatar temp)
  if (path.indexOf("/") === 0 && path.indexOf("/uploads/") !== 0) {
    return true;
  }
  return false;
}

/**
 * Sync URL builder for public HTTPS.
 * Prefer resolveImageSrc for /uploads/* — public domain often returns INVALID_HOST
 * and <image> cannot send Authorization.
 */
function fullUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  let url = "";
  try {
    const app = getApp();
    if (app && app.globalData && app.globalData.useCloud) {
      const base =
        app.globalData.cloudPublicBase ||
        app.globalData.apiBase ||
        "";
      url = base.replace(/\/$/, "") + path;
    }
  } catch (_) {
    /* ignore */
  }
  if (!url) url = getBase() + path;
  // /uploads/* requires session; <image> cannot send Authorization header
  if (path.indexOf("/uploads/") === 0) {
    const token = getToken();
    if (token && url.indexOf("access_token=") < 0) {
      const sep = url.indexOf("?") >= 0 ? "&" : "?";
      url = url + sep + "access_token=" + encodeURIComponent(token);
    }
  }
  return url;
}

function cacheKeyForUpload(path) {
  return String(path || "").split("?")[0];
}

function localCachePath(filename) {
  const root =
    (typeof wx !== "undefined" && wx.env && wx.env.USER_DATA_PATH) ||
    "";
  if (!root) return "";
  return root + "/mm_upload_" + filename;
}

/**
 * Resolve a stored path to something <image src> can load.
 * /uploads/* → fetch via authenticated API (callContainer) → write local file.
 * @param {string} path
 * @returns {Promise<string>}
 */
function resolveImageSrc(path) {
  if (!path) return Promise.resolve("");
  if (isLocalOrRemoteDisplayable(path)) {
    return Promise.resolve(path);
  }

  const key = cacheKeyForUpload(path);
  if (key.indexOf("/uploads/") !== 0) {
    return Promise.resolve(fullUrl(path));
  }

  if (imageLocalCache[key]) {
    return Promise.resolve(imageLocalCache[key]);
  }

  const filename = key.split("/").pop() || "img.jpg";
  const localPath = localCachePath(filename);

  return new Promise((resolve) => {
    const fs = wx.getFileSystemManager();

    const finish = (local) => {
      if (local) imageLocalCache[key] = local;
      resolve(local || "");
    };

    const fetchAndWrite = () => {
      request({
        url:
          "/api/v1/uploads/content?path=" + encodeURIComponent(key),
        method: "GET",
      })
        .then((data) => {
          if (!data || !data.data) {
            finish("");
            return;
          }
          if (!localPath) {
            // No USER_DATA_PATH — last resort data URL (may be large)
            finish("data:" + (data.mime || "image/jpeg") + ";base64," + data.data);
            return;
          }
          try {
            fs.writeFile({
              filePath: localPath,
              data: data.data,
              encoding: "base64",
              success: () => finish(localPath),
              fail: (err) => {
                logError("media.writeImage", err, { localPath, key });
                finish(
                  "data:" + (data.mime || "image/jpeg") + ";base64," + data.data,
                );
              },
            });
          } catch (e) {
            logError("media.writeImage", e, { localPath, key });
            finish("");
          }
        })
        .catch((e) => {
          logError("media.resolveImage", e, { path: key });
          finish("");
        });
    };

    if (!localPath) {
      fetchAndWrite();
      return;
    }

    try {
      fs.access({
        path: localPath,
        success: () => finish(localPath),
        fail: () => fetchAndWrite(),
      });
    } catch (_) {
      fetchAndWrite();
    }
  });
}

/**
 * @param {string[]} paths
 * @returns {Promise<string[]>}
 */
function resolveImageSrcs(paths) {
  const list = Array.isArray(paths) ? paths : [];
  return Promise.all(list.map((p) => resolveImageSrc(p)));
}

/** Human label for assignment type (lists / cards) */
function assignmentTypeLabel(type) {
  const map = {
    photo_homework: "拍照",
    knowledge_checkin: "打卡",
    daily_drill: "每日计算",
  };
  return map[type] || "练习";
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
  resolveImageSrc,
  resolveImageSrcs,
  assignmentTypeLabel,
  STATUS_LABEL,
  RESULT_LABEL,
};
