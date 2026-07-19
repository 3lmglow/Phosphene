# 部署与运维

## 默认生产拓扑

Phosphene 的默认正式生产方式是一个 Git 服务加一个持久化卷：

- Phosphene App：建议 1 vCPU / 512 MB RAM
- 一个持久化卷：挂载到 `/data`，建议至少 1 GB
- 一个 HTTPS 域名：只绑定 App 的 HTTP 端口

`/data/phosphene` 保存 PGlite 数据库，`/data/uploads` 保存经过净化的私有图片。网页、REST API 和 MCP 均由同一个进程和域名提供。

这一拓扑与“一人一 AI、每人独立部署”的产品边界一致，是受支持的正式模式，不是仅供开发的临时方案。

## Zeabur 发布

1. 把仓库推送到 GitHub。
2. 在 Zeabur 项目中选择 **Deploy New Service → Git**，连接该仓库。
3. Zeabur 从根目录 `Dockerfile` 构建并运行应用。
4. 为该服务添加持久化卷，挂载目录填写 `/data`。
5. 不需要设置必填环境变量。可选设置 `PHOSPHENE_TIMEZONE=Asia/Shanghai`，或自己提供至少 24 位的 `PHOSPHENE_SETUP_TOKEN`。
6. 不要为默认模式填写 `DATABASE_URL` 或 `S3_*`。
7. 绑定域名并等待 `/healthz` 返回 200。
8. 未手动设置 Setup Token 时，在 Runtime Logs 搜索 `setupToken`；应用已把同一个随机 Token 以私有文件形式持久化到 `/data`，容器重启不会改变它。
9. 打开网站完成首次设置，保存只显示一次的 AI Token。

Zeabur 注入的 `PORT` 和 `ZEABUR_WEB_URL` 会被应用自动使用；一般不需要手工填写 `PUBLIC_URL`。

## 启动顺序

1. 容器入口确保 `/data` 存在，并以非 root 的 `node` 用户启动应用
2. 缺少有效 Setup Token 时，生成强随机值并以 `0600` 权限保存到 `/data/.phosphene-setup-token`
3. PGlite 打开持久化数据库并运行 Drizzle migrations
4. 初始化私有图片目录
5. seed 预设奖励和成就
6. reconciliation 生成 daily 并处理停机期间的逾期
7. 未初始化时把一次性 Setup Token 写入私有部署日志
8. `/healthz` 返回 200

## 健康检查

```text
GET /healthz
200 {"status":"ok","version":"1.0.0"}
```

健康检查不执行高频数据库写入。部署后另做一次 `/api/bootstrap` 冒烟验证。

## 持久化与删除风险

- 普通重启、重新构建或发布新镜像不会清除 `/data`。
- 删除服务时是否保留卷取决于 Zeabur 的删除选择；删除卷会永久删除数据库和图片。
- 不要把 `PHOSPHENE_DATA_DIR` 改为临时目录。
- 生产单服务模式会拒绝位于数据根目录之外的 `PGLITE_PATH` 或 `LOCAL_STORAGE_PATH`。

## 升级

1. 从网站导出完整 Phosphene ZIP。
2. 创建 `/data` 持久化卷快照。
3. 阅读 release notes。
4. 部署新镜像；migration 自动运行。
5. 验证登录、任务查询、MCP `get_overview` 和一张历史预览图。

不要跨多个大版本直接跳跃。失败时先回滚 App 镜像；若 migration 不向后兼容，再从卷快照恢复。

## 备份计划

- 每日：`/data` 持久化卷增量快照
- 每周：网站完整 ZIP，下载到不同故障域
- 每月：在独立临时实例执行一次恢复演练
- AI Token 轮换后：确认 Yukehome 或其他 MCP 客户端已更新

应用 ZIP 用于可验证的数据迁移；卷快照用于整机灾难恢复。两者都应保留。

## 可选分布式模式

仅当需要数据库与文件独立扩容、独立备份或跨服务运维时，才设置：

- `DATABASE_URL`：切换到 PostgreSQL
- `STORAGE_DRIVER=s3`
- 完整 `S3_ENDPOINT`、bucket 与凭证

生产分布式模式要求 PostgreSQL 与 S3 同时启用，避免难以备份的混合拓扑。仓库的 `docker-compose.yml` 和 `zeabur-template.yaml` 专用于这一模式。PostgreSQL 5432 与 MinIO 9000/9001 不应绑定公网域名。

## 日志与隐私

结构化日志只记录请求方法、路径、状态和耗时，不记录 Authorization、Cookie、密码、图片内容或 `proof_text`。向支持人员提供日志前，仍应人工删除域名、IP、任务标题和其他私人上下文。
