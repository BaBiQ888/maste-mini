# MVP 内容种子说明

| 字段 | 内容 |
|------|------|
| 状态 | **已确认（MVP 定稿）** |
| 确认日期 | 2026-07-25 |
| 版本 | content `1.0.0` |

机器可读数据：

- [`packages/content/drill-operations.json`](../../packages/content/drill-operations.json) — 每日计算运算清单  
- [`packages/content/knowledge-tree.json`](../../packages/content/knowledge-tree.json) — 知识树  

对应计划：**Phase 8（出题）**、**Phase 9（打卡）**。

### 已确认的产品约定

1. **带余数答案**：标准存储/批改主格式为 `q...r`（例 `12...3`）；实现时可兼容 `12余3`、`商12余3` 并规范化为主格式。  
2. **分数答案**：MVP 只接受**最简** `p/q`，不接受未约分；不做 `1/2`≡`0.5`。  
3. **知识树文案**：沿用当前通用单元/知识点名称；若日后贴本校讲义，**只改 `name`，不改 `id`**。  
4. **分数乘除 / 小数乘小数 / 百分数生成**：仍列在 `deferredNotInMvp`，不进 Phase 8 生成器；可用手工题或拍照覆盖。

---

## 1. 运算清单（规则出题）

### 1.1 覆盖一览

| 类别 | 运算 id | 名称 | 适用年级 |
|------|---------|------|----------|
| 整数 | `int_add_2d` | 两位数加法 | 3 |
| 整数 | `int_sub_2d` | 两位数减法 | 3 |
| 整数 | `int_add_within_10000` | 万以内加法 | 3–4 |
| 整数 | `int_sub_within_10000` | 万以内减法 | 3–4 |
| 整数 | `int_mul_table` | 表内乘法 | 3 |
| 整数 | `int_div_table` | 表内除法（整除） | 3 |
| 整数 | `int_mul_1d_2d` | 一位数×两位数 | 3–4 |
| 整数 | `int_mul_2d_2d` | 两位数×两位数 | 4 |
| 整数 | `int_div_1d_exact` | 一位数除法（整除） | 3–4 |
| 整数 | `int_div_1d_remainder` | 一位数除法（带余） | 3–4 |
| 整数 | `int_div_2d_exact` | 两位数除法（整除） | 4–5 |
| 小数 | `dec_add` / `dec_sub` | 小数加减（≤2 位） | 4–5 |
| 小数 | `dec_mul_int` | 小数×整数 | 5 |
| 小数 | `dec_div_int` | 小数÷整数（除尽） | 5 |
| 分数 | `frac_same_den_add/sub` | 同分母加减 | 3、5 |
| 分数 | `frac_diff_den_add/sub` | 异分母加减（分母≤12） | 5–6 |
| 混合 | `mixed_add_sub_mul_div` | 整数两步四则 | 4–6 |
| 单位 | `unit_length_mm_cm_m` | 长度换算 | 3–4 |
| 单位 | `unit_time_h_min_s` | 时间换算 | 3–4 |
| 单位 | `unit_area_cm2_m2` | 面积换算 | 4–5 |

**合计：23 种**可启用运算（`enabled: true`）。

### 1.2 布置时老师可选参数

- **运算类型**（上表 id）  
- **难度**：`basic` | `normal` | `challenge`（映射到各运算的数值范围/进退位偏好）  
- **题量**：建议 10 / 15 / 20 / 30  
- **整卷限时（秒）**：不限 / 180 / 300 / 600  

### 1.3 答案与批改约定（种子层）

| 答案类型 | 约定 |
|----------|------|
| `integer` | 整数字符串，trim + 全半角 |
| `decimal` | 去尾随 0；MVP **不做** `0.5`≡`1/2` |
| `fraction` | 只接受**最简** `p/q`；不接受未约分 |
| `quotient_remainder` | 标准存 `q...r`；可接受 `12余3` 等 pattern（实现时规范化） |

### 1.4 明确延期（不进 MVP 生成器）

- 分数乘除、小数乘小数、百分数互化、纯竖式步骤题  

（可用手工题或拍照作业覆盖。）

### 1.5 生成器 kind（实现索引）

| kind | 用途 |
|------|------|
| `binary_op` | 二元整数加减乘 |
| `div_exact` / `div_remainder` | 除法整除 / 带余 |
| `decimal_binary` / `decimal_mul` / `decimal_div_exact` | 小数 |
| `fraction_same_den` / `fraction_diff_den` | 分数 |
| `mixed_two_step` | 两步混合（含括号 pattern） |
| `unit_convert` | 单位换算 |

实现 Phase 8 时按 `kind` 分发，不要为 23 个 id 写 23 套完全独立逻辑。

---

## 2. 知识树

### 2.1 结构

```text
grade（年级）
 └── unit（单元）
      └── knowledge（知识点）← 仅此级可挂打卡作业
```

### 2.2 规模（约）

| 年级 | 单元数 | 知识点数（约） |
|------|--------|----------------|
| 三 | 7 | ~22 |
| 四 | 8 | ~22 |
| 五 | 7 | ~24 |
| 六 | 7 | ~21 |
| **合计** | **29 单元** | **89 知识点** |

### 2.3 标签 `tags`（便于筛选）

| tag | 含义 | 典型用途 |
|-----|------|----------|
| `drill` | 适合每日计算联动 | 布置时推荐运算 |
| `calc` | 计算类 | 在线客观题 |
| `concept` | 概念理解 | 手工题/拍照 |
| `geometry` | 图形测量 | 多为手工/拍照 |
| `word` | 应用题 | 多为手工/拍照 |
| `algebra` / `stats` | 方程/统计 | 手工题 |

### 2.4 与运算清单的交叉引用

- 知识点字段 `suggestedDrillOps`: 推荐的 `drill-operations.id`  
- 运算字段 `relatedKnowledgeIds`: 反查知识点  

**仅作推荐**，不强制布置绑定。概念/几何/应用题 `suggestedDrillOps` 为空 → 打卡依赖手工题。

### 2.5 年级默认运算包

见 `drill-operations.json` → `gradeDefaultOperations`：老师选班级年级后可一键勾选「本年级常用计算」。

---

## 3. 评审清单（内容验收）

- [x] 带余数答案：`12...3` 为主，兼容 `12余3` 等  
- [x] 分数：只收最简 `p/q`  
- [x] 知识树名称：MVP 用通用名；改名不改 id  
- [x] 分数乘除等生成：延期，不进 MVP  
- [x] 交叉引用校验通过（2026-07-25）  
- 备注：三年级若日后缺「连续加减」等，**新增 id**，不改现有 id  

---

## 4. 与 PRD / Plan 的挂钩

| 文档 | 关系 |
|------|------|
| PRD US 25–26, 19–24 | 本种子直接支撑 |
| Plan Phase 8 | 读 `drill-operations.json` 实现 generate |
| Plan Phase 9 | seed 导入 `knowledge-tree.json` |
| PRD 批改：有限规范化 | 与 §1.3 一致 |

---

## 5. 变更规则

1. **禁止**随意修改已发布的 `id`（学生历史快照外的配置引用会断）。  
2. 新增运算/知识点：新 `id` + `enabled: true`。  
3. 下线：`enabled: false`，不要物理删除（历史作业可能仍展示名称缓存）。  
4. 改展示文案：只改 `name` / `stemTemplate` 说明文档。  
