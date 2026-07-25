# 备用：构建上下文为 server/ 时使用
# 推荐云托管流水线使用仓库根目录 Dockerfile
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
EXPOSE 80
CMD ["node", "dist/main/index.js"]
