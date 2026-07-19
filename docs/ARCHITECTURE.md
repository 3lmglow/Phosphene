# Phosphene 1.0 架构

## 领域边界

Phosphene 是单实例、单 user、单 AI。该限制是产品边界，不是临时删减，因此没有 tenant id、公开注册、邀请、组织或角色管理复杂度。

## 服务边界

- Express 提供 REST、MCP、认证、上传和生产静态文件
- React/Vite 提供响应式网站
- Drizzle 提供统一关系模型、migration 与事务
- 默认 PGlite 保存业务数据、不可变积分账本、幂等响应和审计记录
- 默认私有目录保存重新编码后的图片与审核预览
- Sharp 在写入存储前验证并净化图片

默认生产实例把 PGlite 和图片都放在 `/data` 持久化卷中。应用重建只替换容器文件，不替换持久化卷。

可选分布式模式使用相同领域代码与 Drizzle schema，把数据库切换为 PostgreSQL，把图片切换为私有 S3/MinIO。生产不支持 PostgreSQL + 本地文件或 PGlite + S3 的混合拓扑，避免恢复时产生不一致。

## 任务模型

`task_series` 保存重复 daily 规则；`tasks` 保存每个自然日的独立实例。唯一索引 `(series_id, occurrence_date)` 保证重启、并发请求和网络重试不会生成重复实例。

系统在概览、查询和写操作前执行 reconciliation：

1. 按 user 时区生成截至今天的 daily 实例
2. 将已过截止时间且仍 pending 的任务标记 expired
3. 原子写入受余额限制的扣分
4. 从事实表重算日活动、连击、统计与成就

## 完成与延迟审核

self 任务提交后立即完成。ai_review 先写 submission 和 `submitted_at`；批准时 `completion_date` 使用 submission 在 user 时区对应的自然日，而不是审核日。

历史补入导致 streak bonus 变化时，系统追加差额 correction，不修改旧账本，以保持可审计性。

## 积分一致性

任务奖励、任务扣分、手工调整、连击和兑换全部进入 `point_ledger`。余额与累计指标从账本重算；每个结算事件具有唯一幂等键。

兑换在一个数据库事务中读取服务端价格、检查余额、创建 redemption、写负数账本与审计记录。

## MCP 边界

同一 Express 服务在 `/mcp` 提供无状态 Streamable HTTP MCP。AI 使用 Bearer Token；服务端只保存 Token 的 SHA-256 哈希。

AI 工具固定为 7 个，user 的提交、上传、设置和兑换保持在受会话及 CSRF 保护的网站 REST API 内。每项写操作都要求可复用的幂等键，以便客户端安全重试。

## 安全

- user：HttpOnly/SameSite Cookie + 独立 CSRF Cookie/Header
- AI：Bearer Token，数据库只保存 SHA-256
- 密码：Argon2id
- 写入口：Zod 校验、速率限制、审计日志
- 上传：Multer 内存限额 → Sharp 真格式/像素校验 → 重新编码 → 私有存储
- 容器：入口以 root 处理卷权限，随后通过 `gosu` 降权为 `node`
- 首次设置：有效环境 Token 优先；否则生成强随机 Token，以 `0600` 权限持久化，并仅在尚未初始化时写入私有部署日志
- 会话：浏览器 Cookie 本身是不可预测的随机令牌，数据库只保存 SHA-256，不依赖额外的静态签名秘密
- 生产配置：混合存储或单服务越界路径会导致拒绝启动

## 备份

导出 ZIP 包含版本化 JSON manifest 与所有图片对象。恢复先验证密码和 archive 完整性，再替换业务表与对象并运行 reconciliation；账户密码、会话和 AI Token 不参与覆盖。

单服务模式还应快照整个 `/data` 卷；分布式模式分别快照 PostgreSQL 与对象存储。
