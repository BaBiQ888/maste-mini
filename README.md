# 算本 · math-mini

3–6 年级数学培训小程序（老师 + 学生）。

**架构分层说明**：[docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)

## 仓库分层（文件夹 = 架构）

```text
math-mini/
├── miniprogram/                 # 客户端表现层（微信小程序）
│   ├── pages/                   #   页面（teacher / student）
│   ├── utils/                   #   公共：auth / request / media（官方常见命名）
│   └── assets/
├── server/                      # 后端
│   ├── src/
│   │   ├── main/                #   启动入口
│   │   ├── presentation/http/   #   路由 · DTO · 鉴权
│   │   ├── application/         #   应用服务（用例）
│   │   ├── domain/              #   领域纯逻辑（批改/出题）
│   │   └── infrastructure/      #   DB · 微信 · 文件
│   └── tests/                   #   行为测试
├── packages/content/            # 内容配置（运算清单、知识树）
├── docs/
│   ├── product/                 # PRD · 验收
│   ├── architecture/            # 架构 · 实施计划
│   └── design/                  # 品牌 · 高保真
└── package.json
```

## 本地启动

```bash
npm install
# 若 better-sqlite3 未编译：npm approve-scripts better-sqlite3 && npm rebuild better-sqlite3
npm run dev          # 后端 http://127.0.0.1:3001（默认 SQLite）
npm test             # 54+ 域/主路径测试
```

### 推送到云托管前（必跑）

```bash
npm run predeploy    # test + tsc，与 Docker 构建一致；tsc 失败则云端必挂
```

详见 [docs/deploy.md](docs/deploy.md)（含 TypeScript / MySQL / 探针 踩坑记录）。

微信开发者工具打开目录：`miniprogram/`。

- **本地调试**：`miniprogram/app.js` 里设 `useCloud: false`，并关闭域名校验。
- **云托管**：`useCloud: true`（默认），走 `wx.cloud.callContainer`。

## 微信云托管 + MySQL

库名：`math_mini`。在云托管服务环境变量中配置：

```bash
MYSQL_HOST=10.17.104.40
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=<服务通知中的密码>
MYSQL_DATABASE=math_mini
PORT=80
```

也可用 `DATABASE_URL=mysql://root:密码@10.17.104.40:3306/math_mini`。

当前环境 / 服务（示例）：

| 项 | 值 |
|----|-----|
| env | `prod-d7glqi3icbdfab67d` |
| service | `express-4x8b` |
| 公网域名 | 以云托管控制台「服务设置 → 域名」为准（示例见 `miniprogram/app.js` 的 `apiBase`） |

部署：将本仓库用 Dockerfile（`server/Dockerfile`）部署到服务 `express-4x8b`，覆盖模板 Express。启动后会自动建表。

**先在 MySQL 控制台创建空库 `math_mini`（若尚未创建）。**

## 文档

| 文档 | 路径 |
|------|------|
| 架构分层 | [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) |
| 实施计划 | [docs/architecture/math-mini-mvp.md](docs/architecture/math-mini-mvp.md) |
| PRD | [docs/product/PRD.md](docs/product/PRD.md) |
| 学生粘性/掌握感 | [docs/product/student-mastery-plan.md](docs/product/student-mastery-plan.md) |
| 验收清单 | [docs/product/MVP-验收清单.md](docs/product/MVP-验收清单.md) |
| 验收报告 | [docs/product/MVP-验收报告.md](docs/product/MVP-验收报告.md) |
| 品牌设计 | [docs/design/brand-spec.md](docs/design/brand-spec.md) |

## 技术栈

| 层 | 选型 |
|----|------|
| 小程序 | 微信原生 |
| API | Node 20 · Hono · Zod |
| 数据 | better-sqlite3 |
| 鉴权 | wx.login → session Bearer |

## 状态

Phase 1–12 已交付；`npm test` 全绿。试用前请完成产品侧手工验收清单。
