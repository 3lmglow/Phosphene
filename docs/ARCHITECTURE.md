# 架构说明

本文面向维护者，说明 Phosphene 的组件边界与一致性设计。对外产品行为见 [产品与规则](PRODUCT_SPEC.md)。

## 设计范围

Phosphene 是单实例、单用户、单 AI 的自托管应用。生产拓扑是一套应用进程和一个 SQLite 持久卷：

```text
Browser / PWA ─┐
               ├─ Express ─ React static files
AI / MCP ──────┤           ├ REST API
               │           ├ Streamable HTTP MCP
               │           └ Webhook worker
               └─ /data ─── SQLite + private images
```

这个范围省去了 tenant、组织、外部数据库、对象存储和消息队列，同时让网站备份与恢复覆盖完整业务数据。

## 组件

| 组件 | 职责 |
| --- | --- |
| Express | 认证、REST、MCP、上传、静态网站和健康检查 |
| React / Vite | 响应式网站与 PWA |
| Drizzle / SQLite | 关系模型、migration、事务和持久化 |
| Sharp | 图片解码、格式与像素验证、重新编码、预览生成 |
| MCP SDK | 无状态 Streamable HTTP 工具服务与 stdio 转接 |
| Webhook worker | 领取 delivery、签名、发送、重试和停止重试 |

容器中数据库和图片都位于 `/data`。应用镜像可以替换，持久卷保持不变。

## 任务模型

`task_series` 保存每日重复任务规则，`tasks` 保存每个自然日的任务实例。

- `paused_at` 区分手动暂停与自然结束。
- 唯一索引 `(series_id, occurrence_date)` 防止重启、并发与重试生成重复实例。
- 暂停时只取消用户当地今天及以后的未提交实例。
- 恢复时按当前日期与截止时间恢复或生成实例。

任务提交保存在 `task_submissions`。每次尝试都有独立记录，图片通过对象 Key 关联。任务详情直接读取提交历史，因此驳回、重交和旧证据都可以回看。

## Reconciliation

概览、查询与写操作前会执行轻量 reconciliation：

1. 按用户时区生成缺失的 daily 实例。
2. 将超过截止时间且仍为 pending 的任务标记为 expired。
3. 为逾期任务写入受余额下限约束的扣分。
4. 在发生业务变化或派生数据不一致时重算日活动、连击、统计与成就。

没有业务变化的读取不会删除重建派生表。跨过自然日时只刷新需要变化的当前连击。

## 完成日期与延迟审核

`self` 提交立即完成。`ai_review` 先保存 submission 并进入 submitted。

AI 批准时，`completion_date` 使用用户提交时在其时区对应的自然日，而不是审核日期。若历史日期补入改变了后续连击奖励，系统向积分账本追加差额 correction，不改写已有流水。

## 积分与兑换事务

任务奖励、任务扣分、连击、AI 调整和兑换都写入 `point_ledger`。余额与累计指标可以从账本重算。

关键动作在单个 SQLite 事务中完成：

- 任务完成：更新任务与提交、写积分、更新派生统计、记录审计与领域事件
- 任务失败或逾期：更新任务、写受限扣分并记录审计
- 奖励兑换：读取服务端价格、检查余额、创建 redemption、扣分、记录审计与事件

AI 主动失败与 manual penalty 读取同一套用户边界，并按用户自然日共用每日上限。系统自动逾期使用 `actor=system`，不占用 AI 主动额度。

### 写事务排队

所有写入都经过 `db/client.ts` 中的 `runTransaction()`，在进程内按顺序排队执行。同一时刻只有一个 SQLite 写事务，网页、MCP 与 Webhook worker 同时写入时依次完成，不会因为抢写锁返回 `SQLITE_BUSY`。读查询不进入队列。

在一个事务内部再次调用 `runTransaction()` 会立即报错，而不是等待自己释放锁；需要组合多个步骤时，把已打开的 `tx` 传给下层函数。

Webhook worker 先用普通查询确认已启用且有到期投递，才开启事务；读取任务时，只有存在需要揭晓的惊喜任务才写入。没有请求时，实例不会产生写事务。

## 幂等

`idempotency_keys` 保存：

- key
- operation
- 规范化请求的 SHA-256
- 成功响应

同一 key、operation 和请求内容的重试返回原响应。operation 或内容变化时返回冲突。业务表上的唯一约束继续提供第二层一致性保护。

## MCP 边界

`/mcp` 提供无状态 Streamable HTTP。默认认证为静态 AI Token：

- 接受 `Authorization: Bearer`
- 接受 `X-Phosphene-MCP-Token`
- 数据库只保存 Token 的 SHA-256

Claude、ChatGPT 等应用通过 OAuth 取得访问令牌，权限与 AI Token 相同：

- 未认证的 `/mcp` 请求返回 401，并在 `WWW-Authenticate` 中给出受保护资源元数据地址。
- 授权服务器与资源服务器同源，issuer 取自请求的协议和 Host（经过一层反向代理）。
- 客户端可以动态注册，也可以用 HTTPS 的客户端元数据文档作为 client_id；元数据文档只从公网 HTTPS 地址获取，不跟随重定向，限制大小和超时。
- `/oauth/authorize` 校验客户端、回调地址与 PKCE 后跳转到网站的 `/connect` 确认页；只有已登录的用户能批准，任何人都可以拒绝。待确认的请求保存在进程内存中，10 分钟过期。
- 授权码 5 分钟有效、只能使用一次；访问令牌 1 小时，刷新令牌 90 天并在每次刷新时轮换。数据库只保存授权码和令牌的 SHA-256。
- 授权记录不进入网站 ZIP，恢复备份时也不会被覆盖。

只支持 stdio 的客户端使用本地 `stdio-bridge` 转发工具调用与图片结果，数据和权限仍由远程服务处理。

用户提交、上传、兑换与设置保留在网站 REST API 中；AI 的领域动作通过 MCP 完成。写工具都要求幂等键。

连接与工具契约见 [MCP 连接与工具](MCP.md)。

## 领域事件与 Webhook

任务提交、任务完成与奖励兑换在业务事务中调用统一事件服务：

1. 在 `domain_events` 写入不可变事件。
2. 自增 `sequence` 作为消费者游标。
3. 业务 `dedupe_key` 保证同一事实只记录一次。
4. Webhook 已启用且订阅该事件时，同事务创建 `webhook_deliveries`。

事件只带 ID、actor、状态、日期和积分等结构化事实。任务正文、证明文字和图片由 AI 通过 MCP 按需查询。

### Worker

进程内 worker：

1. 领取最早创建且已到期的 delivery。
2. 写入 30 秒 lease 与唯一 lease token。
3. 使用当前 Webhook 配置组成固定 JSON 请求。
4. 用 HMAC-SHA256 签名并发送。
5. 2xx 标记 delivered；其他结果安排下一次尝试。
6. 超过最大次数标记 dead letter。

过期 lease 可重新领取，因此进程崩溃不会永久卡住记录。投递采用 at-least-once 语义，接收端按 event id 去重。

当前 worker 以单进程为运行边界。

完整协议见 [完成通知](WEBHOOKS.md)。

## 图片存储

上传流程：

1. Multer 限制文件数与单图大小。
2. Sharp 解码并验证真实格式、像素与尺寸。
3. 按方向重新编码为 WebP，去除原元数据。
4. 保存净化后的完整图片与审核预览。
5. 数据库记录对象 Key、MIME、大小、SHA-256、尺寸与归属。

图片路由要求网站会话；MCP 只在查询证据时返回审核预览。

## 备份与恢复

导出与恢复共用维护锁：

- 先等待已进入的业务请求和投递结束
- 暂停新的 REST、MCP 与 Webhook 领取
- 保持 `/healthz` 可用

导出从同一 SQLite 读事务取得业务表快照，并流式写入 ZIP。恢复上传先落盘到 `/data/tmp`，逐项校验路径、大小、哈希、格式与像素。

恢复图片使用新的对象 Key。业务表替换、seed、reconciliation 和恢复审计在一个事务中完成；提交后再清理旧图片。Webhook 配置与实例凭据不从网站 ZIP 覆盖。

详细流程见 [备份与恢复](BACKUP.md)。

## 认证与安全边界

| 入口 | 保护 |
| --- | --- |
| 用户网站 | Argon2id 密码、HttpOnly/SameSite 会话、CSRF |
| MCP | AI Token 或 OAuth 访问令牌，数据库保存哈希 |
| Webhook | 独立 HMAC 密钥、timestamp 与 event id |
| 上传图片 | 类型、大小、像素验证与重新编码 |
| 恢复 ZIP | 磁盘暂存、路径白名单、大小与内容校验 |
| 写操作 | Zod、速率限制、幂等与审计日志 |

容器入口准备卷权限后，以 `node` 用户运行应用。SQLite 启用 foreign keys、WAL、NORMAL synchronous 和 busy timeout。
