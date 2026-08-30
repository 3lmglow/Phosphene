# 完成通知

Phosphene 会在任务提交、完成和奖励兑换时保存事件，让 AI 不必反复查询全部任务才能发现变化。

## 选择接收方式

| AI 宿主 | 方式 |
| --- | --- |
| 有公网 HTTP 回调地址，并能在收到请求后启动一次 AI 运行 | Webhook |
| 没有回调入口，但能运行 scheduler、heartbeat 或定时任务 | 轮询 `query_history(kind="events")` |

Webhook URL 应指向你控制的接收服务。Phosphene 的 `/mcp`、网站首页和普通聊天页面都不是 Webhook 接收地址。

两种方式读取同一组领域事件。Webhook 负责尽快推送；事件轮询负责在宿主没有入站能力时补读。

## 事件

| 事件 | 发生时机 | 建议动作 |
| --- | --- | --- |
| `task.submitted` | 用户提交 `ai_review` 任务 | 查询任务与证据，若仍待审核则批准或驳回 |
| `task.completed` | self 任务完成，或 AI 审核通过 | 查询最新任务；对用户自助完成作出回应 |
| `redemption.created` | 用户兑换奖励 | 查询待履行兑换并处理 |
| `notification.test` | 用户发送测试 | 确认接收与验签链路 |

事件正文只包含 ID、状态、日期、积分和 actor 等结构化事实，不复制任务标题、证据文字或图片。消费者收到事件后再通过 MCP 查询当前内容，避免根据延迟到达的旧状态做决定。

## 方式一：Webhook

### 在网站中启用

1. 登录网站，打开“设置 → 完成通知”。
2. 填写接收端的 `http://` 或 `https://` URL；公网接收端使用 HTTPS。
3. 选择要订阅的事件并启用。
4. 轮换签名密钥，把只显示一次的 `phosphene_webhook_...` 保存到接收端。
5. 保存配置并发送测试事件。
6. 在页面下方确认投递状态为已送达。

Webhook 签名密钥用于验证 Phosphene 发出的请求；AI Token 用于接收端继续调用 MCP。两者用途不同。

### 请求格式

每次投递为 JSON `POST`：

```json
{
  "id": "event_...",
  "sequence": 42,
  "type": "task.completed",
  "version": 1,
  "created_at": "2026-08-30T04:00:00.000Z",
  "actor": "user",
  "aggregate": {
    "type": "task",
    "id": "task_..."
  },
  "data": {
    "task_id": "task_...",
    "submission_id": "submission_...",
    "status": "completed",
    "verification_mode": "self",
    "completion_date": "2026-08-30",
    "points": 4,
    "completed_by": "user"
  }
}
```

请求 Header：

```http
Content-Type: application/json
X-Phosphene-Event-Id: event_...
X-Phosphene-Event-Type: task.completed
X-Phosphene-Delivery-Id: delivery_...
X-Phosphene-Timestamp: 1788062400
X-Phosphene-Signature: v1=HEX_HMAC_SHA256
Idempotency-Key: event_...
```

### 验证签名

签名输入是：

```text
X-Phosphene-Timestamp + "." + 原始请求体字节
```

使用 Webhook 密钥计算 HMAC-SHA256，并与 `X-Phosphene-Signature` 中 `v1=` 后的十六进制摘要做恒定时间比较。

接收端处理顺序：

1. 保留原始 HTTP body，不要先 parse 后重新序列化。
2. 检查 timestamp 与当前时间的差距。
3. 验证 HMAC 签名。
4. 以 event id 建立唯一约束。
5. 已处理过的 event 直接返回 2xx。
6. 新 event 入队或启动 AI 运行后返回 2xx。

### 投递与重试

- 业务结果、领域事件和待投递记录在同一 SQLite 事务中提交。
- 只有 HTTP 2xx 视为送达；3xx 不会自动跳转。
- 网络错误、超时和非 2xx 会自动重试。
- 默认最多尝试 12 次，间隔从 5 秒逐步增加到最多 1 小时。
- 合法的 `Retry-After` 会被采用，范围限制在 1 秒到 1 小时。
- 超过上限后投递进入停止重试状态；修复接收端后可在设置页重新排队。

投递语义是 **at least once**。接收端可能收到同一个 event 多次，因此 event id 去重是协议的一部分。

### 修改或关闭配置

- 关闭通知后，已有待投递记录暂停；重新启用后继续。
- 关闭期间仍会保存领域事件，但不会为它们创建新的 Webhook delivery。
- 重新启用不会把关闭期间的事件自动补发为 Webhook；可通过事件轮询补读。
- 待重试记录会使用当前保存的 URL 和签名密钥。修改 URL 或轮换密钥后，接收端应同步更新。

## 方式二：事件轮询

每个消费者保存自己的 `after_sequence`。第一次从 0 开始：

```json
{
  "kind": "events",
  "after_sequence": 0,
  "limit": 100
}
```

处理规则：

1. 按 `sequence` 升序处理 `events`。
2. 每个事件处理成功后，把游标持久化为该事件自己的 `sequence`。
3. 整页全部处理成功时，持久化值才应等于响应的 `next_sequence`。
4. `has_more=true` 时，用最后成功处理的 sequence 作为 `after_sequence` 继续读取。
5. 使用 event id 做最终去重。
6. 没有新事件时，等宿主的下一次定时运行。

轮询频率由 AI 宿主决定。Phosphene 持久保存事件，不要求轮询任务持续在线。

## AI 消费流程

### `task.submitted`

1. 从事件读取 `task_id`。
2. 调用 `query_tasks(task_id=..., include_proof=true)`。
3. 若任务仍为 `submitted`，依据任务要求和提交证据审核。
4. 调用 `manage_task(action="review")`，批准或驳回。
5. 从 event id 派生稳定的幂等键；驳回时填写具体可执行的理由。

### `task.completed`

调用 `query_tasks(task_id=...)` 取得当前标题与状态。

- `completed_by="user"` 通常表示 self 任务，可向用户回应完成结果。
- AI 自己批准任务后产生的 completed event 可以跳过通知，避免对同一次审核重复回应。

### `redemption.created`

调用 `manage_rewards(action="list_redemptions")`，按事件中的 `redemption_id` 找到当前记录。仍为 pending 时处理并在真正兑现后调用 `fulfill_redemption`；已经 fulfilled 或 cancelled 时视为已处理。

### `notification.test`

只确认通知链路正常，不执行任务、积分或奖励动作。

## 备份与进程生命周期

网站 ZIP version 3 保存领域事件和 Webhook 投递历史，但不覆盖目标实例当前的 Webhook URL、订阅和签名密钥。

导出或恢复期间，worker 会停止领取新投递并等待正在发送的请求结束。进程崩溃时遗留的 processing lease 会在到期后重新领取。

备份详情见 [备份与恢复](BACKUP.md)，投递状态问题见 [故障排查](TROUBLESHOOTING.md)。
