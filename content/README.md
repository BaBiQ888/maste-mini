# 内容种子（MVP）

> **状态：已确认定稿（2026-07-25）** · 版本见各 JSON `version` 字段  

本目录为**可导入配置数据**，与代码解耦。对应实现计划：

| 文件 | 用途 | 计划阶段 |
|------|------|----------|
| [`drill-operations.json`](./drill-operations.json) | 每日计算：运算类型与出题参数 | Phase 8 |
| [`knowledge-tree.json`](./knowledge-tree.json) | 知识点打卡：年级→单元→知识点 | Phase 9 |

人类可读说明见 [`docs/content-seeds.md`](../docs/content-seeds.md)。

## 原则

1. **不绑死教材版本**：按国内 3–6 年级通用能力点精简，非某版课本目录拷贝。
2. **MVP 可生成优先**：`drill-operations` 只收规则引擎能稳定出题、答案可自动批改的类型。
3. **配置可增补**：上线后只改 JSON/库表种子，不改业务代码路径。
4. **id 稳定**：`id` 一经发布勿改；展示名可改。

## 导入约定（实现时）

- 启动或迁移时 seed upsert：按 `id` 幂等写入。
- `enabled: false` 的条目不出现在老师布置 UI，可保留占位。
- 知识树 `type`: `grade` | `unit` | `knowledge`；仅 `knowledge` 可被作业引用。
