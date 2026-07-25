# =============================================================================
# 备用 Dockerfile：仅当「目标目录」填 server 时使用
#
# 微信云托管推荐配置（服务设置 → 流水线）：
#   目标目录 = 留空
#   Dockerfile 名称 = Dockerfile
#   → 使用的是仓库【根目录】的 Dockerfile（含 monorepo + CODE_VERSION）
#
# 本文件在 server/ 下，内容看起来会「很久不变」，这是正常的。
# MySQL 连接逻辑在 server/src 源码里，不在这个 Dockerfile 里改。
# =============================================================================
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY . .
RUN npm rebuild better-sqlite3 deasync || true
ENV NODE_ENV=production
ENV PORT=80
ENV CODE_VERSION=listen-first-v4
EXPOSE 80
CMD ["node", "dist/main/index.js"]
