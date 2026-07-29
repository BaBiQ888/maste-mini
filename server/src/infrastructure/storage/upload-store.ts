import fs from "node:fs";
import path from "node:path";
import { createId } from "../persistence/db.js";
import { AppError } from "../../domain/shared/errors.js";

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export function ensureUploadDir(root: string): string {
  const dir = path.join(root, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveBase64Image(
  uploadDir: string,
  input: { data: string; mime?: string },
): { filename: string; urlPath: string; bytes: number } {
  let raw = input.data.trim();
  let mime = (input.mime || "image/jpeg").toLowerCase();

  const dataUrl = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUrl) {
    mime = dataUrl[1].toLowerCase();
    raw = dataUrl[2];
  }

  if (mime === "image/jpg") mime = "image/jpeg";
  if (!ALLOWED.has(mime)) {
    throw new AppError(
      "INVALID_IMAGE",
      "仅支持 JPG / PNG / WebP 图片",
    );
  }

  const buf = Buffer.from(raw, "base64");
  if (!buf.length) {
    throw new AppError("INVALID_IMAGE", "图片数据无效");
  }
  if (buf.length > MAX_BYTES) {
    throw new AppError("IMAGE_TOO_LARGE", "单张图片不能超过 2MB");
  }

  const ext =
    mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const filename = `${createId("img")}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), buf);
  return {
    filename,
    urlPath: `/uploads/${filename}`,
    bytes: buf.length,
  };
}

/** Safe upload basename: img_<hex>.(jpg|jpeg|png|webp) */
const SAFE_UPLOAD_NAME = /^img_[a-f0-9]+\.(jpg|jpeg|png|webp)$/i;

/**
 * Resolve a stored `/uploads/...` path to a file under uploadDir.
 * Rejects path traversal and unexpected names.
 */
export function resolveUploadPath(
  uploadDir: string,
  urlPath: string,
): { absolute: string; filename: string; mime: string } {
  const raw = (urlPath || "").trim();
  if (!raw || raw.includes("..") || raw.includes("\\")) {
    throw new AppError("INVALID_IMAGE", "无效的图片路径");
  }

  // Accept `/uploads/name`, `uploads/name`, or bare `name`
  const stripped = raw.replace(/^\/+/, "");
  const withoutPrefix = stripped.startsWith("uploads/")
    ? stripped.slice("uploads/".length)
    : stripped;
  const filename = path.basename(withoutPrefix);

  if (!filename || filename !== withoutPrefix || !SAFE_UPLOAD_NAME.test(filename)) {
    throw new AppError("INVALID_IMAGE", "无效的图片路径");
  }

  const resolvedDir = path.resolve(uploadDir);
  const resolvedFile = path.resolve(path.join(resolvedDir, filename));
  if (
    resolvedFile !== path.join(resolvedDir, filename) ||
    !resolvedFile.startsWith(resolvedDir + path.sep)
  ) {
    throw new AppError("INVALID_IMAGE", "无效的图片路径");
  }
  if (!fs.existsSync(resolvedFile)) {
    throw new AppError("NOT_FOUND", "图片不存在或已失效", 404);
  }

  const lower = filename.toLowerCase();
  const mime = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  return { absolute: resolvedFile, filename, mime };
}

export function readUploadBase64(
  uploadDir: string,
  urlPath: string,
): { filename: string; mime: string; data: string; bytes: number } {
  const { absolute, filename, mime } = resolveUploadPath(uploadDir, urlPath);
  const buf = fs.readFileSync(absolute);
  return {
    filename,
    mime,
    data: buf.toString("base64"),
    bytes: buf.length,
  };
}

export { MAX_BYTES, ALLOWED };
