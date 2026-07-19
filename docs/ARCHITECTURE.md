# Phosphene 1.0 架构

## 领域边界

Phosphene 是单实例、单 user、单 AI。该限制是产品边界，不是临时删减，因此没有 tenant id、公开注册、邀请、组织或角色管理复杂度。

## 服务边界

- Express 提供 REST、MCP、认证、上传和生产静态文件
- React/Vite 提供响应式网站
- Drizzle 提供统一关系模型、migration 与事务
- 嵌入式 SQLite 保存业务数据、不可变积分账本、幂等响应和审计记录
- 默认私有目录保存重新编码后的图片与审核预览
- Sharp 在写入存储前验证并净化图片

生产实例把 SQLite 数据库和图片都放在 `/data` 持久化卷中。应用重建只替换容器文件，不替换持久化卷。产品只支持这一种单实例拓扑，避免一人一 AI 场景承担多服务部署、跨存储备份与恢复不一致。

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

AI 主动调用 `manage_task(action="fail")` 与 `adjust_points(kind="penalty")` 都读取 user
惩罚设置，并依据审计事实共用同一自然日的 AI 扣分上限。系统自动处理逾期时使用
`actor=system`，不占用 AI 主动惩罚额度。

## MCP 边界

同一 Express 服务在 `/mcp` 提供无状态 Streamable HTTP MCP。默认使用静态 AI Token，
同时接受标准 `Authorization: Bearer` 与 `X-Phosphene-MCP-Token`；服务端只保存 Token 的
SHA-256 哈希。`PHOSPHENE_MCP_AUTH_MODE=none` 只作为同机/可信内网兼容开关，公网部署
保持默认 `token`。

只支持 stdio 的客户端可运行本地 `stdio-bridge`，由它把工具列表、调用与图片结果转发到
原 `/mcp`。桥接器不接触数据库，也不构成第二种生产拓扑。OAuth 授权服务器不在 1.0
边界内；不会用不完整实现替代现有 Token 鉴权。

AI 工具固定为 7 个，user 的提交、上传、设置和兑换保持在受会话及 CSRF 保护的网站 REST API 内。每项写操作都要求可复用的幂等键，以便客户端安全重试。

## 安全

- user：HttpOnly/SameSite Cookie + 独立 CSRF Cookie/Header
- AI：默认静态 Token（Bearer 或专用 Header），数据库只保存 SHA-256
- 密码：Argon2id
- 写入口：Zod 校验、速率限制、审计日志
- 证据上传：Multer 单图内存限额 → Sharp 真格式/像素校验 → 重新编码 → 私有存储
- 备份上传：Multer 磁盘暂存 → ZIP 路径/数量/大小校验 → WebP 哈希与像素校验
- 容器：入口以 root 处理卷权限，随后通过 `gosu` 降权为 `node`
- 数据库：SQLite 启用 foreign keys、WAL、NORMAL synchronous 与 busy timeout；容器同时约束 V8 堆
- 卷兼容：入口允许 root-squash 环境拒绝 `chown`，但在降权前必须验证 `node` 对数据目录有写权限
- 首次设置：默认由首位成功提交设置的人认领；条件更新原子关闭初始化入口，避免并发重复认领
- 可选保护：设置 `PHOSPHENE_SETUP_TOKEN` 后，首次设置请求必须提供完全相同的 Token
- 会话：浏览器 Cookie 本身是不可预测的随机令牌，数据库只保存 SHA-256，不依赖额外的静态签名秘密
- 生产配置：临时 SQLite 数据库或越界持久化路径会导致拒绝启动

## 备份

导出 ZIP 包含版本化 JSON manifest、幂等响应与所有图片对象。业务表在一个 SQLite 读事务中
取得一致性快照，图片从私有目录直接写入 ZIP 响应流。导出和恢复共用进程内维护锁：先等待已经
进入的业务请求结束，再阻止新的 REST、MCP 和网页请求；`/healthz` 不受影响。

恢复上传先落盘到 `/data/tmp`，再用 lazy-entry 方式逐项读取。归档路径必须命中 manifest
引用的严格白名单；原图会校验大小、SHA-256、WebP 真格式、像素和尺寸，预览图也会重新解析。
服务端为恢复图片生成新的对象 Key，因此同一备份可以在原实例就地恢复。文件全部通过校验后，
业务表和 `idempotency_keys` 才在一个数据库事务中替换；密码、会话和 AI Token 表不参与覆盖。
事务提交后删除旧图片，进程下次启动还会清理没有数据库引用的残留图片目录和临时上传。

version 2 是当前格式；恢复器兼容不含幂等表的 version 1，并在导入旧格式时清空目标实例的旧
幂等记录。详细限制和操作流程见 [备份与恢复](BACKUP.md)。

生产运维仍应同时快照整个 `/data` 卷：卷快照负责包含凭证的完整灾难恢复，网站 ZIP 负责业务
数据下载、迁移和时间点恢复，两者不能互相完全替代。
