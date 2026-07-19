# 部署与运维

## 正式生产拓扑

Phosphene 的正式生产方式固定为一个应用服务加一个持久化卷：

- Phosphene App：建议 1 vCPU / 512 MB RAM
- 一个持久化卷：挂载到 `/data`，建议至少 1 GB
- 一个 HTTPS 域名：绑定 App 的 HTTP 端口

`/data/phosphene.sqlite` 保存 SQLite 数据库，`/data/uploads` 保存经过净化的私有图片，
`/data/tmp` 只暂存恢复上传。网页、REST API 和 MCP 均由同一个进程和域名提供。

这是完整的正式模式。项目不要求 PostgreSQL、MinIO、Supabase 或其他外部数据服务。

## Zeabur 发布

1. 把仓库推送到 GitHub。
2. 在 Zeabur 项目中选择 **Deploy New Service → Git**，连接该仓库。
3. Zeabur 从根目录 `Dockerfile` 构建并运行应用。
4. 在 **Phosphene App 服务**上添加持久化卷，挂载目录精确填写 `/data`，建议容量至少 1 GB。
5. 不需要设置必填环境变量。时区在首次设置网页中选择。
6. 绑定一个尚未公开且不容易随手猜到的域名，等待 `/healthz` 返回 200。
7. 立即打开网站并设置登录密码。首位成功提交设置的人会认领实例，之后初始化入口永久关闭。
8. 保存只显示一次的 AI Token。
9. 分别执行一次 Restart 和 Redeploy，确认设置仍在且没有重新出现首次设置页。

Zeabur 注入的 `PORT` 和 `ZEABUR_WEB_URL` 会被应用自动使用；一般不需要手工填写 `PUBLIC_URL`。

### 持久卷检查

挂载完成后应满足：

```text
Service: Phosphene App
Mount path: /data
Database: /data/phosphene.sqlite
Images: /data/uploads
Restore temp: /data/tmp
```

以下配置都不正确：

- 只挂 `/data/uploads`；
- 把卷挂到项目中的其他服务；
- 使用 `/tmp` 或容器根目录代替持久卷；
- 只依赖 Dockerfile 的 `VOLUME` 声明，没有在 Zeabur 创建持久卷。

应用 ready 日志会输出 `dataDir` 与 `deploymentMode`。生产实例应显示 `/data` 和 `single`。

### 环境变量

| 变量 | Zeabur 建议 |
| --- | --- |
| `PORT` | 由平台注入，不要覆盖 |
| `ZEABUR_WEB_URL` | 由平台注入 |
| `PUBLIC_URL` | 通常留空；自动 URL 不正确时才填写完整 HTTPS 地址 |
| `PHOSPHENE_SETUP_TOKEN` | 可选；域名提前公开或无法立即认领时设置 |
| `PHOSPHENE_MCP_AUTH_MODE` | 保持 `token` |
| `PHOSPHENE_DATA_DIR` | 不设置，镜像默认 `/data` |
| `SQLITE_PATH` / `LOCAL_STORAGE_PATH` | 不设置，除非明确需要并确保仍位于 `/data` |

`PHOSPHENE_MCP_AUTH_MODE` 默认是 `token`，现有部署无需添加。只有服务完全位于可信私网且
客户端无法发送请求头时才可改成 `none`；修改后需要重启。公开域名不得关闭 MCP 鉴权。

随机域名只减少无意访问，不提供真正的身份认证。若使用已经公开或可预测的域名，或者部署后无法立即完成设置，应在绑定公网域名前配置一个至少 24 位的随机 `PHOSPHENE_SETUP_TOKEN`。启用后，首次设置页会要求该 Token；留空则保持默认的首位访问者认领流程。

SQLite 不需要 WebAssembly 数据库堆。镜像仍约束 Node.js 堆，部署后可在 ready 日志查看 `memoryRssMb`，并在 Zeabur Metrics 核对峰值。

## 启动顺序

1. 容器入口确保 `/data` 存在，并以非 root 的 `node` 用户启动应用
2. 打开 `/data/phosphene.sqlite`，启用 foreign keys、WAL 与 busy timeout
3. 自动运行 Drizzle migrations
4. 初始化 `/data/uploads` 与 `/data/tmp`，清理中断操作留下的临时 ZIP 和无引用图片
5. seed 预设奖励和成就
6. reconciliation 生成 daily 并处理停机期间的逾期
7. 未初始化时进入首位访问者模式或 Token 保护模式
8. `/healthz` 返回 200

## 健康检查

```text
GET /healthz
200 {"status":"ok","version":"1.0.0"}
```

健康检查不执行高频数据库写入。部署后另做一次 `/api/bootstrap` 冒烟验证。

## 持久化与删除风险

- 普通重启、重新构建或发布新镜像不会清除 `/data`。
- Restart 保留数据而 Redeploy 丢数据，说明应用此前仍在使用容器临时层。
- 删除服务时是否保留卷取决于 Zeabur 的删除选择；删除卷会永久删除数据库和图片。
- 不要把 `PHOSPHENE_DATA_DIR` 改为临时目录。
- 生产模式会拒绝 `SQLITE_PATH=:memory:`。
- 自定义 `SQLITE_PATH` 或 `LOCAL_STORAGE_PATH` 时，两者都必须位于 `PHOSPHENE_DATA_DIR` 内。

## 升级

1. 创建 `/data` 持久化卷快照。
2. 另行下载网站 ZIP 作为应用级副本。
3. 阅读 release notes。
4. 部署新镜像；migration 自动运行。
5. 验证登录、任务查询、MCP `get_overview` 和一张历史预览图。

不要跨多个大版本直接跳跃。失败时先回滚 App 镜像；若 migration 不向后兼容，再从卷快照恢复。
PWA 更新后可能需要完全关闭已安装应用，再从浏览器打开网站刷新一次。

## 备份计划

- 每日或每次重要变更前：`/data` 持久化卷快照
- 每周：网站 ZIP，下载到不同故障域
- 每月：按 [备份与恢复](BACKUP.md) 在独立临时实例执行一次恢复演练
- AI Token 轮换后：确认 MCP 客户端已更新

卷快照包含当前凭证和 SQLite 运行文件，是整机灾难恢复手段；网站 ZIP 保留业务记录、幂等
响应与图片，适合下载和迁移，但不会覆盖密码、会话或 AI Token。两种备份应同时保留。
ZIP 采用流式导出和磁盘恢复，恢复时仍需为上传 ZIP、旧图片和新图片同时预留卷空间。

SQLite 使用 WAL 时会在数据库旁维护 `-wal` 和 `-shm` 文件，因此文件级手工复制必须先正常停止应用。优先使用 Zeabur 卷快照或网站 ZIP，避免复制到不一致的时间点。

## Docker Compose

仓库根目录的 `docker-compose.yml` 只启动一个应用服务，并把命名卷挂载到 `/data`：

```bash
docker compose up -d --build
```

如需保护首次认领，可在启动前设置 `PHOSPHENE_SETUP_TOKEN`。不需要数据库密码或对象存储凭证。
Compose 使用 `phosphene-data:/data` 命名卷。`docker compose down` 会保留它；`docker compose down -v` 会删除它和全部 Phosphene 数据。

更新：

```bash
git pull --ff-only
docker compose up -d --build
```

直接使用发布镜像：

```bash
docker run -d \
  --name phosphene \
  --restart unless-stopped \
  -p 8080:8080 \
  -v phosphene-data:/data \
  ghcr.io/3lmglow/phosphene:latest
```

不要同时启动两个写入同一 SQLite 卷的 Phosphene 容器。该项目是单进程嵌入式数据库拓扑，不使用多副本横向扩容。

## 日志与隐私

结构化日志只记录请求方法、路径、状态和耗时，不记录 Authorization、Cookie、密码、图片内容或 `proof_text`。向支持人员提供日志前，仍应人工删除域名、IP、任务标题和其他私人上下文。

常见 Crash loop、卷权限、401、405、PWA 和图片问题见 [故障排查](TROUBLESHOOTING.md)。
