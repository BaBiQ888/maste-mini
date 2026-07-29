const { request, getBase, useMockData, useCloudCall } = require("./request");
const { getToken } = require("./auth");
const { toUserError, logError } = require("./errors");

/** In-memory path → local file for this session (legacy /uploads only) */
const imageLocalCache = Object.create(null);

/**
 * Choose images and upload.
 * Prefers 云托管对象存储 (wx.cloud.uploadFile); falls back to API base64.
 * @param {number} count max remaining slots
 * @returns {Promise<string[]>} photo urls (cloud:// fileID or /uploads/...)
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
        Promise.all(files.map((f) => uploadFilePath(f.tempFilePath, "homework")))
          .then(resolve)
          .catch(reject);
      },
      fail(err) {
        if (err.errMsg && err.errMsg.includes("cancel")) {
          resolve([]);
          return;
        }
        wx.chooseImage({
          count: Math.min(count, 6),
          sizeType: ["compressed"],
          sourceType: ["album", "camera"],
          success(r) {
            Promise.all(
              (r.tempFilePaths || []).map((p) => uploadFilePath(p, "homework")),
            )
              .then(resolve)
              .catch(reject);
          },
          fail: () => reject(new Error("选择图片失败")),
        });
      },
    });
  });
}

/**
 * @param {string} filePath local temp path
 * @param {"homework"|"avatars"} folder cloudPath prefix
 * @returns {Promise<string>} cloud fileID (or mock/API path only in mock mode)
 *
 * Production: cloud object storage only — no silent fallback (kept as
 * uploadViaApiBase64 for emergency re-enable). Failures surface to the UI
 * so we can diagnose COS / env / permission issues.
 */
function uploadFilePath(filePath, folder) {
  const kind = folder === "avatars" ? "avatars" : "homework";

  // Local mock has no COS bucket — keep API mock path only for useMockData
  if (useMockData()) {
    return uploadViaApiBase64(filePath);
  }

  return tryCloudUpload(filePath, kind).catch((cloudErr) => {
    const raw =
      (cloudErr && (cloudErr.errMsg || cloudErr.message || String(cloudErr))) ||
      "unknown";
    logError("media.cloudUpload", cloudErr, {
      filePath,
      kind,
      cloudEnv: getCloudEnv(),
      useCloud: true,
      raw,
      errCode: cloudErr && (cloudErr.errCode || cloudErr.code),
    });
    // Intentionally NOT falling back to uploadViaApiBase64 — surface failure.
    // To re-enable container disk fallback temporarily, replace the throw below with:
    //   return uploadViaApiBase64(filePath);
    return Promise.reject(
      toUserError(cloudErr, {
        code: "CLOUD_UPLOAD",
        rawMessage: raw,
        fallback: "对象存储上传失败：" + shortenUploadErr(raw),
      }),
    );
  });
}

/** Keep toast readable; full detail is already in console via logError */
function shortenUploadErr(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "请打开调试器 Console 查看 media.cloudUpload";
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function tryCloudUpload(filePath, kind) {
  if (!useCloudCall()) {
    return Promise.reject(
      new Error("useCloud=false，对象存储需开启云托管调用"),
    );
  }
  if (typeof wx === "undefined" || !wx.cloud) {
    return Promise.reject(new Error("wx.cloud 不可用（基础库/环境）"));
  }

  return ensureCloudReady()
    .then((cloudApi) => {
      if (!cloudApi || typeof cloudApi.uploadFile !== "function") {
        throw new Error("cloud.uploadFile 不可用（云初始化失败？）");
      }
      const env = getCloudEnv();
      if (!env) throw new Error("cloudEnv 未配置");

      const ext = guessExt(filePath);
      const cloudPath =
        kind +
        "/" +
        Date.now() +
        "_" +
        Math.random().toString(36).slice(2, 10) +
        "." +
        ext;

      console.info("[media.cloudUpload] start", { env, cloudPath, kind });

      return new Promise((resolve, reject) => {
        cloudApi.uploadFile({
          cloudPath,
          filePath,
          config: { env },
          success(res) {
            if (res && res.fileID) {
              console.info("[media.cloudUpload] ok", {
                fileID: res.fileID,
                cloudPath,
              });
              resolve(res.fileID);
              return;
            }
            reject(
              new Error(
                "uploadFile 成功但无 fileID: " + JSON.stringify(res || {}),
              ),
            );
          },
          fail(err) {
            console.error("[media.cloudUpload] fail", {
              env,
              cloudPath,
              errMsg: err && err.errMsg,
              errCode: err && err.errCode,
              err,
            });
            reject(err || new Error("uploadFile fail"));
          },
        });
      });
    });
}

function ensureCloudReady() {
  return new Promise((resolve) => {
    try {
      const app = getApp();
      if (app && typeof app.ensureCloud === "function") {
        app
          .ensureCloud()
          .then((c) => resolve(c || (app.globalData && app.globalData.cloud) || wx.cloud))
          .catch(() => resolve((app.globalData && app.globalData.cloud) || wx.cloud));
        return;
      }
      resolve((app && app.globalData && app.globalData.cloud) || wx.cloud);
    } catch (_) {
      resolve(wx.cloud);
    }
  });
}

function getCloudEnv() {
  try {
    const app = getApp();
    return (app && app.globalData && app.globalData.cloudEnv) || "";
  } catch (_) {
    return "";
  }
}

/**
 * Legacy: base64 → POST /api/v1/uploads/photo → container disk.
 * Kept for mock mode and emergency re-enable; production path does not call this.
 */
function uploadViaApiBase64(filePath) {
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

function guessExt(p) {
  const lower = (p || "").toLowerCase();
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".webp")) return "webp";
  return "jpg";
}

function isLocalOrRemoteDisplayable(path) {
  if (!path) return false;
  // Cloud object storage fileID — <image src> supports cloud://
  if (path.indexOf("cloud://") === 0) return true;
  if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) {
    return true;
  }
  if (
    path.indexOf("wxfile://") === 0 ||
    path.indexOf("http://tmp") === 0 ||
    path.indexOf("wx://") === 0
  ) {
    return true;
  }
  // Absolute device path (chooseAvatar temp), not legacy /uploads/
  if (path.indexOf("/") === 0 && path.indexOf("/uploads/") !== 0) {
    return true;
  }
  return false;
}

/**
 * Sync URL builder for public HTTPS (legacy).
 * Prefer resolveImageSrc for display.
 */
function fullUrl(path) {
  if (!path) return "";
  if (path.startsWith("http") || path.startsWith("cloud://")) return path;
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
 * - cloud:// → as-is (native component support)
 * - /uploads/* → authenticated API → local cache (legacy)
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
        url: "/api/v1/uploads/content?path=" + encodeURIComponent(key),
        method: "GET",
      })
        .then((data) => {
          if (!data || !data.data) {
            finish("");
            return;
          }
          if (!localPath) {
            finish(
              "data:" + (data.mime || "image/jpeg") + ";base64," + data.data,
            );
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
                  "data:" +
                    (data.mime || "image/jpeg") +
                    ";base64," +
                    data.data,
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
  uploadFilePath,
  fullUrl,
  resolveImageSrc,
  resolveImageSrcs,
  assignmentTypeLabel,
  STATUS_LABEL,
  RESULT_LABEL,
};
