# MCP 连接与工具

MCP 让现有 AI 客户端调用 Phosphene 的任务、积分与奖励能力。Phosphene 自身不运行 AI 模型。

## 连接信息

在网站“设置 → AI 连接”中取得：

- Endpoint：`https://你的地址/mcp`
- AI Token：首次设置或轮换后只显示一次

Transport 选择 **Streamable HTTP**，并发送：

```http
Authorization: Bearer phosphene_ai_你的完整Token
```

也可以使用：

```http
X-Phosphene-MCP-Token: phosphene_ai_你的完整Token
```

两种 Header 权限相同，选一个即可。Token 保存在 AI 客户端的私密配置或环境变量中，不写入 URL 或仓库。

连接后先调用 `get_overview`。成功返回称呼、时区、余额和当前队列，就表示 URL、Token 与 Transport 都正确。

## Claude、ChatGPT 等应用

Claude（网页版和手机 App）的自定义连接器、ChatGPT 网页版的自定义 MCP 服务器等应用，不需要填写 Token，通过授权页面连接：

1. 在应用中添加自定义连接器（Custom connector / Add custom MCP server），名称随意，地址填写 `https://你的地址/mcp`。认证方式有选项时选 **OAuth**。
2. 保存后点连接，应用会打开 Phosphene 的授权页面。
3. 浏览器还没有登录 Phosphene 时，先输入登录密码。
4. 确认页面上显示的返回地址是你正在使用的应用（例如 `claude.ai`、`chatgpt.com`），点 **允许连接**，页面会自动回到应用。

授权后，应用拥有和 AI Token 相同的权限。应用会自动续期，连续 90 天不使用需要重新授权。在 **设置 → AI 连接 → Claude、ChatGPT 等应用** 中可以看到已经授权的应用，并随时撤销。

地址需要使用域名：ChatGPT 不接受 `https://服务器IP/mcp` 这样的地址。容器平台分配的地址可以直接使用；自己的服务器没有域名时，见 [部署与运维](DEPLOYMENT.md#连接-chatgptclaude-等应用)。

以上流程已在 ChatGPT（Plus 账号，网页版添加自定义 MCP 服务器）中实测通过。能否添加自定义连接器、能否使用写入类工具，取决于应用本身和你的账号套餐。

## 通用配置

```json
{
  "mcpServers": {
    "phosphene": {
      "type": "http",
      "url": "https://YOUR_DOMAIN/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AI_TOKEN"
      }
    }
  }
}
```

客户端支持从环境变量读取 Bearer Token 时，优先让配置引用环境变量，而不是把 Token 直接写进配置文件。

### Codex

先把 Token 保存为本机环境变量，再添加远程 MCP：

```text
codex mcp add phosphene --url https://YOUR_DOMAIN/mcp --bearer-token-env-var PHOSPHENE_AI_TOKEN
```

重新启动 Codex 后，调用 Phosphene 的 `get_overview` 做一次验证。

### Claude Code

```text
claude mcp add --transport http phosphene https://YOUR_DOMAIN/mcp --header "Authorization: Bearer YOUR_AI_TOKEN"
```

### 自建 AI 后端

调用层可以保存：

```env
PHOSPHENE_MCP_URL=https://YOUR_DOMAIN/mcp
PHOSPHENE_MCP_TOKEN=phosphene_ai_你的完整Token
```

由服务端在请求中组成 Authorization Header。浏览器前端不应直接持有 AI Token。

## 只支持 stdio 的客户端

仓库构建产物包含 `dist/server/stdio-bridge.js`。客户端通过 stdio 启动它，转接器再连接远程 Phosphene：

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

使用前在仓库中运行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

转接器只转换传输方式，权限、审计和数据仍由远程 Phosphene 服务处理。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `create_task` | 创建一次性任务或每日重复任务 |
| `query_tasks` | 按条件查询任务，并读取提交与证据 |
| `manage_task` | 编辑、取消、判定失败、审核以及暂停或恢复系列 |
| `get_overview` | 读取积分、连击、统计、边界和当前队列 |
| `query_history` | 查询任务、积分、兑换、审计或领域事件 |
| `manage_rewards` | 管理奖励、查询兑换并标记履行 |
| `adjust_points` | 发放奖励、执行允许范围内的扣分或账本校正 |

用户提交任务、上传图片、兑换奖励和修改设置通过网站完成。

## 工具行为

### `create_task`

- `daily` 可以使用 `recurrence: once | daily`
- `challenge` 是一次性任务，并使用带时区偏移的 `deadline`
- `surprise` 可以在下次访问或指定 `visible_at` 时揭晓
- 新任务的证据要求使用 `none | text | text_and_image`
- 每日重复任务使用 `start_date`、可选 `end_date` 与 `daily_deadline_time`

创建重复任务会返回 `series_id`；当天位于有效日期范围内时，也会返回当天任务。

### `query_tasks`

支持按任务 id、状态、类型、日期与 cursor 查询。AI 可以看见尚未向用户揭晓的 surprise。

`include_proof: true` 会返回每次提交的文字、状态、驳回理由和图片元数据，并把私有审核预览作为 MCP image content 返回。

### `manage_task`

| action | 行为 |
| --- | --- |
| `edit` | 编辑仍在等待完成的任务 |
| `cancel` | 取消任务，不扣分 |
| `fail` | 判定失败并按规则扣分 |
| `review` | 批准或驳回待审核提交 |
| `pause_series` | 暂停每日重复系列 |
| `resume_series` | 恢复每日重复系列 |

驳回时提供明确的 `reason`。暂停系列会移除当天尚未提交的任务，不撤销已提交、已完成或历史记录。

重复任务的编辑、取消与失败可以选择当前 occurrence，或当前及未来任务。

### `get_overview`

返回：

- 双方称呼与用户时区
- 余额、累计获得/消费/扣除
- 当前与最长连击
- 总坚持天数和完成统计
- 今日状态、待完成、待审核与待履行数量
- 用户边界和最近成就

在创建带日期或“今天/明天”语义的任务前读取这里的时区。

### `query_history`

`kind` 支持：

- `tasks`
- `points`
- `redemptions`
- `audit`
- `events`
- `all`

事件模式用于没有入站 Webhook 的 AI 宿主。消费者从 `after_sequence: 0` 开始，按顺序逐条处理；每个事件成功后保存该事件的 `sequence`。整页处理完成时，该值应等于响应的 `next_sequence`。完整流程见 [完成通知](WEBHOOKS.md)。

### `manage_rewards`

支持列出、新建、修改、归档和恢复奖励，也可以查询兑换并在真正兑现后标记为已履行。标记履行时可以通过 `note` 留一段话，用户会在兑换记录和历史时间线中看到。

用户点击兑换时积分立即扣除，兑换保持 pending，直到 AI 完成约定。AI 不能替用户发起兑换。

### `adjust_points`

- `bonus`：额外奖励
- `penalty`：用户允许范围内的扣分
- `correction`：账本校正

`reason` 会显示在用户可见的积分历史中。penalty 服从惩罚暂停、每日上限和余额下限。

## 幂等键

所有写操作都要求 `idempotency_key`，长度为 8–128 个字符。

```text
task-20260830-bedtime-water-v1
review-task_xxx-attempt-1
reward-create-song-v1
```

同一次意图因网络问题重试时复用原 key。新的意图使用新的 key。同一 key 若对应不同操作或不同请求内容，服务端会返回冲突。

## 给 AI 的上下文建议

连接 Phosphene 时，告诉 AI：

1. 创建带日期的任务前先读取 `get_overview` 中的称呼、时区和用户边界。
2. 审核队列使用 `query_tasks(status="submitted", include_proof=true)`。
3. 写操作使用稳定幂等键，重试同一意图时复用。
4. 奖励只能由用户兑换；AI 在实际兑现后标记履行。
5. 若要主动获知新提交与完成事件，按 [完成通知](WEBHOOKS.md) 选择 Webhook 或事件轮询。

## 兼容性与排错

- 浏览器打开 `/mcp` 返回 405 是正常的；Streamable HTTP 通过 POST 工作。
- 健康检查访问 `/healthz`。
- 401 通常来自 Token 缺失、复制不完整或轮换后仍使用旧 Token。
- 已连接但没有工具时，检查 URL 是否以 `/mcp` 结尾、Transport 是否为 Streamable HTTP。
- 只支持旧 SSE 的客户端不能直接连接当前 Endpoint。
- 授权页面提示“连接请求无效”或“已经过期”时，回到应用重新点连接。授权请求 10 分钟内有效。
- 授权连接遵循 MCP 授权规范：OAuth 2.1 授权码流程、PKCE（S256）、动态客户端注册（DCR）与客户端元数据文档（CIMD），授权响应带 `iss`。发现地址为 `/.well-known/oauth-protected-resource/mcp` 与 `/.well-known/oauth-authorization-server`。

更多症状见 [故障排查](TROUBLESHOOTING.md)。

## 无 Header 的可信本地客户端

调用方与 Phosphene 位于同一设备或隔离私网、且客户端完全不能发送 Header 时，可以在服务端设置：

```env
PHOSPHENE_MCP_AUTH_MODE=none
```

重启后生效。公网部署保持默认 `token`。
