# Phosphene 文档

这里按“先使用，再深入”的顺序组织文档。

## 第一次接触

1. [项目首页](../README.md)：先了解 Phosphene 是什么，并完成最短部署与连接。
2. [部署与运维](DEPLOYMENT.md)：fork 并构建自己的镜像，部署到容器平台或自己的服务器，正确挂载 `/data`。
3. [MCP 连接与工具](MCP.md)：把自己的 AI 客户端连接到 Phosphene。
4. [产品与规则](PRODUCT_SPEC.md)：理解任务、审核、积分、连击和奖励如何工作。

## 按需要阅读

| 你要做什么 | 阅读 |
| --- | --- |
| 从即将停止服务的 Zeabur 搬走 | [从 Zeabur 迁移](MIGRATE_FROM_ZEABUR.md) |
| 让 AI 在任务完成后及时响应 | [完成通知](WEBHOOKS.md) |
| 导出、迁移或恢复数据 | [备份与恢复](BACKUP.md) |
| 解决启动、登录、MCP、图片或通知问题 | [故障排查](TROUBLESHOOTING.md) |
| 了解当前仍存在的限制 | [已知问题](KNOWN_ISSUES.md) |
| 了解版本变化、升级影响与反馈致谢 | [版本更新说明](RELEASE_NOTES.md) |

## 开发与实现

- [架构说明](ARCHITECTURE.md)：数据模型、事务边界、reconciliation、事件投递与恢复一致性。
- [安全说明](../SECURITY.md)：部署边界、凭据和漏洞报告。

产品文档解释外部行为，架构文档解释为什么这样实现。
