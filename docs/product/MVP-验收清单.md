# 算本 MVP 验收清单

| 字段 | 内容 |
|------|------|
| 对应 PRD | [PRD.md](./PRD.md) |
| 实现计划 | [plans/math-mini-mvp.md](../plans/math-mini-mvp.md) |
| 自动化 | `npm test`（server 域单测 + 主路径） |
| 更新日期 | 2026-07-25 |

---

## A. PRD 成功标准

| # | 标准 | 自动化覆盖 | 手工 |
|---|------|------------|------|
| 1 | 老师 5 分钟内：建班 → 分享码 → 布置每日计算 | `mvp-main-path` 建班+生成布置 | [ ] 开发者工具走通 |
| 2 | 学生入班后完成在线任务（含订正） | `mvp-main-path` 打卡错→订正 | [ ] |
| 3 | 老师看完成率/未完成名单 + 催交文案 | `mvp-main-path` summary + reminder-text | [ ] |
| 4 | 拍照：上传 → 批改 → 可见 | `mvp-main-path` + `photo-homework` | [ ] |
| 5 | 核心域单测通过；主路径验收 | 全部 54+ tests | [ ] |

---

## B. 核心域必测（PRD Testing Decisions）

| 模块 | 必测行为 | 测试文件 |
|------|----------|----------|
| QuestionBank | 三类题、快照隔离、草稿换题再发布 | `questionbank.test.ts` |
| Drill 生成 | 数量/非法参数/种子可复现 | `drill-generate.test.ts` |
| Submission 自动批 | 全对 completed；错→pending_correction | `online-answer.test.ts` |
| Submission 订正 | 仅错题；订正后 completed | `online-answer.test.ts` |
| Submission 拍照 | 提交/批改/需重交 | `photo-homework.test.ts` |
| Progress | 完成率、分层、移出学生 | `progress.test.ts` |
| NudgeCopy | 文案含作业名与未交昵称 | `progress.test.ts` |
| ClassRoom | 入班/错码/多班/权限 | `classroom*.test.ts` |
| ClassRoom ops | 刷新码/移出/归档 | `classroom-ops.test.ts` |
| Assignment | 发布可见/下架不可见/复制 | `photo-homework` / `phase11` / `mvp-main-path` |
| Knowledge | 树/搜索/打卡 | `knowledge.test.ts` |
| Analytics | 逐题率/学情/日历 | `analytics.test.ts` |
| Phase 11 | 二维码/复制/限时 force | `phase11.test.ts` |
| 权限 | 学生不可批改、他班不可见 | `mvp-main-path` permission |

运行：

```bash
npm test
```

---

## C. 手工验收主路径（建议 15 分钟）

### 准备

1. [ ] `npm run dev` 后端 :3000
2. [ ] 微信开发者工具打开 `miniprogram/`，关闭域名校验
3. [ ] 准备两个身份（清缓存或两个模拟器）：老师 / 学生

### 老师

4. [ ] 微信登录 → 选「老师」→ 工作台空态引导
5. [ ] 创建班级（年级 3–6）→ 见邀请码
6. [ ] 点「入班二维码」→ 出图
7. [ ] **每日计算**：生成预览 → 换一批 → 发布
8. [ ] **知识点打卡**：选题点 + 题库题 → 发布
9. [ ] **拍照作业**：布置并发布
10. [ ] 作业详情：完成率、未完成名单、「复制催交」
11. [ ] 复制作业为草稿（标题含「副本」）

### 学生

12. [ ] 登录选学生 → 输码或扫码入班
13. [ ] 今日任务见 3 类；未完成角标
14. [ ] 计算：作答 → 可故意答错 → 订正 → 完成勾选
15. [ ] 打卡：完成；题目上见知识点标签
16. [ ] 拍照：上传（注意 ≤2MB）→ 待批改
17. [ ] 日历：完成日点亮；知识点列表有记录

### 老师批改与学情

18. [ ] 批改拍照（结果+评语）→ 学生可见
19. [ ] 在线作业「逐题正确率」有数据
20. [ ] 班级成员 → 学情：近 14 天完成率

### 体验

21. [ ] 工作台/作业/今日：下拉刷新
22. [ ] 断后端：提示网络错误；恢复后可重试
23. [ ] 归档班级：默认列表隐藏；恢复可用

---

## D. 非阻塞已知项（上线可后置）

| 项 | 说明 |
|----|------|
| 限时强制交卷 | 依赖客户端倒计时 + `force`；杀进程后需再进页续计时 |
| 真机 apiBase | 需改 `app.js` 局域网 IP；正式环境配 HTTPS 域名 |
| 自定义头像 | MVP 用昵称首字 |
| 微信正式登录 | 需配置 `WECHAT_APPID` / `SECRET` |
| 二维码域名 | dataUrl 本地展示即可；若改外链需配置 downloadFile 域名 |
| 分数等价 | `1/2`≠`0.5`（PRD 约定） |
| 订阅消息催交 | 范围外；现用复制文案 |

---

## E. 验收签字

| 角色 | 结果 | 日期 |
|------|------|------|
| 开发自测 `npm test` | ☐ 通过 | |
| 手工主路径 | ☐ 通过 | |
| 产品确认可试用 | ☐ 通过 | |
