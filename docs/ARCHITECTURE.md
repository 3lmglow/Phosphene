# Phosphene 1.0 架构

## 领域边界

Phosphene 是单实例、单 user、单 AI。该限制是产品边界，不是暂时删减，因此没有 tenant id、
公开注册、邀请、组织或角色管理复杂度。

## 服务边界

- Express 提供 REST、MCP、认证、上传与生产静态文件
- React/Vite 提供网站
- PostgreSQL 保存关系数据、不可变积分账本、幂等响应和审计
- 私有 S3/MinIO 保存重新编码后的图片与审核预览
- Sharp 在进对象存储前验证并净化图片

## 任务模型

`task_series` 保存重复 daily 规则；`tasks` 保存每个自然日的独立实例。唯一索引
`(series_id, occurrence_date)` 保证重启、并发请求和网络重试不会生成重复实例。

系统在概览、查询和写操作前执行 reconciliation：

1. 按 user 时区生成截至今天的 daily 实例
2. 将已过截止时间且仍 pending 的任务标记 expired
3. 原子写入受余额限制的扣分
4. 从事实表重算日活动、连击、统计与成就

## 完成与延迟审核

self 任务提交后立即完成。ai_review 先写 submission 和 `submitted_at`；批准时
`completion_date` 使用 submission 在 user 时区对应的自然日，不使用审核日。

重算连击时按所有完成日期排序。若历史补入使某日的 streak bonus 改变，系统不修改旧账本，
而是追加差额 correction。这保证历史可审计且总余额正确。

## 积分一致性

任务奖励、任务扣分、手工调整、连击、兑换都进入 `point_ledger`。余额和累计指标从账本重算；
缓存统计只用于读取性能。每个结算事件有唯一 `idempotency_key`。

兑换在单个数据库事务中读取奖励服务端价格、检查余额、创建 redemption、写负数账本和审计。

## 安全

- user：HttpOnly/SameSite Cookie + 独立 CSRF Cookie/Header
- AI：Bearer Token，数据库只保存 SHA-256
- 密码：Argon2id
- 写入口：Zod 校验、速率限制、审计日志
- 上传：Multer 内存限额 → Sharp 真格式/像素校验 → 重新编码 → 私有存储
- 生产配置：默认秘密、本地数据库或本地存储会导致拒绝启动

## 备份

导出 ZIP 包含版本化 JSON manifest 与所有对象。恢复先验证密码和 archive 完整性，再上传新对象、
事务替换业务表、清理旧对象并运行 reconciliation。账户密码、会话和 AI Token不参与覆盖。
