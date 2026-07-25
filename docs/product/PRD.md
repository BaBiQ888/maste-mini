# PRD：3–6 年级数学培训小程序（MVP）

| 字段 | 内容 |
|------|------|
| 产品名 | 数学小程序（暂定） |
| 版本 | MVP |
| 形态 | 微信小程序 |
| 用户 | 培训老师、学生 |
| 组织 | 单机构自用 |
| 状态 | 已定稿（基于产品访谈） |
| 日期 | 2026-07-25 |

---

## Problem Statement

校外 3–6 年级数学培训班里，老师每天要布置口算/计算、跟进知识点掌握、收作业并核对谁没交，往往依赖微信群、纸质本和表格，信息分散、催交费时、学情不透明。

学生端缺少「今天该练什么」的清晰任务入口，做完后对错与订正链路不完整，薄弱点难以持续巩固。

机构需要一个轻量、可在微信内完成的闭环工具：**能练、能打卡、能汇总**，而不是重型教务或完整 LMS。

---

## Solution

做一个面向培训老师与学生的微信小程序。老师建班并发邀请码/二维码，学生微信登录后入班。

老师可布置三类任务：

1. **每日计算**（规则自动出题 + 人工录入题）
2. **知识点打卡**（挂在自建简化知识树上）
3. **书面拍照作业**（学生上传照片，老师给对错/分数与文字评语）

学生在首页看到今日任务，完成在线客观题（自动批改；错题须订正后才算完成），并上传拍照作业。老师工作台展示班级完成率、未完成名单（可复制催交文案）、待批改列表与基础正确率汇总。

激励保持克制：打卡日历与完成勾选，不做排行榜与积分商城。

---

## User Stories

### A. 账号与身份

1. As a 新用户, I want 使用微信一键登录, so that 无需记密码即可进入小程序。
2. As a 用户, I want 首次登录时选择身份（老师 / 学生）, so that 进入对应工作台。
3. As a 老师, I want 完善昵称与头像（可默认微信资料）, so that 学生能识别是哪位老师。
4. As a 学生, I want 完善昵称与头像, so that 老师在名单中能认出我。
5. As a 用户, I want 在「我的」中退出或切换展示信息, so that 能管理个人资料。
6. As a 系统, I want 用微信 openid 绑定账号, so that 同一微信稳定对应同一用户。

### B. 班级与入班

7. As a 老师, I want 创建班级（名称、年级 3–6）, so that 按班管理学生与作业。
8. As a 老师, I want 为班级生成邀请码与入班二维码, so that 学生能快速加入。
9. As a 老师, I want 重置或刷新邀请码, so that 旧码失效、控制入班范围。
10. As a 老师, I want 查看本班学生列表, so that 确认谁已入班。
11. As a 老师, I want 将学生移出班级, so that 处理转班或误加。
12. As a 老师, I want 切换自己所带的多个班级, so that 不用反复退出。
13. As a 学生, I want 输入邀请码加入班级, so that 与老师的班关联。
14. As a 学生, I want 扫描入班二维码加入班级, so that 现场入班更省事。
15. As a 学生, I want 看到自己已加入的班级, so that 确认归属。
16. As a 学生, I want 在已入班前被引导去入班, so that 不会面对空白无任务首页。
17. As a 学生, I want 支持加入多个班级（若报了多个班）, so that 不同老师的任务都能收到。
18. As a 老师, I want 归档或停用班级（不再出现在日常列表）, so that 结课后界面干净。

### C. 知识树（简化自建）

19. As a 老师/系统, I want 使用预置的 3–6 年级简化知识树（年级 → 单元 → 知识点）, so that 布置打卡时有统一结构。
20. As a 老师, I want 按年级浏览知识点列表, so that 按教学进度选题。
21. As a 老师, I want 搜索知识点名称, so that 快速定位考点。
22. As a 学生, I want 在打卡任务中看到知识点名称与所属单元, so that 知道在练什么。
23. As a 学生, I want 在个人页看到已打卡/已掌握的知识点记录（简化列表即可）, so that 有完成感。
24. As a 运营/开发, I want 知识树以配置数据维护, so that 不改代码也能增补节点。

### D. 题库与出题

25. As a 老师, I want 系统按规则生成计算题（指定年级、运算类型、题量、难度）, so that 每日计算少手工出题。
26. As a 老师, I want 选择运算类型（如整数加减乘除、小数、分数基础、混合运算等 MVP 子集）, so that 贴合本节课训练目标。
27. As a 老师, I want 手工录入客观题（题干、题型、答案、解析可选）, so that 补充规则难以覆盖的题。
28. As a 老师, I want 录入题目时指定题型（填空 / 选择 / 判断）, so that 批改方式正确。
29. As a 老师, I want 将手工题关联到某知识点（可选）, so that 打卡任务能组卷。
30. As a 老师, I want 预览自动生成的题目再发布, so that 避免超纲或格式问题。
31. As a 老师, I want 重新生成一批计算题（未发布或草稿态）, so that 对题目不满意时可换一批。
32. As a 系统, I want 保存每道下发给学生的题面快照, so that 事后批改与统计不受题库改动影响。
33. As a 老师, I want 在布置时混合「规则生成题 + 手工选题」, so that 日常计算与精选题并存。

### E. 作业编排（布置）

34. As a 老师, I want 创建「每日计算」作业并设置截止时间, so that 学生有明确完成窗口。
35. As a 老师, I want 创建「知识点打卡」作业（选 1..N 个知识点 + 每点题量或题目）, so that 与课堂进度对齐。
36. As a 老师, I want 创建「拍照作业」并写说明（如页码、要求）, so that 学生知道拍什么。
37. As a 老师, I want 指定作业所属班级, so that 只下发给该班学生。
38. As a 老师, I want 设置作业标题与可选备注, so that 列表中易于识别。
39. As a 老师, I want 保存草稿稍后再发布, so that 备课不被打断。
40. As a 老师, I want 发布作业后学生立即在任务列表看到, so that 布置即时生效。
41. As a 老师, I want 下架或取消未完成的作业, so that 发错时能撤回。
42. As a 老师, I want 复制历史作业为模板再微调, so that 重复布置更快。
43. As a 老师, I want 为每日计算配置题量与限时（可选，整卷倒计时）, so that 兼顾速度训练。
44. As a 老师, I want 看到自己布置的作业列表（按状态/班级筛选）, so that 管理历史任务。

### F. 学生作答：在线客观题（每日计算 / 知识点打卡）

45. As a 学生, I want 在首页看到「今日待完成任务」列表, so that 打开就知道练什么。
46. As a 学生, I want 按任务进入答题页逐题作答, so that 完成每日计算或打卡。
47. As a 学生, I want 提交后立即看到每题对错与得分/正确率, so that 获得即时反馈。
48. As a 学生, I want 对错题进入「待订正」状态, so that 知道还必须改。
49. As a 学生, I want 订正错题并再次提交, so that 真正掌握后才算完成。
50. As a 系统, I want 仅当在线客观题全部答对（含订正后全对）才将任务标为「已完成」, so that 完成率反映真实过关。
51. As a 学生, I want 在截止后仍可查看题目与自己的作答（只读或仍可订正，产品默认：逾期可订正但标记逾期）, so that 学习不因逾期中断。
52. As a 学生, I want 若老师开启整卷限时，在倒计时结束时自动交卷, so that 限时规则可执行。
53. As a 学生, I want 答题中途离开后能从进度恢复（未提交的本地/服务端草稿）, so that 不因打断重做全部。
54. As a 学生, I want 查看题目解析（若有；默认提交后可见）, so that 错题能学会。

### G. 学生作答：拍照作业

55. As a 学生, I want 上传一张或多张作业照片, so that 提交纸质作业。
56. As a 学生, I want 删除重拍后的照片再提交, so that 拍糊了能重来。
57. As a 学生, I want 提交后看到状态「待批改」, so that 知道在等老师。
58. As a 学生, I want 收到批改结果（对错或分数 + 文字评语）, so that 知道老师反馈。
59. As a 学生, I want 若老师要求重交，能重新上传, so that 完成订正类书面作业。
60. As a 系统, I want 拍照作业在老师批改完成（且未要求重交）后标为「已完成」, so that 与汇总口径一致。

### H. 老师批改

61. As a 老师, I want 在工作台看到「待批改」数量, so that 优先处理积压。
62. As a 老师, I want 浏览某次拍照作业的学生提交列表, so that 逐人批改。
63. As a 老师, I want 查看学生上传的图片（支持缩放）, so that 看清字迹。
64. As a 老师, I want 给出总体结果：正确 / 部分正确 / 错误，或给出分数, so that 快速定性。
65. As a 老师, I want 填写文字评语, so that 指出问题或表扬。
66. As a 老师, I want 标记「需重交」, so that 学生重新上传。
67. As a 老师, I want 在线客观题无需手工批改（自动批）, so that 省时间。
68. As a 老师, I want 查看某次在线作业的逐题正确率, so that 知道共性错题。

### I. 完成情况汇总（核心）

69. As a 老师, I want 在工作台看到各班「今日/近期待完成作业」完成率, so that 一眼掌握整体进度。
70. As a 老师, I want 点进某次作业看到：已完成人数、进行中（含待订正）、未开始、逾期人数, so that 分层跟进。
71. As a 老师, I want 看到未完成学生名单, so that 精准催交。
72. As a 老师, I want 一键复制「催交文案」（含作业名、未交名单）, so that 粘贴到微信群。
73. As a 老师, I want 查看某学生个人维度：近期作业完成率与正确率, so that 约谈或补差有据。
74. As a 老师, I want 查看某次在线作业的班级平均正确率与用时（若有限时/计时）, so that 评估难度。
75. As a 老师, I want 按作业类型筛选汇总（计算 / 打卡 / 拍照）, so that 分类管理。
76. As a 学生, I want 在任务上看到自己的状态标签（待完成 / 待订正 / 待批改 / 已完成 / 逾期）, so that 状态清晰。
77. As a 学生, I want 用打卡日历看到本月哪些天完成了任务, so that 维持连续习惯。
78. As a 学生, I want 任务完成后有明确勾选/完成样式, so that 获得即时成就感。

### J. 提醒（MVP 轻量）

79. As a 学生, I want 未完成任务在首页与 Tab 上有红点/数字角标, so that 不被遗忘。
80. As a 老师, I want 待批改与异常完成率在工作台高亮, so that 主动处理。
81. As a 老师, I want 不依赖微信订阅消息也能完成催交（复制文案）, so that MVP 不受订阅授权阻塞。

### K. 边界与权限

82. As a 学生, I want 只能看到自己的作答与成绩, so that 隐私安全。
83. As a 老师, I want 只能管理自己创建或被授权的班级, so that 数据隔离。
84. As a 未入班学生, I want 被提示加入班级后才能接收作业, so that 流程不被卡死在空白页。
85. As a 系统, I want 对上传图片做大小与格式限制, so that 控制存储与性能。
86. As a 系统, I want 对接口做登录态校验, so that 未授权不能读写。

### L. 基础可用性

87. As a 用户, I want 主要列表支持下拉刷新, so that 看到最新状态。
88. As a 用户, I want 网络失败时看到明确错误提示并可重试, so that 弱网可用。
89. As a 老师, I want 空状态有引导（无班级时引导创建、无作业时引导布置）, so that 降低学习成本。
90. As a 学生, I want 空状态有引导（未入班、今日无任务）, so that 知道下一步做什么。

---

## Implementation Decisions

### 产品与范围决策（已确认）

| 决策点 | 结论 |
|--------|------|
| 角色 | 老师 + 学生（无家长端） |
| 练习形态 | 在线客观题 + 拍照作业 |
| 组织形态 | 单机构自用 |
| 知识体系 | 自建简化知识树，不绑具体教材版本 |
| 激励 | 打卡日历 + 完成勾选；无排行榜/积分商城 |
| 登录 | 微信一键登录 |
| 入班 | 邀请码 + 二维码 |
| 题源 | 规则自动出题 + 人工录入 |
| 提醒 | 应用内红点 + 老师复制催交文案 |
| 拍照批改 | 总体对错或分数 + 文字评语 |
| 订正 | 在线客观题错题必须订正全对才算完成 |
| PRD 口径 | 仅 MVP 可交付范围 |

### 模块划分（深模块）

以下模块对外接口宜保持稳定、狭窄；内部实现可独立演进与单测。

1. **Identity（身份）**  
   - 职责：微信登录、会话、角色（teacher/student）、基础资料。  
   - 对外：`loginWithWeChat`、`getCurrentUser`、`updateProfile`。

2. **ClassRoom（班级）**  
   - 职责：创建班级、邀请码/码刷新、入班、成员列表、移出、多班切换。  
   - 对外：`createClass`、`joinByCode`、`listMembers`、`removeMember`、`listMyClasses`。

3. **KnowledgeTree（知识树）**  
   - 职责：只读查询年级/单元/知识点；数据来自配置或种子表。  
   - 对外：`listNodes(grade)`、`searchNodes(keyword)`、`getNode(id)`。

4. **QuestionBank（题库与出题）**  
   - 职责：手工题 CRUD；计算题规则生成；生成结果预览；发布时题目快照。  
   - 对外：`createManualQuestion`、`generateDrillQuestions(spec)`、`snapshotQuestions(ids|generated)`。  
   - 生成规则 MVP 子集需明确参数：年级、运算类别、题量、数值范围、是否带余数等（实现时用配置表约束，避免超纲）。

5. **Assignment（作业编排）**  
   - 职责：草稿/发布/下架；三类作业统一模型；截止时间；班级范围；从历史复制。  
   - 对外：`createAssignment`、`publish`、`revoke`、`listAssignments`、`getAssignment`。  
   - 统一作业类型枚举：`daily_drill` | `knowledge_checkin` | `photo_homework`。

6. **Submission（作答与批改）**  
   - 职责：学生提交在线答卷、订正状态机、拍照上传、老师批改结果、完成判定。  
   - 对外：`startAttempt`、`submitAnswers`、`submitCorrection`、`submitPhotos`、`gradePhoto`、`getSubmission`。  
   - **完成状态机（在线客观题）**：`not_started` → `in_progress` → `pending_correction` → `completed`；可叠加 `overdue` 标记。  
   - **完成状态机（拍照）**：`not_started` → `submitted` → `completed` 或 `resubmit_required` →（重交）`submitted`。  
   - **自动批改**：规范化字符串/数值答案比较（去空格、分数形式约定、判断题布尔）；选择匹配 option id。

7. **Progress（学情汇总）**  
   - 职责：按作业聚合完成率、名单分层、个人近期完成率/正确率、逐题正确率。  
   - 对外：`getAssignmentSummary(assignmentId)`、`getClassDashboard(classId)`、`getStudentStats(studentId, classId)`。  
   - 完成率定义：分母 = 班级在册学生数；分子 = 状态为 `completed` 的人数（逾期完成仍计完成，但名单可标逾期）。

8. **NudgeCopy（催交文案）**  
   - 职责：根据未完成名单生成可复制文本。  
   - 对外：`buildReminderText(assignmentId)` → 纯字符串。  
   - 不负责发送到微信；仅剪贴板。

### 客户端信息架构（MVP）

**学生**  
- 首页（今日任务 + 红点）  
- 任务详情 / 答题 / 订正 / 拍照上传  
- 打卡日历  
- 我的（资料、班级、入班）

**老师**  
- 工作台（完成率、待批改、快捷入口）  
- 班级（列表、成员、邀请码/码）  
- 布置（计算 / 打卡 / 拍照）  
- 作业详情（汇总、名单、催交文案、批改入口）  
- 题库（手工录入简易入口）  
- 我的

### 数据实体（逻辑模型，非表名定稿）

- User（role, wx_openid, profile）  
- Class, ClassMembership, InviteCode  
- KnowledgeNode（grade, parent, name, path）  
- Question（type, stem, answer_payload, knowledge_node_id?, source: manual|generated）  
- Assignment（class_id, type, title, due_at, status, config_json）  
- AssignmentQuestion（assignment_id, order, question_snapshot_json）  
- Submission（assignment_id, student_id, status, score, overdue_flag, timestamps）  
- AnswerItem（submission_id, question_ref, response, correct, correction_round）  
- PhotoAsset（submission_id, url, order）  
- PhotoGrade（submission_id, result, score?, comment, require_resubmit）

### 技术澄清（实现约束）

- 客户端：微信小程序；后端语言/框架实现阶段自定，需提供 HTTPS JSON API。  
- 图片：走对象存储或微信云存储，API 只存 URL 与元数据。  
- 鉴权：登录换 session/token；老师/学生写操作鉴权到班级成员关系。  
- 单机构：无需 `org_id` 多租户；若预留字段可不暴露于 MVP UI。  
- 时间：统一服务器时区策略（建议 Asia/Shanghai）用于截止与「今日」。  
- 「今日任务」：学生端 = 已发布且（截止日≥今天或未完成）的本班作业，具体过滤规则实现时写清并在验收用例固定。

### 关键交互

- 布置每日计算：选班 → 配规则/选题 → 预览 → 设截止 → 发布。  
- 学生答题：进入 → 作答 → 提交 → 看对错 → 若有错进入订正页 → 全对 → 完成勾选。  
- 老师催交：作业汇总 → 未完成名单 → 复制文案 → 粘贴群。  
- 拍照批改：待批改列表 → 看图 → 结果+评语 → 完成或需重交。

---

## Testing Decisions

### 何为好的测试

- 只验证**对外行为与业务规则**，不绑定 UI 结构或私有函数名。  
- 给定输入与前置状态，断言状态迁移、返回 DTO、完成率数字。  
- 不测框架本身、不测微信 SDK 内部；微信登录用端口伪造。

### MVP 必测模块（核心业务域单测）

| 模块 | 必测行为 |
|------|----------|
| QuestionBank | 规则生成数量/题型约束；非法参数拒绝；快照与源题隔离 |
| Submission 自动批改 | 填空规范化；选择；判断；错题进入 pending_correction |
| Submission 订正 | 仅错题需改；全对后 completed；已完成不可再改答案（除非产品允许再练——MVP 默认完成后只读） |
| Submission 拍照 | 提交 → 待批改；批改完成；需重交后的再提交 |
| Progress | 完成率分母分子；分层人数；逾期标记不重复计人 |
| NudgeCopy | 文案包含作业名与未交昵称列表 |
| ClassRoom | 邀请码入班；失效码；移出后不可见作业 |
| Assignment | 发布后学生可见；下架后不可新开作答 |

### 暂不做（MVP）

- 全链路 UI 自动化  
- 订阅消息、支付、多租户隔离测试  
- 生成题的「教学科学性」人工题感评估（可用固定种子做快照测试）

### 验收方式

- 单测覆盖上表业务规则。  
- 另附手工验收清单（主路径：建班 → 入班 → 三类作业各一条 → 汇总与催交 → 批改）。

---

## Out of Scope

以下内容明确不在本 MVP PRD 内：

- 家长端、校长/多校区管理、多机构 SaaS 与计费  
- 微信订阅消息、短信、公众号模板推送  
- 排行榜、积分、勋章商城、班级 PK  
- 语音评语、AI 批改拍照作业、OCR 识题  
- 绑定具体教材版本（人教/北师等）的细粒度目录  
- 助教角色与细粒度权限  
- 题目打印、导出 Excel/PDF 周报  
- 视频微课、直播上课  
- 学生端自由刷题广场（非老师布置）  
- 复杂应用题步骤分、手写板逐笔迹批改  
- 内容审核人工台、敏感词运营后台（上线前按微信规范做最低必要处理即可，不单独立项为产品功能）  
- iOS/Android 独立 App、PC 管理端（除必要时的简单管理脚本）

---

## Further Notes

### 成功标准（MVP 上线可判定）

1. 老师可在 5 分钟内完成：建班 → 分享码 → 布置一次每日计算。  
2. 学生可在入班后 10 分钟内完成：一次在线任务（含如有错则订正）并看到完成状态。  
3. 老师可对一次作业看到完成率与未完成名单，并复制催交文案。  
4. 拍照作业可走通：上传 → 批改（结果+评语）→ 学生可见。  
5. 核心域单测通过；主路径手工验收通过。

### 风险与开放项（实现前可再定，不阻塞 PRD）

- 填空题答案的等价形式（如 `1/2` vs `0.5`）第一期建议：**老师录入时约定标准答案字符串，批改做有限规范化（trim、全半角）**，不做全面数学等价。  
- 规则出题覆盖的运算子集需教研给一版「MVP 运算清单」。  
- 学生多班时首页任务合并排序规则（按截止时间升序）。  
- 知识树种子数据由谁维护（开发预置一版 3–6 年级精简节点即可开工）。

### 建议的下一文档

- `docs/MVP-验收清单.md`（逐步勾选）  
- 或使用 `prd-to-plan` 拆为分阶段实现计划 / Issue

### 变更记录

| 日期 | 说明 |
|------|------|
| 2026-07-25 | 首版定稿：双端、三类作业、订正闭环、单机构、本地 PRD |
| 2026-07-25 | Phase 1–12 实现完成；见 docs/MVP-验收报告.md |
