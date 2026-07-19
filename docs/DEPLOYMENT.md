# 部署与运维

## 生产资源

最低需要：

- Phosphene App：建议 1 vCPU / 512 MB RAM
- PostgreSQL：持久卷，建议至少 1 GB
- MinIO：持久卷，容量按图片增长规划
- 一个 HTTPS 域名，仅绑定 App 的 8080 HTTP 端口

PostgreSQL 5432、MinIO 9000/9001 不应绑定公网域名。MinIO 镜像从官方
`RELEASE.2025-10-15T17-29-55Z` 安全修复源码标签构建，避免使用停在修复前的旧社区容器。

## 发布顺序

1. PostgreSQL 和 MinIO 就绪
2. App 启动，自动运行 Drizzle migration
3. App 自动创建私有 Bucket
4. seed 预设奖励和成就
5. reconciliation 生成 daily 并处理停机期间的逾期
6. `/healthz` 返回 200

## 健康检查

```text
GET /healthz
200 {"status":"ok","version":"1.0.0"}
```

不要把需要数据库写入的接口作为高频容器健康检查。部署后另做一次 `/api/bootstrap` 冒烟验证。

## 升级

1. 网站导出完整 Phosphene ZIP
2. 创建 PostgreSQL 与 MinIO/卷快照
3. 阅读 release notes
4. 部署新镜像；migration 自动运行
5. 验证登录、任务查询、MCP `get_overview` 和一张历史预览图

不要跨多个大版本直接跳跃。失败时先回滚 App 镜像；若 migration 不向后兼容，再恢复数据库快照。

## 备份计划

- 每日：基础设施增量快照
- 每周：网站完整 ZIP，下载到不同故障域
- 每月：在独立临时实例执行一次恢复演练
- AI Token 轮换后：确认客户端已更新，再删除旧离线备份中的明文配置

## 日志与隐私

服务端结构化日志记录请求方法、路径、状态和耗时，不应记录 Authorization、Cookie、密码、图片内容
或 proof_text。向支持人员提供日志前仍应人工检查并删除域名、IP、任务标题和其他私人上下文。
