# 开发日志约定

> 目标：线上/预览出问题能靠日志定位，而不是靠猜。  
> 权威摘要同步在仓库根目录 `Agents.md`（Agent / 协作者默认读取）。

## 硬性要求

后续**所有功能开发、对接第三方、改关键路径**，都必须带可排查日志：

| 必须 | 说明 |
|------|------|
| 失败必打日志 | 含 code / errMsg / status / 业务 id / 环境信息 |
| 关键步骤有轨迹 | 至少 start → ok / fail（上传、登录、支付级流程） |
| 禁止静默失败 | 不可 `catch` 后空处理；若回退旧路径，日志写明「主路径失败 + 已回退」 |
| 用户文案与日志分离 | Toast/弹窗可短；Console / 服务端日志必须完整 |

## 小程序

- 统一：`logError(tag, err, extra)` → Console 前缀 `[suanben]`
- 流程：`console.info("[module.action] …", { … })`
- 示例 tag：`media.cloudUpload`、`http.401`、`cloud.fail`、`avatar.upload`

## 服务端

- 启动：`[math-mini]` 前缀
- 业务错误：`handleError` / `[AppError]` 保留 method、path、code
- 新集成：记录成功与失败结果，勿只 `throw`

## 禁止写入日志

- Token、AppSecret、数据库密码、整段 base64 图片

## 自检

改完问自己：

1. 用户只说「失败了」时，我能否根据 Console / 云托管运行日志定位？
2. 每个出站调用失败是否有日志？
3. 多步流程是否有 start/ok/fail？
