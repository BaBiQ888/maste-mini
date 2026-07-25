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
npm run dev          # 后端 http://127.0.0.1:3000
npm test             # 54+ 域/主路径测试
```

微信开发者工具打开目录：`miniprogram/`（关闭域名校验）。

## 文档

| 文档 | 路径 |
|------|------|
| 架构分层 | [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) |
| 实施计划 | [docs/architecture/math-mini-mvp.md](docs/architecture/math-mini-mvp.md) |
| PRD | [docs/product/PRD.md](docs/product/PRD.md) |
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
