# Phosphene MCP 使用说明

## 连接

- Transport：Streamable HTTP
- Endpoint：`https://YOUR_DOMAIN/mcp`
- 自定义 Header name / Key：`Authorization`
- 自定义 Header value：`Bearer phosphene_ai_你的完整Token`
- Token 在首次设置或网站“设置 → AI 连接”中生成，只显示一次

`Bearer`、一个空格和完整 Token 都属于 Header value。若 AI 后端把 URL 与 Token
分别保存为环境变量，推荐使用：

```env
PHOSPHENE_MCP_URL=https://YOUR_DOMAIN/mcp
PHOSPHENE_MCP_TOKEN=phosphene_ai_你的完整Token
```

后端请求时组成 `Authorization: Bearer ${PHOSPHENE_MCP_TOKEN}`；Token 变量本身不要
重复添加 `Bearer `。这些配置属于调用方 AI 客户端或 AI 后端，不是 Phosphene 服务端
环境变量。不要把 Token 放进 URL、浏览器前端变量、公开仓库或日志。

Phosphene 使用无状态 Streamable HTTP；同一个 Endpoint 同时接受 MCP 初始化和后续工具请求。

## 推荐系统提示

```text
你连接了用户自托管的 Phosphene。

创建或管理带日期的任务前先读取 get_overview 中的称呼、时区和队列，并尊重用户设置的
允许内容、禁止内容、惩罚暂停状态与每日扣分上限。只在有明确理由时创建任务，避免用大量
任务制造压力。

所有写操作都使用稳定且唯一的 idempotency_key；同一次意图的网络重试必须复用原 key，
新意图必须使用新 key。

需要 AI 确认的任务通过 query_tasks(status="submitted", include_proof=true) 审核。
图片会作为 MCP image content 一并返回。只有证据足够时才 approve；reject 时给出清楚、
不羞辱用户的 reason。

不要替用户兑换奖励，不要尝试修改用户边界，也不要把 Phosphene 数据发到其他服务。
```

## 工具契约

### create_task

仅 `daily` 可使用 `recurrence: daily`。Challenge 必须提供带时区偏移的 `deadline`。
Surprise 通常使用 `reveal_mode: next_visit`；定时揭晓使用 `at_time` + `visible_at`。

重复 daily 使用 `start_date`、可选 `end_date` 和 `daily_deadline_time`。创建结果返回
`series_id`，当天在有效范围内时还会返回首个任务实例。

### query_tasks

支持按 id、状态、类型、日期和 cursor 查询。AI 可以看见尚未向 user 揭晓的 surprise。
`include_proof: true` 会返回提交元数据，并把最多 12 张私有预览作为 MCP image content 返回。

### manage_task

- `edit`：只允许待完成任务
- `cancel`：取消，不扣分
- `fail`：判定失败并按规则扣分
- `review`：approve 或 reject 待审核提交
- `pause_series` / `resume_series`：暂停或恢复重复 daily

重复任务的 edit/cancel/fail 可选择 `occurrence` 或 `this_and_future`。

### get_overview

返回余额、累计获得/消费/扣除、当前/最长连击、总坚持天数、总完成数、分类统计、今日状态、
待完成数、待审核数、待履行兑换、最近成就、显示称呼和时区。

时区只在调用 `get_overview` 时作为一个小字段返回，并不会被附加到每次工具调用。积分、
连击和逾期结算始终由服务端负责；AI 只需在创建截止时间、定时惊喜或理解“今天/明天”时
使用它。

### query_history

`kind` 为 `all | tasks | points | redemptions | audit`。不要用历史接口轮询任务状态；
审核队列使用 `query_tasks(status="submitted")`。

### manage_rewards

AI 可列出、新建、修改、归档奖励，查询兑换并标记履行。预设只是初始内容，自定义奖励
不需要增加新的 MCP 工具。AI 不能主动替 user 消费。user 兑换后积分会立即扣除，兑换先
保持 `pending`；奖励真正兑现后再调用 `fulfill_redemption`。

### adjust_points

- `bonus`：额外奖励
- `penalty`：受 user 惩罚暂停与每日扣分上限约束，且余额不低于 0
- `correction`：明确的账本校正

`reason` 会原样进入 user 可见历史，应准确、克制且可理解。

## 幂等

写工具的 `idempotency_key` 为 8～128 字符。推荐：

```text
task-20260719-bedtime-water-v1
review-task_xxx-attempt-1
reward-create-song-right-v1
```

同一 key 用于不同操作会返回冲突；成功请求重试会返回原响应，不会重复发分、扣分、创建或兑换。
