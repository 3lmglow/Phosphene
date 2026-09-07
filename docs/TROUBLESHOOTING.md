# 故障排查

先记录：

- Phosphene commit 或镜像标签
- 部署方式与实例规格
- `/data` 挂载位置
- `/healthz` 响应
- 第一条错误及其相邻日志

日志和问题报告中不要包含密码、AI Token、Webhook 密钥、Cookie、任务正文或证据图片。

## 服务无法启动

### `/healthz` 不可用或容器反复重启

按顺序检查：

1. 构建是否成功。
2. 运行日志中的第一条错误。
3. `/data` 是否挂载到当前服务。
4. 服务用户是否能写入 `/data`。
5. 卷是否有剩余空间。
6. 实例是否触发内存上限。

### `EACCES` / permission denied

ready 之前报数据库或上传目录权限错误，说明运行用户不能写入持久卷。检查卷挂载对象与平台权限，不要把数据库路径临时改到容器其他目录。

### `ENOMEM` / out of memory

查看平台 Metrics，判断是应用内存峰值还是平台直接终止容器。图片提交和大型 ZIP 恢复需要更多内存与磁盘空间；先保留现有卷，再提高实例规格或减小单次操作。

### `ENOSPC` / no space left on device

扩容 `/data`。恢复期间 ZIP、当前图片和备份图片会同时占空间，估算方法见 [备份与恢复](BACKUP.md)。

## 重新部署后回到首次设置

这表示应用打开了新的空数据库，而不是普通登录失效。

检查：

1. 持久卷是否仍存在。
2. Mount Directory 是否精确为 `/data`。
3. 卷是否挂在当前 Phosphene 服务。
4. 新部署是否创建了另一块卷。
5. ready 日志中的 `dataDir` 是否为 `/data`。

先尝试重新挂回原卷，不要在空数据库上再次认领后继续使用。

Restart 保留数据、Redeploy 丢数据时，之前使用的是容器临时文件系统。

## MCP 连接

### 浏览器打开 `/mcp` 显示 405

正常。浏览器发送 GET，Streamable HTTP MCP 使用 POST。健康检查访问 `/healthz`。

### `401 ai_token_required`

- 检查是否发送了 `Authorization` 或 `X-Phosphene-MCP-Token`
- Bearer 格式是 `Bearer`、一个空格、完整 Token
- Header 配置在 AI 客户端，而不是 Phosphene 服务端环境变量

### `401 invalid_ai_token`

- 检查 Token 是否复制完整
- 确认网站中没有轮换过 Token
- 原 Token 无法找回；需要时再次轮换并更新客户端

### `401 conflicting_ai_token`

客户端同时发送了两个不同 Token。只保留一个 Header，或让两处值一致。

### 已连接但没有工具

- URL 以 `/mcp` 结尾
- Transport 是 Streamable HTTP / HTTP，不是旧 SSE
- stdio-only 客户端使用仓库的 `dist/server/stdio-bridge.js`
- 调用 `get_overview` 验证连接

完整配置见 [MCP 连接与工具](MCP.md)。

## 网站登录与写操作

### 设置密码时提示“含有不支持的字符”

首次设置和“设置 → 登录安全”中的新密码均须为 10–256 个字符，只支持大小写英文字母、数字和半角符号。不要求同时包含这几类字符，但不支持空格、中文、全角符号或不可见字符。

请切换到英文输入法，检查符号是否为半角：例如 `!` 可以使用，`！` 不可以。如果密码是粘贴的，请检查是否带入空格或其他不可见字符，必要时重新输入。页面会保留输入并提示错误，不会自动修剪、替换密码或继续提交。

此限制只针对新设置的密码；升级前已经保存的密码仍按原样验证。

### 密码始终错误

密码区分大小写。Phosphene 没有邮件找回入口，也不会保存密码原文。

升级到 v1.0.1 不会修改已有密码，也不会将全角符号转换成半角。登录时仍须输入与首次设置时完全一致的密码；如果原密码含有全角符号，请不要因为新规则而改用半角符号登录。

如果还有已登录设备，先导出网站 ZIP 并创建卷快照。删除数据库会同时删除全部业务数据，不是密码重置方式。

### CSRF 或安全令牌错误

1. 刷新页面。
2. 确认浏览器允许该站点保存 Cookie。
3. 始终从同一个 HTTPS 域名访问。
4. 清除该站点 Cookie 后重新登录。

### AI Token 轮换后客户端失效

轮换会立即撤销旧 Token。把新 Token 更新到每个 MCP 客户端，并重启需要重新读取环境变量的客户端。

## 任务与图片

### 每日任务没有出现

- 检查系列是否暂停或已经超过结束日期
- 检查实例时区与当天日期
- 调用 `get_overview` 或刷新任务页触发 reconciliation
- 查看任务是否已被取消、完成或逾期

### 暂停系列后历史任务变化

当前实现只取消当地今天及未来尚未提交的任务。已提交、已完成和过去的任务应保持不变。若不符合，保留系列 id、任务 id 与相关审计记录。

### 图片提交被拒绝

支持真实 JPEG、PNG 与 WebP。每次最多 4 张，单张最多 10 MB，单图最多 2400 万像素。HEIC/HEIF 需要先转换。

### AI 看不到图片

AI 使用：

```text
query_tasks(status="submitted", include_proof=true)
```

图片预览以 MCP image content 返回。客户端本身也需要支持显示 MCP 图片内容。

## 完成通知

### 任务完成了，但 Webhook 没送达

1. 打开“设置 → 完成通知”，确认已启用并订阅对应事件。
2. 发送测试事件。
3. 查看最近投递的 HTTP 状态与错误。
4. 接收端应在 10 秒内返回 2xx。
5. 停止重试的记录在修复接收端后手工重新排队。

关闭通知期间没有创建的 delivery 不会在重新启用后补发；AI 可以用 `query_history(kind="events")` 读取这些领域事件。

### 收到重复事件

Webhook 是 at-least-once 投递。以 `X-Phosphene-Event-Id` 或正文 `id` 去重，并对已处理事件继续返回 2xx。

### HMAC 签名不匹配

- 使用原始 HTTP body 字节
- 签名输入是 `timestamp + "." + raw_body`
- 算法是 HMAC-SHA256，Header 值带 `v1=` 前缀
- 使用 Webhook 签名密钥，不是 AI Token
- 密钥轮换后同步更新接收端

完整协议见 [完成通知](WEBHOOKS.md)。

### 事件轮询反复提醒同一事件

- 每个消费者单独保存 `after_sequence`
- 每个事件处理成功后，把游标推进到该事件的 `sequence`
- 整页处理完成时，游标才应等于响应的 `next_sequence`
- `has_more=true` 时从最后成功处理的 sequence 继续读取
- 使用 event id 做最终去重

## 备份与恢复

### `invalid_backup`

- 确认 ZIP 由 Phosphene 导出且下载完整
- 选择原始 ZIP，不要解压后重新打包
- version 1 和 version 2 可以直接导入
- 保留错误信息和恢复前卷快照

### 页面返回 `503 backup_maintenance`

导出或恢复正在使用维护锁。等待当前操作结束；`/healthz` 应继续返回 200。

### 恢复后图片异常

确认恢复明确返回成功，再定位具体任务与图片。保留 ZIP、任务 id 和相关日志。不要删除整个 `/data/uploads`。

### 更新后出现 migration 错误

1. 保留当前卷，不要持续重启。
2. 记录失败版本、上一版本和第一条 migration 错误。
3. 数据库兼容旧应用时回滚部署。
4. 不兼容时恢复匹配的旧版本与升级前卷快照。

## PWA

### 不能安装

PWA 需要 HTTPS，localhost 开发环境除外。Android、Chrome 和 Edge 使用浏览器安装入口；iPhone 与 iPad 使用 Safari“分享 → 添加到主屏幕”。

### 更新后仍显示旧界面

完全关闭已安装 PWA，再从浏览器打开网站并刷新一次。

离线缓存只保存应用壳层，不保存任务 API、MCP 或私有图片；断网时不能查看或提交最新业务数据。
