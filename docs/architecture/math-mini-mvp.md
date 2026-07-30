# Plan: 3–6 年级数学培训小程序（MVP）

> Source PRD: [docs/PRD.md](../docs/PRD.md)  
> 切片策略: tracer-bullet 竖切（每阶段端到端可演示）  
> 定稿: 2026-07-25 · 12 阶段 · 先拍照闭环、后在线题

---

## Architectural decisions

Durable decisions that apply across all phases:

- **客户端**: 微信小程序；按角色进入老师端 / 学生端导航（可同一小程序内分包或条件 Tab）。
- **鉴权**: `wx.login` → `POST /api/v1/auth/wechat` 换取 session token；后续请求 `Authorization: Bearer <token>`。
- **API**: REST JSON，前缀 `/api/v1`；错误体统一 `{ code, message }`。
- **组织**: 单机构自用；不做多租户 `org_id` UI（库表可不加）。
- **时区**: 业务「今日 / 截止」按 `Asia/Shanghai`。
- **作业类型枚举**: `daily_drill` | `knowledge_checkin` | `photo_homework`。
- **作业生命周期**: `draft` → `published` → `revoked`（下架后学生不可新开作答）。
- **在线提交状态**: `not_started` → `in_progress` → `pending_correction` → `completed`；可叠加布尔 `overdue`。
- **拍照提交状态**: `not_started` → `submitted` → `completed` | `resubmit_required`（重交回到 `submitted`）。
- **完成率**: 分母 = 班级在册学生数；分子 = 该作业下状态为 `completed` 的提交数；逾期完成仍计完成，名单可标逾期。
- **题目快照**: 发布时将题面写入 `AssignmentQuestion.question_snapshot`；批改与展示只读快照，不回源题库。
- **自动批改（MVP）**: 填空做有限规范化（trim、全半角）；选择匹配 option id；判断匹配布尔；不做 `1/2`≡`0.5` 数学等价。
- **图片**: 客户端直传云存储或经后端签发上传凭证；业务库只存 URL 与顺序。
- **提醒**: 应用内角标/红点 + `NudgeCopy` 生成纯文本；不接订阅消息。
- **激励**: 打卡日历 + 完成勾选；无排行榜/积分。
- **关键逻辑模型**: `User`, `Class`, `ClassMembership`, `InviteCode`, `KnowledgeNode`, `Question`, `Assignment`, `AssignmentQuestion`, `Submission`, `AnswerItem`, `PhotoAsset`, `PhotoGrade`。
- **模块边界（与 PRD 一致）**: Identity · ClassRoom · KnowledgeTree · QuestionBank · Assignment · Submission · Progress · NudgeCopy。
- **测试**: 每阶段至少覆盖本切片新增的业务规则单测；不测微信 SDK 内部（端口伪造）。

### API 路由锚点（跨阶段稳定）

| 域 | 路径模式 |
|----|----------|
| 鉴权 | `POST /api/v1/auth/wechat`, `GET /api/v1/me`, `PATCH /api/v1/me` |
| 班级 | `POST /api/v1/classes`, `GET /api/v1/classes`, `GET /api/v1/classes/:id`, `POST /api/v1/classes/:id/invite/refresh`, `GET /api/v1/classes/:id/members`, `DELETE /api/v1/classes/:id/members/:userId`, `POST /api/v1/classes/join`, `POST /api/v1/classes/:id/archive` |
| 知识树 | `GET /api/v1/knowledge-nodes?grade=`, `GET /api/v1/knowledge-nodes?q=` |
| 题库 | `POST /api/v1/questions`, `GET /api/v1/questions`, `POST /api/v1/questions/generate` |
| 作业 | `POST /api/v1/assignments`, `GET /api/v1/assignments`, `GET /api/v1/assignments/:id`, `POST /api/v1/assignments/:id/publish`, `POST /api/v1/assignments/:id/revoke`, `POST /api/v1/assignments/:id/duplicate` |
| 作答 | `GET /api/v1/assignments/:id/my-submission`, `POST /api/v1/submissions/:id/answers`, `POST /api/v1/submissions/:id/correct`, `POST /api/v1/submissions/:id/photos`, `POST /api/v1/submissions/:id/grade` |
| 学情 | `GET /api/v1/assignments/:id/summary`, `GET /api/v1/classes/:id/dashboard`, `GET /api/v1/classes/:id/students/:userId/stats`, `GET /api/v1/assignments/:id/reminder-text` |
| 上传 | `POST /api/v1/uploads/photo-credential`（或等价） |

### 小程序页面锚点（名称可微调，职责稳定）

| 角色 | 页面职责 |
|------|----------|
| 共用 | 登录、角色选择、我的（资料） |
| 老师 | 工作台、班级列表/详情/成员/邀请、布置向导、作业列表/详情（汇总+批改）、题库录入、待批改 |
| 学生 | 首页任务、答题/订正、拍照提交、打卡日历、入班、我的班级 |

---

## Phase 1: 微信登录与角色选择

**User stories**: 1, 2, 3, 4, 5, 6；空态/基础可用性 87–90（本阶段能做的部分）

### What to build

打通微信登录到「已登录用户 + 角色」的最小路径：新用户登录后选择老师或学生，写入资料（昵称/头像可默认微信），分别进入老师或学生空壳首页与「我的」。会话可恢复，未登录访问业务接口被拒绝。

### Acceptance criteria

- [x] 用户可微信一键登录并获得稳定账号（同一 openid 不重复建号）
- [x] 首次可选择身份老师/学生，之后进入对应首页
- [x] 可在「我的」查看/更新昵称头像（头像：昵称首字占位，自定义图稍后）
- [x] 未带 token 的业务请求返回未授权
- [x] Identity 相关：登录建号、角色写入的单测或契约测通过（6 passed）

**交付物（2026-07-25）**：`server/` Identity · `miniprogram/` 五页 · 设计 `design/` 方向 B「算本」

---

## Phase 2: 建班与邀请码入班

**User stories**: 7, 8, 10, 12, 13, 15, 16；权限相关 82–84（基础）

### What to build

老师创建班级（名称、年级 3–6），系统生成邀请码；学生输入邀请码加入；老师查看成员列表；老师可切换自己创建的多个班；学生未入班时首页引导去入班。作业能力本阶段不做，只建立「班—人」关系。

### Acceptance criteria

- [x] 老师可创建班级并看到邀请码
- [x] 学生输正确码入班；错误码有明确提示
- [x] 老师可见本班学生列表
- [x] 老师多班时可以切换当前班上下文
- [x] 学生未入班看到入班引导，而非静默空白无说明
- [x] 学生只能看到自己相关班级数据；老师只能管理自己的班
- [x] ClassRoom：入班、非法码、成员列表的单测通过（5 passed）

**交付物（2026-07-25）**：`ClassRoomService` · API classes/join/members · 老师建班/详情/切换 · 学生入班/我的班级

---

## Phase 3: 班级运营补齐

**User stories**: 9, 11, 17, 18

### What to build

在 Phase 2 之上补齐班级运营：刷新/重置邀请码（旧码失效）、移出学生、学生加入多个班级、老师归档班级（日常列表隐藏，历史数据保留策略在实现时简单约定：归档班不再出现在默认列表，不可再布置新作业）。

### Acceptance criteria

- [x] 刷新邀请码后旧码不可再加入
- [x] 老师可移出学生；被移出后成员关系解除且列表不可见
- [x] 学生可加入多个班并在「我的班级」看到
- [x] 归档班不出现在老师默认列表；不可用邀请码新加入；可恢复；UI 就绪（作业发布校验留给 Phase 4+）
- [x] 相关 ClassRoom 单测通过（ops 6 + 既有 5）

**交付物（2026-07-25）**：refresh / removeMember / archive / unarchive · 详情与列表运营 UI

---

## Phase 4: 作业骨架 + 拍照作业全链路

**User stories**: 36, 37, 38, 39, 40, 41, 44, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66；状态展示 76（拍照相关）

### What to build

落地统一 `Assignment` 模型，并**完整跑通一种作业类型：拍照作业**。老师选班、写标题/说明、设截止、草稿或发布、下架；学生在任务列表看到已发布拍照作业，上传 1..N 张图提交；老师待批改列表看图，给出总体结果（正确/部分正确/错误或分数）+ 文字评语，或标需重交；学生看到批改结果并可重交。本阶段即可演示「布置 → 交 → 批 → 完成」闭环（尚无完成率大盘也可在作业详情显示简单状态列表）。

### Acceptance criteria

- [x] 老师可创建/发布/下架 `photo_homework`，学生仅见已发布
- [x] 学生可上传多图、删除重选后提交；状态为待批改（`submitted`）
- [x] 老师可批改：结果 + 评语 → `completed`；或需重交 → 学生可再传
- [x] 图片有格式/大小限制与失败提示（JPG/PNG/WebP，≤2MB，最多 6 张）
- [x] 作业列表可按班筛选
- [x] Submission 拍照状态机单测通过（5 cases）
- [ ] **Demo**: 双角色真机/开发者工具走通一条拍照作业（需本地联调）

**交付物（2026-07-25）**：Assignment + photo upload/grade API · 老师布置/批改 · 学生上传提交

---

## Phase 5: 完成率汇总与催交文案

**User stories**: 69, 70, 71, 72, 75, 79, 80, 81

### What to build

在作业已存在的前提下，实现老师最刚需的汇总：作业维度完成率、人数分层（已完成 / 进行中 / 未开始 / 逾期）、未完成名单、一键生成催交文案并复制；工作台展示今日/近期待办完成率与待批改数；学生端未完成任务红点/角标。完成率口径与 PRD 一致，先服务拍照作业，后续在线类型复用同一 `Progress` 接口。

### Acceptance criteria

- [x] 作业详情展示完成率与四态人数（无数据的态为 0）
- [x] 未完成名单准确（移出班级者不计入分母）
- [x] 催交文案含作业名与未交学生昵称，可复制
- [x] 老师工作台可见待批改数与近期作业完成率入口
- [x] 学生未完成任务有角标/红点
- [x] Progress 完成率与 NudgeCopy 文案单测通过（5 cases）
- [ ] **Demo**: 部分完成班级下，老师复制催交文案内容正确（需本地联调）

**交付物（2026-07-25）**：ProgressService · summary / reminder-text / dashboard · 详情汇总 UI · 学生 incompleteCount

---

## Phase 6: 手工题录入 + 题目快照

**User stories**: 27, 28, 29, 32

### What to build

老师可录入客观题：题干、题型（填空/选择/判断）、答案、可选解析、可选关联知识点 id（知识树 UI 可下一阶段再完善，字段先支持）。提供题目列表。发布在线作业时（本阶段可先支持「从手工题选题生成一种在线作业草稿」或仅提供 API/内部能力），将题目写入 `question_snapshot`，保证改源题不影响已发布作业。本阶段重点是题库与快照，完整学生答题可放到 Phase 7，但快照机制必须在布置链路中可验证。

### Acceptance criteria

- [x] 老师可创建三种题型手工题并列表查看
- [x] 题目可关联 `knowledge_node_id`（可空）
- [x] 发布含题作业时生成不可变快照；修改源题后已发布作业题面不变
- [x] QuestionBank 快照隔离单测通过（3 cases）

**交付物（2026-07-25）**：questions + assignment_questions · 题库 UI · 在线作业选题布置 · 快照冻结

---

## Phase 7: 在线作答、自动批改与订正闭环

**User stories**: 45, 46, 47, 48, 49, 50, 51, 53, 54, 67

### What to build

学生首页今日任务进入在线作业：逐题作答、提交后即时对错与正确率；错题进入 `pending_correction`，订正全对后 `completed`；完成后默认只读。老师侧在线作业无需手批。支持中途恢复未提交进度。逾期可订正但标记 `overdue`。自动批改规则按架构决策执行。本阶段与 Phase 5 的 summary 接口对接，在线作业完成率与拍照共用。

### Acceptance criteria

- [x] 学生可完成全对卷并直接 `completed`，任务勾选完成
- [x] 有错题时必须订正；未订正不算完成，完成率分子不含该生
- [x] 提交后可见对错；有解析则提交后可见
- [x] 中途退出再进可恢复未提交答案（服务端 draft）
- [x] 逾期提交/完成带逾期标记，仍可计入完成
- [x] 自动批改与订正状态机单测通过
- [ ] **Demo**: 故意答错 → 待订正 → 订正后完成率变化（需本地联调）

**交付物（2026-07-25）**：answer_items · auto grade · draft/submit/correct · 学生在线作答页

---

## Phase 8: 规则生成每日计算

**User stories**: 25, 26, 30, 31, 33, 34, 43

### What to build

老师布置 `daily_drill`：选择年级、运算类型（MVP 运算子集）、题量、可选整卷限时；系统规则生成题目 → 预览 → 可重新生成 → 可再混入手工题 → 设截止并发布。学生侧复用 Phase 7 作答/订正（限时强制交卷可放 Phase 11，本阶段至少配置可保存；若易实现可一并做整卷倒计时）。生成题进入快照后与手工题一致批改。

### Acceptance criteria

- [x] 按参数生成指定数量计算题，非法参数被拒绝
- [x] 预览后可换一批再发布
- [x] 支持「生成题 + 手工题」混合进同一作业
- [x] 发布为每日计算后学生可作答并走订正闭环
- [x] 题量与可选限时写入作业配置
- [x] 生成规则单测（数量、约束、种子可复现）通过
- [ ] **Demo**: 老师 2 分钟内发布一套每日计算，学生做完（需本地联调）

**交付物（2026-07-25）**：drill generator + `/questions/generate` · 布置页 create-drill · 限时配置落库

---

## Phase 9: 知识树 + 知识点打卡布置

**User stories**: 19, 20, 21, 22, 24, 35

### What to build

预置 3–6 年级简化知识树种子数据（年级 → 单元 → 知识点），只读 API：按年级列表、关键词搜索。老师布置 `knowledge_checkin`：选 1..N 知识点，每点绑定题目（手工题筛选或按点抽题/指定题量——MVP 建议：选题或对每个知识点指定已有手工题）。学生任务中展示知识点名称与所属单元。知识树配置化存储，便于不改代码增补节点。

### Acceptance criteria

- [x] 种子数据覆盖 3–6 年级精简节点，可按年级浏览
- [x] 知识点名称可搜索
- [x] 老师可发布知识点打卡作业；学生题面/任务上可见知识点信息
- [x] 增补知识树配置（数据）无需改代码逻辑（改 JSON 即可）
- [x] 打卡作业完成仍走 Phase 7 订正规则
- [ ] **Demo**: 选 2 个知识点布置 → 学生完成打卡（需本地联调）

**交付物（2026-07-25）**：KnowledgeTreeService · knowledge-nodes API · create-checkin 页

---

## Phase 10: 学情深化与学生激励

**User stories**: 23, 68, 73, 74, 77, 78

### What to build

老师：某次在线作业逐题正确率；某学生在某班近期完成率与正确率。学生：个人已打卡/完成过的知识点简化列表；打卡日历（按月哪些天有完成任务）；任务完成态的明确勾选/样式。不做排行榜与积分。

### Acceptance criteria

- [x] 在线作业详情可看每题班级正确率
- [x] 老师可打开学生个人学情（完成率、正确率，近 14 天）
- [x] 学生打卡日历按月展示有完成记录的日期
- [x] 学生可见自己的知识点完成记录列表
- [x] 完成态 UI 与日历数据与 `completed` 状态一致
- [x] 统计聚合单测或固定夹具验收通过（3 cases）

**交付物（2026-07-25）**：question-stats / student stats / calendar / knowledge-progress · 学情与日历 UI

---

## Phase 11: 扫码入班与体验收尾

**User stories**: 14, 42, 52, 85, 86, 87, 88, 89, 90（补齐）

### What to build

学生扫描入班二维码加入班级（与邀请码同一 join 能力）。老师可复制历史作业为新草稿再编辑发布。每日计算若配置了整卷限时，到时自动交卷。全面收紧：上传限制、鉴权、列表下拉刷新、弱网错误与重试、各类空状态引导文案。

### Acceptance criteria

- [x] 扫码与手输码入班结果一致（`SUANBEN:CODE` / 纯码）
- [x] 复制作业生成新草稿，修改后发布不影响原作业
- [x] 限时结束自动交卷并进入批改/订正逻辑（force 部分作答）
- [x] 主要列表支持下拉刷新（工作台/作业/学生今日）
- [x] 网络失败有提示可重试（request 自动重试一次）
- [x] 老师无班/无作业、学生未入班/无任务等空态有引导
- [x] 上传超限被拒绝且提示清晰（既有 2MB 限制）

**交付物（2026-07-25）**：invite-qr · duplicate · force timer submit · 扫码入班 · 下拉刷新

---

## Phase 12: MVP 验收加固

**User stories**: PRD 成功标准全表；Testing Decisions 中必测模块扫尾

### What to build

不新增大功能：补齐核心域单测缺口、跑通手工验收清单、修主路径缺陷、核对完成率/订正/快照/催交等边界。输出可上线的 MVP 检查结果。

### Acceptance criteria

- [x] PRD 成功标准 1–5 自动化满足（见 `docs/MVP-验收报告.md`）
- [x] QuestionBank / Submission / Progress / NudgeCopy / ClassRoom / Assignment 必测表全绿（54 tests）
- [x] 主路径自动化：建班 → 入班 → 三类作业 → 汇总催交 → 批改（`mvp-main-path.test.ts`）
- [x] 无阻塞性权限穿透用例（学生不可批改、他班 403）
- [x] 已知问题列表仅剩非阻塞项（验收清单 §D）
- [ ] 手工验收清单产品签字（待人工）

**交付物（2026-07-25）**：`mvp-main-path` 集成测 · `docs/MVP-验收清单.md` · `docs/MVP-验收报告.md`

---

## Phase dependency graph

```text
1 Identity
 └─► 2 Class join
      └─► 3 Class ops
           └─► 4 Photo assignment loop
                └─► 5 Summary + nudge
                     ├─► 6 Manual questions + snapshot
                     │    └─► 7 Online answer + correction
                     │         ├─► 8 Daily drill generate
                     │         └─► 9 Knowledge tree + checkin
                     │              └─► 10 Stats + calendar
                     └─► (5 的 Progress 被 7–9 复用)
11 Polish (after 2+ for QR; after 8 for timer; after 4+ for UX)
12 Hardening (after 1–11)
```

说明：Phase 11 中扫码依赖 Phase 2；限时依赖 Phase 8；空态/弱网可随时摩擦修复，计划上收口在 11。Phase 12 必须在 1–11 功能冻结后做。

---

## Suggested demo checkpoints

| 检查点 | 完成阶段 | 对外可讲的一句话 |
|--------|----------|------------------|
| D1 | 2 | 「老师建班，学生进班」 |
| D2 | 5 | 「拍照作业 + 完成率 + 催交文案」 |
| D3 | 7 | 「在线题自动批 + 订正才算完成」 |
| D4 | 9 | 「每日计算 + 知识点打卡齐了」 |
| D5 | 12 | 「MVP 可试用」 |

---

## Post-MVP：学生粘性与掌握感（S1–S5）

MVP 闭环之后的**学生向**增量，不改变「无排行榜 / 无积分商城」原则。

| 阶段 | 主题 | 规格 |
|------|------|------|
| S1 | 首页分层 + 完成成功页 + 连续天数 | |
| S2 | 错因 + `mastery_items` 入队 | |
| S3 | 3 日回访卷闭环（独立于 Assignment） | |
| S4 | 知识地图 + 日历双态 | |
| S5 | 周小结 + 单元印戳（可选） | |

完整状态机、API、验收与日志约定见：

**[docs/product/student-mastery-plan.md](../product/student-mastery-plan.md)**

---

## Out of plan (明示不做)

与 PRD Out of Scope 一致：家长端、订阅消息、排行榜/积分、AI/OCR 批改、多机构、教材版本身份树、导出 Excel、助教角色等。若变更须先改 PRD 再改本 plan。  
学生掌握感计划中的「回访 / 知识地图」属 Post-MVP，不在上表禁止项内；仍禁止用排行榜/积分实现粘性。

---

## Content seeds

| 项 | 状态 | 路径 |
|----|------|------|
| 运算清单 23 种 | 已确认 | `content/drill-operations.json` |
| 知识树 89 知识点 | 已确认 | `content/knowledge-tree.json` |
| 说明与约定 | 已确认 | `docs/content-seeds.md` |

Phase 8 / 9 实现时直接 seed 导入，批改约定以 `docs/content-seeds.md`「已确认的产品约定」为准。

---

## Change log

| 日期 | 说明 |
|------|------|
| 2026-07-25 | 初版 12 阶段；先拍照后在线；写入 plans/math-mini-mvp.md |
| 2026-07-25 | 内容种子确认定稿，挂接到本 plan |
| 2026-07-29 | 增加 Post-MVP 学生粘性/掌握感 S1–S5，链到 student-mastery-plan.md |
