# 算本 · 学生粘性与掌握感计划

| 字段 | 内容 |
|------|------|
| 产品 | 算本（math-mini） |
| 范围 | **学生端**粘性 + 掌握感（老师侧仅消费衍生数据时可后置） |
| 状态 | **S1–S5 已实现**（2026-07-30） |
| 日期 | 2026-07-29（定稿）· 2026-07-30（S1–S5 落地） |
| 依赖 | [PRD.md](./PRD.md) · [math-mini-mvp.md](../architecture/math-mini-mvp.md) · [brand-spec.md](../design/brand-spec.md) |
| 原则对齐 | 无排行榜 / 无积分商城；激励=日历点亮 + 完成勾选 + 私密连续天数；语气低压力 |

---

## 1. 问题与主张

### 1.1 现状缺口

| 已有能力 | 学生感受 | 缺口 |
|----------|----------|------|
| 首页任务列表 | 「老师布置了什么」 | 缺少「我今天进步了什么」 |
| 错题须订正才完成 | 通关规则正确 | 订正像补作业，不像「学会了」 |
| 打卡日历点亮 | 有习惯苗头 | 只有「做没做」，没有「稳不稳」 |
| 知识点完成列表 | 有记录 | 无地图、无回访、无「半掌握」 |
| 今日无任务 | 易离开 | 打开无价值 |

### 1.2 产品主张

> 打开算本，不是「又被催作业」，而是「看见自己哪里会了、哪里还差一口气」。

| 维度 | 定义 |
|------|------|
| **粘性** | 学生愿意在无老师新作业时仍打开：回访、地图、日历连续、空页也有内容 |
| **掌握感** | 学生能解释「我会什么 / 半会什么」；错→订→再验后有「这页可以折角了」的反馈 |

### 1.3 明确不做

- 全班 / 全校排行榜、正确率公开墙
- 积分商城、抽奖、皮肤付费、生命值恐吓
- 系统强制每日刷题包（与老师作业抢注意力）
- 回访失败「惩罚加倍题量」
- 家长端 App（可用「本周小结文案复制」替代，本计划 P5 可选）
- 拍照作业自动入掌握队列（无自动对错；后续若有圈注/人工标错题再议）

---

## 2. 成功指标

| 级别 | 指标 | 定义 | 用途 |
|------|------|------|------|
| 北极星 | **周回访率** | 上周完成过 ≥1 任务的学生，本周打开小程序 ≥2 天 | 粘性 |
| 北极星 | **再验通过率** | 到期回访卷中 `passed` 占比 | 掌握 |
| 辅助 | 订正完成中位时长 | 从首次提交错到订正完成 | 体验是否顺 |
| 辅助 | 连续完成天数分布 | 仅私密；看习惯形成 | 粘性 |
| 辅助 | 待回访堆积中位数 | 每生 open+due 条数 | 防 overload |
| 反指标 | 回访放弃率 | 打开回访未提交占比过高 | 题量/难度需调 |

班级完成率、催交仍归老师 Progress，**回访不进班级作业完成率分母**（见 §4.2）。

---

## 3. 体验循环

```text
① 每日环（粘性）
   打开 → 今日分层（必做 / 回访 / 可选）→ 做或订正
   → 成功页（掌握话术 + 勾选）→ 日历点亮

② 掌握环（核心）
   在线题做错 → 订正（可选错因）→ 入队 MasteryItem
   → D+3 到期回访 3 题 → 过：巩固 / 不过：再入队

③ 地图环（中期）
   知识节点 暗 | 半亮 | 亮 → 点半亮自助巩固 → 回写状态
```

交付顺序：① 可先无新表 → ② 数据闭环 → ③ 视觉地图。

---

## 4. 产品决策（已拍板建议，实施前可改）

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| D1 | 回访是否算「今日必做」 | **独立「回访」槽**，弱于老师必做 | 不抢老师权威；完成率口径清晰 |
| D2 | 回访是否创建正式 `Assignment` | **否**；用 `mastery_reviews` + 题快照 | 不进老师作业列表与完成率分母 |
| D3 | 回访是否进班级完成率 | **否** | 避免「系统作业」扭曲老师管理 |
| D4 | 无新表能否上线 S1 | **能**；S1 只做信息架构与反馈 | 快速验证文案与首页分层 |
| D5 | 错因是否必填 | **可选**，不阻塞订正提交 | 降摩擦；有数据更好 |
| D6 | 同一知识点多条错题 | **合并一条** MasteryItem，刷新时间 | 防待回访爆炸 |
| D7 | 回访题量 | 默认 **3 题** | 短、可完成 |
| D8 | 回访间隔 | 订正通过后 **+3 天**（上海时区日界） | 间隔重复效应；可配置常量 |
| D9 | 激励可见范围 | **仅自己** | 对齐 PRD 克制激励 |
| D10 | 拍照作业 | MVP **不入队** | 无自动批对错 |

可配置常量（建议 `server` 或 content 配置，非魔法数散落）：

```text
MASTERY_REVIEW_DELAY_DAYS = 3
MASTERY_REVIEW_QUESTION_COUNT = 3
MASTERY_PASS_MIN_CORRECT = 3          # 3 题全对算过；或 ≥2 可调
MASTERY_SELF_PRACTICE_COUNT = 5
MASTERY_ITEM_EXPIRE_DAYS = 30         # 长期未回访则 expired
MASTERY_MAX_OPEN_PER_USER = 20        # 超过则只保留最近 / 合并策略
```

---

## 5. 功能规格

### 5.1 首页「今日分层」（S1）

**页面**：`miniprogram/pages/student/home/*`

| 区块 | 数据来源 | 展示规则 |
|------|----------|----------|
| 顶栏 | 昵称可选 + `streakDays` | 「连续点亮 N 天」；N=0 时：「今天点亮一格就好」 |
| **必做** | 老师已发布作业中：未完成 / 待订正 / 待批改 / 进行中 | 按截止时间升序；标签沿用现有 statusLabel |
| **回访** | `mastery_items` status=`due`（S3+） | 最多展示 **1** 条主卡；更多在知识页 |
| **可选** | 半亮知识点自助练；或必做+回访皆空时的「超练」 | 可折叠/弱样式；不红点强迫 |
| 已清态 | 必做全完成且无 due 回访 | 完成印戳 + 短句 + 链到日历/地图 |
| 未入班 | 现有引导 | 不变 |
| 无任务空页 | 无必做 | 有回访则回访升主卡；否则「今日空页」贴士 + 链知识地图/日历 |

**红点 / Tab badge**：

- 仍以 **老师任务未完成数** 为主（与现 PRD 一致）
- 回访 due：**可选**小橙点（不计入数字，或 `数字+·`），避免与催交数字混淆  
  - 建议 S3：badge = 未完成老师任务数；回访仅卡片内强调

**兼容**：多班级任务合并列表逻辑保持；仅增加分组 header。

### 5.2 任务完成 / 订正成功页（S1）

统一组件或页内区块（在线提交成功、订正成功后）：

| 元素 | 内容 |
|------|------|
| 主状态 | 「本页过关」/「订正完成」+ 墨绿勾 |
| 正确率 | 订正前 → 订正后（若有） |
| 掌握句 | 按知识点模板；无则通用句 |
| 次要 | 连续天数 +1 提示（若当日首次完成） |
| S2+ | 「已记入待巩固：xxx」（若入队） |
| CTA | 回今日 / 继续下一任务 |

### 5.3 错因（S2）

订正提交 UI 增加可选 chip（单选）：

| value | 文案 |
|-------|------|
| `careless` | 粗心 |
| `concept` | 概念不清 |
| `procedure` | 计算步骤 |
| `misread` | 看错题目 |

- 存储在 `answer_items` 扩展字段或独立 `answer_reflections`（见 §6）
- 不填可提交；填了随订正 API 一并上传

### 5.4 掌握队列与回访（S2–S3）

#### 入队（S2）

触发：在线作业（`daily_drill` | `knowledge_checkin` | 其它在线客观）**订正成功**且该次提交曾存在 `is_correct=0` 的题。

对每道曾错题：

1. 解析 `knowledgeNodeId`（来自 question_snapshot / 作业配置）
2. 若无知识点：用 `skill_key` = `drill:{operationId}` 或 `question:{bankId}` 降级
3. Upsert `mastery_items`：同 `(user_id, knowledge_node_id|skill_key)` 合并
4. `status=open`，`review_at = 订正完成日(上海) + 3 天的 00:00`（或 +3×24h，实现选一种写清）
5. `miss_count += 1`

**不入队**：拍照作业；全对首次提交；已 `passed` 且无新错可保持 passed，新错则重新 `open`。

#### 到期（S3，读时或定时）

- 读今日首页 / mastery 列表时：若 `status=open` 且 `review_at <= now` → 置 `due`
- 可选：启动时 batch 扫描（非必须）

#### 回访卷（S3）

1. `POST /me/mastery/:id/start-review` 创建 `mastery_reviews` 行 + 生成 3 题快照  
2. 题源优先级：  
   - 历史错题快照（同知识点）去重抽取  
   - 不足：题库该知识点题  
   - 再不足：drill 规则按 `suggestedDrillOps` 生成  
3. 学生作答走轻量提交（可复用 auto-grade 领域逻辑，**不**走老师 Assignment 发布流）  
4. 批改后：  
   - 全对（或 ≥ `MASTERY_PASS_MIN_CORRECT`）→ `passed`，`pass_count++`  
   - 否则 → `failed` 后立刻转 `open`，`review_at = now + 3d`，`miss_count++`

#### 过期

- `open|due` 且 `review_at` 起超过 `MASTERY_ITEM_EXPIRE_DAYS` 无完成回访 → `expired`（可再被新错题唤醒）

#### 堆积保护

- 每用户 `open+due` 超过 `MASTERY_MAX_OPEN_PER_USER`：新错只更新已有项时间，或丢弃最旧 `expired` 候选；**禁止**无限插入

### 5.5 知识地图（S4）

**页面**：升级 `miniprogram/pages/student/knowledge/*`（或新页 map，list 作降级）

| 态 | 条件（默认） | 视觉 token |
|----|--------------|------------|
| `dark` | 从未有完成记录且无 mastery 项 | 灰点 `--ink-faint` |
| `half` | 存在 `open|due|failed` mastery，或近 14 天正确率 &lt; 80%（有样本） | 锈橙点 `--accent` |
| `lit` | 近 14 天有相关完成，且无 `open|due`，正确率 ≥ 80% 或仅打卡完成 | 墨绿勾 `--success` |

交互：

- 点 `half` → 确认后 `self_practice` 5 题（同回访生成器，`source=self_practice`）
- 点 `lit` → 只读：最近一次通过时间
- 按 **单元** 折叠；年级默认当前班年级，可切换

### 5.6 日历增强（S4，可部分进 S1）

**页面**：`miniprogram/pages/student/calendar/*`

| 日态 | 含义 | 样式 |
|------|------|------|
| `none` | 无记录 | 默认 |
| `done` | 当日老师任务均完成（与现逻辑对齐可先「有完成」） | 实心 ✓ success |
| `partial` | 有完成但有逾期完成或未清必做 | 半勾 / 浅底 |
| `review_due` | 当日有 due 回访（可与 done 叠：角标橙点） | 橙点 |

顶栏：`本月点亮 D 天 · 连续 S 天`  
点日期：当日完成任务列表 + 是否新增巩固通过

**S1 最小集**：只加连续天数与顶栏文案；双态点放到 S4。

### 5.7 低压力激励（S1/S5）

| 机制 | 阶段 | 规则 |
|------|------|------|
| 连续点亮天数 | S1 | 连续自然日存在「至少 1 次任务 completed」；断了归零，文案不恐吓 |
| 本月点亮天数 | S1 | 现有 calendar 聚合 |
| 单元印戳 | S5 | 该单元下知识点全 `lit` → 展示「本页练完」印戳（配置名） |
| 本周小结 | S5 | 只读 3 条：「点亮/巩固了哪些」；可复制给家长微信 |

---

## 6. 数据模型

### 6.1 `mastery_items`

| 列 | 类型 | 说明 |
|----|------|------|
| id | TEXT PK | |
| user_id | TEXT NOT NULL | |
| class_id | TEXT NULL | 可选；入队时的班上下文 |
| knowledge_node_id | TEXT NULL | 与 skill_key 至少一者非空 |
| skill_key | TEXT NULL | 降级键，如 `drill:add_carry` |
| status | TEXT | `open` \| `due` \| `passed` \| `failed` \| `expired` |
| miss_count | INT | 累计未掌握次数 |
| pass_count | INT | 累计回访通过次数 |
| review_at | TEXT ISO | 下次可回访时间 |
| last_result_at | TEXT ISO NULL | |
| last_wrong_reason | TEXT NULL | 最近错因 |
| source_assignment_id | TEXT NULL | 最近一次来源作业 |
| created_at / updated_at | TEXT ISO | |

**唯一约束建议**：`UNIQUE(user_id, knowledge_node_id)` WHERE knowledge_node_id NOT NULL；  
`UNIQUE(user_id, skill_key)` WHERE skill_key NOT NULL。  
（SQLite 部分索引语法按实现选型；MySQL 可用生成列或应用层 upsert。）

### 6.2 `mastery_reviews`

| 列 | 类型 | 说明 |
|----|------|------|
| id | TEXT PK | |
| mastery_item_id | TEXT NOT NULL | |
| user_id | TEXT NOT NULL | |
| source | TEXT | `review` \| `self_practice` |
| status | TEXT | `in_progress` \| `completed` \| `abandoned` |
| question_snapshots_json | TEXT | 题面数组（与 Assignment 快照结构对齐 subset） |
| answers_json | TEXT NULL | 作答过程 |
| correct_count | INT NULL | |
| total_count | INT | |
| passed | INT NULL | 0/1 |
| started_at / completed_at | TEXT | |

### 6.3 错因存储（二选一，推荐 A）

**A.** `answer_items.wrong_reason TEXT NULL`（订正提交时写在对应错题行）  
**B.** 表 `answer_reflections(answer_item_id, reason, created_at)`

推荐 **A** 简单；若 answer_items 行在订正时更新则直接 PATCH。

### 6.4 与现有表关系

```text
users 1─* mastery_items
mastery_items 1─* mastery_reviews
assignments / submissions / answer_items ──触发──► mastery_items（订正成功）
knowledge_nodes（配置）──展示──► map 态计算
calendar 数据仍来自 submissions completed_at（Progress 已有）
```

**不**把 mastery_reviews 写入 `assignments` 表。

---

## 7. API 设计

前缀：`/api/v1`；鉴权：学生 Bearer；权限：仅本人数据。

### 7.1 聚合今日（S1 可先前端拼，S3 后端聚合）

```http
GET /me/today
```

**Response（示意）**

```json
{
  "streakDays": 4,
  "monthLitDays": 12,
  "required": [ { "assignmentId": "...", "title": "...", "status": "...", "statusLabel": "...", "className": "...", "type": "daily_drill" } ],
  "review": { "masteryItemId": "...", "title": "回访：分数加减", "knowledgeName": "分数加减", "questionCount": 3 },
  "optional": { "kind": "self_practice", "knowledgeNodeId": "...", "title": "巩固：小数点位置", "questionCount": 5 },
  "tip": "今日空页。可翻翻知识地图，或等老师布置。"
}
```

- S1：`review`/`optional` 恒 null，前端仍分组「必做=未完成」「其它=已完成可回顾」  
- 或 S1 仅改前端分组，不新增路由

### 7.2 掌握列表与地图

```http
GET /me/mastery?status=open,due
GET /me/mastery-map?grade=4
```

**map item**

```json
{
  "knowledgeNodeId": "...",
  "name": "...",
  "unitId": "...",
  "unitName": "...",
  "state": "dark|half|lit",
  "masteryItemId": null,
  "reviewAt": null
}
```

### 7.3 回访 / 自助练

```http
POST /me/mastery/:itemId/start-review
POST /me/mastery/self-practice
Body: { "knowledgeNodeId": "..." }

GET  /me/mastery/reviews/:reviewId
POST /me/mastery/reviews/:reviewId/answers
Body: { "answers": [ { "questionIndex": 0, "value": "..." } ] }
POST /me/mastery/reviews/:reviewId/submit
```

批改复用 `domain/grading/auto-grade`；响应含逐题对错与 `passed`。

### 7.4 错因

```http
POST /submissions/:id/correct
Body: {
  "answers": [ ... ],
  "wrongReasons": [ { "questionId": "...", "reason": "careless" } ]
}
```

兼容旧客户端：无 `wrongReasons` 仍可订正。

### 7.5 日历扩展

```http
GET /classes/:id/students/me/calendar?year=&month=
```

或现有学生日历接口扩展 day：

```json
{ "date": "2026-07-29", "state": "done|partial|review_due|none", "completedCount": 2 }
```

（具体路径与现 `ProgressService` 日历 API 对齐实现时改一处。）

---

## 8. 领域状态机

### 8.1 MasteryItem

```text
                 订正曾错题入队 / 回访失败
                            │
                            ▼
                     ┌────────────┐
            ┌───────►│    open    │◄────────┐
            │        └─────┬──────┘         │
            │              │ review_at≤now  │ failed 回访
            │              ▼                │
            │        ┌────────────┐         │
            │        │    due     │─────────┤
            │        └─────┬──────┘         │
            │              │ 回访提交        │
            │         ┌────┴────┐           │
            │         ▼         ▼           │
            │   ┌────────┐ ┌─────────┐      │
            │   │ passed │ │ failed  │──────┘
            │   └────────┘ └─────────┘
            │         │
            │         │ 再次做错该点
            │         ▼
            │       open（重新计 review_at）
            │
            └── expired（长期未回访；新错可唤醒为 open）
```

### 8.2 MasteryReview

```text
in_progress → completed（submit 后）
           ↘ abandoned（超时可选，MVP 可不做）
```

---

## 9. 应用分层落点

| 层 | 改动 |
|----|------|
| `domain/` | 可选 `mastery/rules.ts`：到期判定、是否 passed、间隔计算（纯函数 + 单测） |
| `application/mastery/service.ts` | **新** 用例：入队、列表、开回访、提交、地图态 |
| `application/assignment/service.ts` | 订正成功钩子 → 调用 mastery 入队 |
| `application/progress/service.ts` | 日历 day 态扩展；streak 计算可放 mastery 或 progress |
| `infrastructure/persistence/db.ts` | 新表 migration 与现有 SQLite/MySQL 双路径一致 |
| `presentation/http/app.ts` | 注册 `/me/today`、`/me/mastery*` |
| `miniprogram/pages/student/home` | 分层 UI |
| `miniprogram/pages/student/task/*` | 成功页、错因 chips |
| `miniprogram/pages/student/knowledge` | 地图 |
| `miniprogram/pages/student/calendar` | 双态 + streak 文案 |
| `packages/content` | 可选：知识点掌握话术 `masteryCopy` 字段 |

**老师端**：本计划不强制改 UI。S5 以后若做「班内待巩固知识点 Top」，另开老师切片。

---

## 10. 文案与品牌

遵循 [brand-spec.md](../design/brand-spec.md)：纸本、铁锈橙 accent、墨绿完成；禁用游戏厅语气。

| 场景 | 推荐文案 | 禁止 |
|------|----------|------|
| 回访卡 | 「三天前那道坎，用 3 题再走一遍」 | 「惩罚练习」「你落后了」 |
| 回访通过 | 「这页可以折角了」 | 「Level Up」「SSS 评价」 |
| 回访未过 | 「还差一口气，过几天再来」 | 「失败！再做 20 题」 |
| 连续 0 天 | 「今天点亮一格就好」 | 「你已断签」 |
| 空页 | 「今日空页。可翻翻知识地图，或等老师布置。」 | 空白无说明 |
| 错因引导 | 「刚才错在哪？（可跳过）」 | 「必须选择错误类型」 |

掌握句模板（content 可配）：

```text
{knowledgeName}，今天过关了。
{knowledgeName} 从待巩固变成已过关。
```

---

## 11. 分阶段交付与验收

### Phase S1 — 首页契约 + 成功反馈 + 连续天数

**目标**：无新表验证粘性信息架构。

| 项 | 内容 |
|----|------|
| 后端 | 可选：streak API；可前端用现有 calendar 算连续 |
| 前端 | 首页分组必做/已完成；完成/订正成功页；连续天数展示 |
| 测试 | 前端为主；若有 streak 函数则单测边界（跨月、断天） |
| 验收 | [ ] 有未完成任务时「必做」区非空 |
|  | [ ] 订正成功出现前后正确率或完成确认（非仅 toast） |
|  | [ ] 连续完成多日显示 streak≥2 |
|  | [ ] 文案无恐吓/排行用语 |

### Phase S2 — 错因 + 入队

| 项 | 内容 |
|----|------|
| 后端 | 表 `mastery_items`；订正钩子 upsert；`GET /me/mastery` |
| 前端 | 订正错因 chips；知识页或「待巩固」列表 |
| 测试 | 订正有错→item open；全对不入队；同知识点合并 |
| 验收 | [ ] 做错并订正后列表出现待巩固 |
|  | [ ] 不填错因可提交；填了可存读 |
|  | [ ] 拍照作业订正/批改不产生 item |

### Phase S3 — 回访闭环

| 项 | 内容 |
|----|------|
| 后端 | `mastery_reviews`；start/submit；到期 due；首页 `review` 槽 |
| 前端 | 回访答题页（可复用 online 题 UI 精简版）；首页回访卡 |
| 测试 | D0 入队 → mock 时钟 D+3 → due → 全对 passed → 再错回 open |
| 验收 | [ ] 到期学生首页可见回访卡 |
|  | [ ] 回访不出现在老师作业列表 |
|  | [ ] 班级完成率分母不因回访变化 |
|  | [ ] 通过后待巩固移除或标已过关 |

### Phase S4 — 知识地图 + 日历双态

| 项 | 内容 |
|----|------|
| 后端 | `GET /me/mastery-map`；日历 state 扩展 |
| 前端 | 单元地图；半亮自助 5 题；日历 partial/review 点 |
| 验收 | [ ] 学生能区分亮/半/暗 |
|  | [ ] 半亮可发起巩固 |
|  | [ ] 日历顶栏月点亮 + 连续天数 |

### Phase S5 — 周小结 + 单元印戳（可选）

| 项 | 内容 |
|----|------|
| 后端 | 周聚合只读 API 或前端拼 |
| 前端 | 小结页/弹层；单元 lit 印戳 |
| 验收 | [ ] 小结含本周巩固通过的知识点名 |
|  | [ ] 可复制文本 |

---

## 12. 测试清单（自动化）

新建建议：`server/tests/mastery.test.ts`

| 用例 | 阶段 |
|------|------|
| 全对提交不入队 | S2 |
| 错→订正→open 且 review_at≈+3d | S2 |
| 同知识点两次错合并 miss_count | S2 |
| open 在 review_at 后变 due | S3 |
| 回访全对 → passed | S3 |
| 回访未过 → open 且新 review_at | S3 |
| 回访不创建 assignments 行 | S3 |
| skill_key 降级无知识点 | S2 |
| 堆积上限不无限增长 | S3 |
| 地图态 dark/half/lit 边界 | S4 |

---

## 13. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 待回访过多造成焦虑 | 首页只 1 条；上限 20；温和文案；可选 |
| 题源不足无法出 3 题 | 三级降级；仍不足则 1–2 题或提示「该点暂无练习题」 |
| 与老师完成率口径混淆 | 文档+代码隔离；验收必测老师 summary |
| 时区错误 | 一律业务日 `Asia/Shanghai`，与现作业截止一致 |
| MySQL/SQLite 双库 | 表结构变更走现有 `db.ts` 统一 bootstrap |
| 大会话/性能 | 地图按年级懒加载；回访题快照限制体积 |

---

## 14. 日志（排查）

对齐 `AGENTS.md`：

| 标签 | 时机 |
|------|------|
| `mastery.enqueue` | 入队成功（userId, knowledgeNodeId\|skillKey, reviewAt） |
| `mastery.enqueue.skip` | 跳过原因（all_correct / photo / cap） |
| `mastery.review.start` | reviewId, itemId, questionCount |
| `mastery.review.submit` | reviewId, passed, correctCount |
| `mastery.due.promote` | itemId 数（批量提升时） |

禁止打 token、完整题面 PII 过量；userId 可记。

---

## 15. 文档与导航

| 文档 | 关系 |
|------|------|
| [PRD.md](./PRD.md) | 本计划为 PRD 激励与学情方向的**学生向深化**，不修改 MVP 已定「无排行榜」 |
| [math-mini-mvp.md](../architecture/math-mini-mvp.md) | MVP Phase 1–12 之后的 **S1–S5** 增量 |
| [brand-spec.md](../design/brand-spec.md) | 文案与视觉约束 |
| 本文 | 实现与验收唯一规格来源（学生掌握感） |

实施时建议在 `math-mini-mvp.md` 文末增加一节「Post-MVP：Student Mastery S1–S5」链到本文。

---

## 16. 建议实施顺序（摘要）

```text
S1 首页分层 + 成功页 + streak     ← 先感知
S2 错因 + mastery_items 入队      ← 再有数据
S3 回访卷闭环 + 首页回访卡        ← 掌握心脏
S4 地图 + 日历双态                ← 中长期粘性
S5 周小结 + 印戳                  ← 可选抛光
```

**下一步（文档已定后）**：从 S1 开接口/页面切片；或先补 `math-mini-mvp.md` 链接与 schema 草案 PR。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-29 | 初稿：粘性/掌握感双循环、D1–D10、S1–S5、模型与 API、验收与日志 |
| 2026-07-29 | **S1 已实现**：首页必做/已完成分层 + 连续天数；`GET /me/calendar` 返回 `streakDays`/`monthLitDays`；在线/拍照提交成功反馈页；`domain/mastery/streak` 单测 |
| 2026-07-30 | **S2 已实现**：`mastery_items` + `answer_items.wrong_reason`；订正可选错因；订正完成后入队；`GET /me/mastery`；知识页「待巩固」；`tests/mastery.test.ts` |
| 2026-07-30 | **S3 已实现**：`mastery_reviews`；open→due 提升；start/submit 回访；首页回访卡；`pages/student/task/review`；不创建 Assignment |
| 2026-07-30 | **S4 已实现**：`GET /me/mastery-map`；半亮自助 5 题；日历 day state（done/partial/review_due）；知识页地图 UI |
| 2026-07-30 | **S5 已实现**：`GET /me/mastery/week-summary`；单元印戳（map.stamps / 本页练完）；学生小结页可复制；我的入口 |
