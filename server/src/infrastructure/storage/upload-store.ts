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

export { MAX_BYTES, ALLOWED };
