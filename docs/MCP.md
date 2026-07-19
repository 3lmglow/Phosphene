# Phosphene MCP 使用说明

## 服务入口

Phosphene 使用无状态 Streamable HTTP，所有七个工具都位于：

```text
https://YOUR_DOMAIN/mcp
```

同一个 Endpoint 接受初始化与后续工具请求。服务端不需要 MCP Session ID，客户端也不应
另外添加 `/sse`、`/mcp-extra` 或工具专属路径。默认鉴权模式始终是 `token`，升级不会改变
既有连接。

## 静态 Token

Token 在首次设置或网站“设置 → AI 连接”中生成，只显示一次。以下两种请求头任选一个：

```http
Authorization: Bearer phosphene_ai_你的完整Token
```

```http
X-Phosphene-MCP-Token: phosphene_ai_你的完整Token
```

如果同时发送，两个 Token 必须一致。服务器日志会清除这两个 Header；Token 仍然不能进入
URL、浏览器前端变量、公开仓库或截图。

调用方推荐保存：

```env
PHOSPHENE_MCP_URL=https://YOUR_DOMAIN/mcp
PHOSPHENE_MCP_TOKEN=phosphene_ai_你的完整Token
```

再由调用方拼接 `Authorization: Bearer ${PHOSPHENE_MCP_TOKEN}`。这些不是 Phosphene
服务端环境变量。

## stdio 转接

`dist/server/stdio-bridge.js` 是本地传输适配器。它对桌面客户端暴露 stdio，对 Phosphene
服务仍使用上述 Streamable HTTP，因此权限、审计、Token 轮换和数据源均保持一致。

构建仓库后使用：

```json
{
  "mcpServers": {
    "phosphene": {
      "command": "node",
      "args": ["/absolute/path/to/Phosphene/dist/server/stdio-bridge.js"],
      "env": {
        "PHOSPHENE_MCP_URL": "https://YOUR_DOMAIN/mcp",
        "PHOSPHENE_MCP_TOKEN": "phosphene_ai_你的完整Token"
      }
    }
  }
}
```

转接器会透传工具 JSON Schema、文字结果、结构化结果和图片内容。URL 只有 origin 时自动
补 `/mcp`；出于泄漏风险，含用户名、密码、查询参数或 fragment 的 URL 会被拒绝。

## 可选免鉴权

仅当调用方与 Phosphene 同机或位于隔离的可信网络，而且客户端无法添加任何 Header 时，
在 Phosphene 服务端设置：

```env
PHOSPHENE_MCP_AUTH_MODE=none
```

该值需要重启进程才会生效。默认值 `token` 不变；切回 `token` 后之前未撤销的 AI Token
继续有效。公网实例、可被他人访问的局域网和浏览器 JavaScript 均不应使用 `none`。

## 客户端速查

### Claude Code

```bash
claude mcp add --transport http phosphene https://YOUR_DOMAIN/mcp \
  --header "Authorization: Bearer YOUR_AI_TOKEN"
```

### 自建 AI 后端

使用服务端环境变量保存 URL 与原始 Token，请求时添加任一受支持 Header。不要在浏览器
bundle 中注入凭证，也不要为跨域浏览器直连打开宽泛 CORS。

### Operit / Android 本地桥

- 同机 URL 使用 `http://127.0.0.1:PORT/mcp`
- transport 选择 Streamable HTTP
- 能发送 Header 就保留 `token`
- 完全不能发送 Header 时，只在同机回环使用 `none`
- 远程 Zeabur URL 必须使用 HTTPS 与 Token

### Claude.ai 与 Claude 手机端

Phosphene 尚未实现 OAuth 2.1 授权服务器，因此不把静态 Token 模式描述成 Claude.ai
远程连接器兼容。将公网服务改为 `none` 虽可能绕过认证步骤，却会同时取消全部 MCP 访问
控制，不属于安全方案。

## 握手排错

| 现象 | 检查项 |
| --- | --- |
| `401 ai_token_required` | Header 名是否正确，Bearer 后是否有一个空格 |
| `401 invalid_ai_token` | Token 是否复制完整、已轮换或撤销 |
| `401 conflicting_ai_token` | 不要同时发送不同的 Authorization 与专用 Header |
| 没有工具 | URL 是否以 `/mcp` 结尾，客户端是否真的使用 Streamable HTTP |
| stdio 启动即退出 | 本机是否已构建，以及两个 `PHOSPHENE_MCP_*` 调用方变量是否存在 |
| 安卓客户端一直等待 | 改用 `127.0.0.1`，核对端口和 transport；旧 SSE-only 客户端需升级 |

GET `/mcp` 返回 405 是无状态 Streamable HTTP Endpoint 的正常行为；实际 MCP 消息通过
POST 发送。健康检查应访问 `/healthz`，不要用浏览器直接打开 `/mcp` 判断是否可用。

## 推荐系统提示

```text
你连接了用户自托管的 Phosphene。

创建或管理带日期的任务前先读取 get_overview 中的称呼、时区和队列，并尊重用户设置的
允许内容、禁止内容、惩罚暂停状态与每日扣分上限。只在有明确理由时创建任务，避免用大量
任务制造压力。

如果 punishments_paused=true，不要调用 manage_task(action="fail") 或
adjust_points(kind="penalty")；服务端也会拒绝这两类 AI 主动惩罚。任务失败扣分与手动 AI
扣分共用每日上限，系统自动逾期不占用这项额度。

所有写操作都使用稳定且唯一的 idempotency_key；同一次意图的网络重试必须复用原 key，
新意图必须使用新 key。

需要 AI 确认的任务通过 query_tasks(status="submitted", include_proof=true) 审核。
新任务的 `proof_requirement` 只使用 `none | text | text_and_image`，不要创建纯图片或
“文字/图片二选一”的任务。图片会作为 MCP image content 一并返回；若当前 AI 客户端不能
渲染图片，应依据同时提交的文字判断，不得臆测图片内容。只有证据足够时才 approve；
reject 时给出清楚、不羞辱用户的 reason。

不要替用户兑换奖励，不要尝试修改用户边界，也不要把 Phosphene 数据发到其他服务。
```

## 工具契约

### create_task

仅 `daily` 可使用 `recurrence: daily`。Challenge 必须提供带时区偏移的 `deadline`。
Surprise 通常使用 `reveal_mode: next_visit`；定时揭晓使用 `at_time` + `visible_at`。
AI 可用的证据要求固定为 `none | text | text_and_image`。这一限制只影响新建任务，
已有 `image` 或 `text_or_image` 任务仍可正常提交和审核。

重复 daily 使用 `start_date`、可选 `end_date` 和 `daily_deadline_time`。创建结果返回
`series_id`，当天在有效范围内时还会返回首个任务实例。

### query_tasks

支持按 id、状态、类型、日期和 cursor 查询。AI 可以看见尚未向 user 揭晓的 surprise。
`include_proof: true` 会返回提交元数据（包括审核状态与打回理由），并把最多 12 张私有预览
作为 MCP image content 返回。

### manage_task

- `edit`：只允许待完成任务
- `cancel`：取消，不扣分
- `fail`：判定失败并按任务规则扣分；服从 user 的惩罚暂停，并与手动 AI 扣分共用每日上限
- `review`：approve 或 reject 待审核提交；reject 必须填写明确、可执行的 `reason`
- `pause_series` / `resume_series`：暂停或恢复重复 daily。暂停立即取消当天尚未提交的实例，
  但不撤销已提交、已完成或历史记录；当天截止前恢复时会恢复由暂停取消的当日实例

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

AI 可列出、新建、修改、归档、恢复奖励，查询兑换并标记履行。归档会把项目从 user
兑换页移除但保留历史，`restore` 可重新上架。预设只是初始内容，自定义奖励
不需要增加新的 MCP 工具。AI 不能主动替 user 消费。user 兑换后积分会立即扣除，兑换先
保持 `pending`；奖励真正兑现后再调用 `fulfill_redemption`。

### adjust_points

- `bonus`：额外奖励
- `penalty`：受 user 惩罚暂停与每日扣分上限约束，且余额不低于 0
- `correction`：明确的账本校正

`reason` 会原样进入 user 可见历史，应准确、克制且可理解。
当余额为 0 时，`penalty` 会返回 `entry: null`、`applied_amount: 0`，并把本次意图作为
幂等的安全 no-op 记录下来；负数 correction 不能把余额降到 0 以下。

## 幂等

写工具的 `idempotency_key` 为 8～128 字符。推荐：

```text
task-20260719-bedtime-water-v1
review-task_xxx-attempt-1
reward-create-song-right-v1
```

同一 key 用于不同操作会返回冲突；成功请求重试会返回原响应，不会重复发分、扣分、创建或兑换。
