# 算本 · 开发设计架构分层

本文描述 monorepo 的**文件夹层级**与**代码分层职责**，便于开发与 AI 协作时按边界改代码。

---

## 1. 仓库顶层（按交付物 / 关注点分离）

```text
math-mini/
├── miniprogram/          # 表现层 · 微信小程序（客户端）
├── server/               # 后端应用 · 分层架构（见 §2）
├── packages/
│   └── content/          # 共享内容包 · 运算清单 / 知识树种子
├── content/              # 兼容入口（与 packages/content 同步）
├── docs/
│   ├── product/          # 产品：PRD、验收清单/报告、内容种子说明
│   ├── architecture/     # 架构：本文件、实现计划
│   └── design/           # 设计：品牌、logo、高保真壳
├── package.json          # workspaces 根
└── README.md
```

| 目录 | 分层角色 | 改什么 |
|------|----------|--------|
| `miniprogram/` | **Presentation（客户端）** | 页面、交互、本地状态 |
| `server/src/presentation` | **Presentation（HTTP）** | 路由、DTO 校验、鉴权中间件 |
| `server/src/application` | **Application（应用服务）** | 用例编排、事务边界 |
| `server/src/domain` | **Domain（领域）** | 纯规则：批改、出题算法、错误类型 |
| `server/src/infrastructure` | **Infrastructure** | DB、微信、文件存储、读配置文件 |
| `server/src/main` | **Composition Root** | 组装依赖、启动进程 |
| `packages/content` | **Content / Config** | 无逻辑的配置数据 |
| `docs/*` | **Knowledge** | 产品/架构/设计文档 |

---

## 2. 后端分层（`server/src`）

```text
server/src/
├── main/
│   └── index.ts                 # 启动：读 env → 开 DB → createApp → listen
├── presentation/
│   └── http/
│       └── app.ts               # Hono 路由 / Zod 入参 / 错误映射
├── application/                 # 应用服务（用例）
│   ├── identity/service.ts      # 登录、资料、会话
│   ├── classroom/service.ts     # 班级、邀请码、成员
│   ├── assignment/service.ts    # 作业、作答、批改编排
│   ├── questionbank/service.ts  # 题库 CRUD、快照素材
│   ├── progress/service.ts      # 完成率、催交、学情、日历
│   └── knowledge/service.ts     # 知识树查询（读配置）
├── domain/                      # 领域纯逻辑（尽量无 I/O）
│   ├── shared/errors.ts         # AppError
│   ├── question/types.ts        # QuestionSnapshot 等
│   ├── grading/auto-grade.ts    # 自动批改、规范化
│   └── drill/generator.ts       # 规则出题
├── infrastructure/              # 技术实现
│   ├── persistence/db.ts        # SQLite schema / 连接
│   ├── wechat/code2session.ts   # 微信 code→openid（含 mock）
│   └── storage/upload-store.ts  # 图片落盘
└── （tests 在 server/tests，按行为测应用边界）
```

### 依赖方向（硬规则）

```text
main → presentation → application → domain
                  ↘ infrastructure ↗
```

- **presentation** 可依赖 application、infrastructure 类型（如 WechatConfig）
- **application** 可依赖 domain + infrastructure（当前服务内直接用 SQLite）
- **domain** **不得**依赖 application / presentation / infrastructure（仅标准库 + 自身）
- **infrastructure** 可依赖 domain（如错误类型、createId）

后续演进：把 `application/*` 里的 SQL 抽到 `infrastructure/persistence/repositories/*`，application 只依赖仓储接口。

---

## 3. 小程序分层（`miniprogram`）

```text
miniprogram/
├── app.js / app.json / app.wxss   # 应用壳（微信约定）
├── pages/                         # 表现 · 按角色/功能分页面
│   ├── login|role|profile/
│   ├── teacher/                   # 老师端
│   └── student/                   # 学生端
├── utils/                         # 官方常见公共目录 · 跨页能力
│   ├── auth.js                    # 会话、路由分流
│   ├── request.js                 # API 客户端
│   ├── media.js                   # 上传/状态文案
│   └── class-context.js           # 当前班上下文
└── assets/                        # 静态资源
```

| 层级 | 目录 | 职责 |
|------|------|------|
| 表现 | `pages/**` | 渲染、事件、页面状态 |
| 公共 | `utils/**` | 网络、鉴权、通用 UI 文案（微信官方示例常用名） |
| 资源 | `assets/**` | logo 等 |

页面 **禁止** 互相 require 业务细节；跨页状态放 `utils` 或服务端。

---

## 4. 内容与文档

```text
packages/content/          # 唯一内容源（推荐）
  drill-operations.json
  knowledge-tree.json

docs/
  product/                 # PRD、验收
  architecture/            # 本架构 + 实施计划
  design/                  # 品牌与高保真
```

领域出题 / 知识树从 `packages/content`（及兼容路径）加载，**改 JSON 不改代码**。

---

## 5. 请求路径（端到端）

```text
小程序 pages
  → utils/request (HTTP)
    → presentation/http/app (路由 + 鉴权)
      → application/*Service (用例)
        → domain/* (规则)
        → infrastructure/* (DB / 文件 / 微信)
```

---

## 6. 开发约定

1. **新业务优先落 application 服务**，纯计算放 domain。  
2. **新表 / SQL 暂时写在 application 或 infrastructure/persistence**；禁止写在 presentation。  
3. **新接口只改 presentation/http/app.ts**（或后续拆 controllers）。  
4. **小程序新页放 pages/{role}/…**，公共逻辑放 utils。  
5. **测试测行为**：优先打 HTTP（`createApp`）或 domain 纯函数，不测框架内部。  

---

## 7. 与旧路径对照

| 旧路径 | 新路径 |
|--------|--------|
| `server/src/modules/*` | `application/*` 或 `domain/*` |
| `server/src/app.ts` | `presentation/http/app.ts` |
| `server/src/index.ts` | `main/index.ts` |
| `server/src/db.ts` | `infrastructure/persistence/db.ts` |
| `miniprogram/utils/*` | 保持 `utils/`（微信官方常见命名） |
| `docs/*.md`（产品） | `docs/product/` |
| `design/` | `docs/design/` |
| `plans/` | `docs/architecture/` |
| `content/` | `packages/content/`（+ 根 content 兼容） |

---

**维护原则**：文件夹即架构。放错层 = 依赖会慢慢腐烂。
