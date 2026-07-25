# 内容种子 · packages/content

**架构角色**：配置 / 内容层（无业务代码）。

| 文件 | 用途 | 消费层 |
|------|------|--------|
| `drill-operations.json` | 每日计算运算与出题参数 | `domain/drill` |
| `knowledge-tree.json` | 年级→单元→知识点 | `application/knowledge` |

说明文档：`docs/product/content-seeds.md`。

根目录 `content/` 为兼容副本，**以本目录为准**。
