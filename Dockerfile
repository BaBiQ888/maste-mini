# 微信云托管流水线：仓库根目录 Dockerfile，端口 80
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/

RUN npm ci

COPY server ./server
COPY packages ./packages
COPY content ./content

WORKDIR /app/server
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/

RUN npm ci --omit=dev

COPY --from=builder /app/server/dist ./server/dist
COPY server ./server
COPY packages ./packages
COPY content ./content

# 确保 native 模块与当前镜像匹配
WORKDIR /app
RUN npm rebuild better-sqlite3 --workspace=server || true

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=80
# Bump when shipping env-parsing fixes so /health proves new image
ENV CODE_VERSION=upload-content-v15
EXPOSE 80

CMD ["node", "dist/main/index.js"]
