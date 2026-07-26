# 部署须知（微信云托管）

## 血泪教训：构建失败反复踩坑

云托管 Docker 构建会执行：

```bash
cd server && npm run build   # 即 tsc -p tsconfig.json
```

**`tsc` 有任何 TypeScript 错误 → 镜像构建失败（exit 2）。**  
本地只跑 `npm test` 不够：测试用 vitest 转译，**不跑完整 `tsc` 编译**。

### 每次推送 / 部署前必须本地跑通

```bash
# 与云托管一致：类型检查 + 编译 + 测试
npm run predeploy
```

`predeploy` = `test` + `build`（`tsc` 失败则不通过）。

### 改后端时注意

1. **`async` 方法返回类型必须是 `Promise<T>`**，不能写成 `T`  
   - 错误：`async create(...): PublicAssignment`  
   - 正确：`async create(...): Promise<PublicAssignment>`
2. **`await` 只能出现在 `async` 函数里**；`.map()` 回调里用 `await` 要改成 `for` 或 `Promise.all`
3. **`return await this.xxx()!` 不可靠**（`null` 与 `Promise` 类型冲突），改成显式判空
4. **不要用 `deasync` + `mysql2`**：会阻塞事件循环，MySQL 查询永远超时
5. 云上若出现 **`ECONNRESET` / Connection lost**：已对瞬时断连做查询重试；仍失败时检查 MySQL 是否与服务同环境、密码是否正确
6. 改完后看版本：`/health` 的 `codeVersion` 应与 `Dockerfile` 里 `CODE_VERSION` 一致

### 云托管环境变量（运行时，不是构建参数）

| 变量 | 说明 |
|------|------|
| `MYSQL_ADDRESS` | 如 `10.17.104.40:3306`（云托管默认名） |
| `MYSQL_USERNAME` | 如 `root` |
| `MYSQL_PASSWORD` | 服务通知里的密码 |
| `MYSQL_DATABASE` | `math_mini` |
| `PORT` | **80**（HTTP 服务端口，不是 MySQL 端口） |

- MySQL 端口在 **ADDRESS 的 3306**，`PORT=80` 是 **Node 监听端口**
- 探针连的是 **容器 IP:80**，不是数据库 IP

### 部署方式

1. 流水线：目标目录**留空**，`Dockerfile` 用**仓库根目录**的 `Dockerfile`
2. 发布选 **执行流水线** 构建新镜像，不要选旧镜像
3. 成功后检查：`GET /health` → `codeVersion`、`dbDriver: "mysql"`

### 表结构

空库可执行：`docs/sql/math_mini_schema.sql`  
服务连上 MySQL 后也会自动 `CREATE TABLE IF NOT EXISTS`。
