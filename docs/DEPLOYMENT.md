# 部署与运维

Phosphene 的部署结构很简单：

- 一个应用服务
- 一个挂载到 `/data` 的持久卷
- 一个指向应用服务的 HTTPS 域名

同一个应用进程提供网页、REST API 和 MCP。SQLite 与私有图片都在 `/data` 中，不需要额外部署数据库或对象存储。

## 选择部署方式

| 方式 | 适合 |
| --- | --- |
| Zeabur Template | 直接使用已发布版本，最快开始 |
| fork + Zeabur GitHub 部署 | 保存自己的修改，并从 fork 持续部署 |
| Docker Compose | 在自己的电脑或服务器上运行 |
| Docker Image | 已有容器平台，只想运行发布镜像 |

如果准备长期使用或修改项目，推荐先 fork 仓库，再把 fork 连接到 Zeabur。这样部署来源、个人改动和后续更新都保留在自己的仓库中。

## Zeabur：从 fork 部署

### 1. 创建应用服务

1. fork 本仓库。
2. 在 Zeabur 创建项目，选择 **Deploy New Service → GitHub**。
3. 连接自己的 fork，并选择要部署的分支。
4. 保持构建目录为仓库根目录。Zeabur 会识别根目录的 `Dockerfile`。
5. 等待应用完成第一次构建。

Zeabur 的界面操作可参考官方的 [Create Service](https://zeabur.com/docs/en-US/deploy/create/create-service) 和 [Dockerfile deployment](https://zeabur.com/docs/en-US/deploy/methods/dockerfile)。

### 2. 挂载持久卷

在刚创建的 **Phosphene 应用服务**中添加持久卷：

| 配置 | 值 |
| --- | --- |
| Mount Directory | `/data` |
| 初始容量 | 建议至少 1 GB |

应用会在卷中建立：

```text
/data/
├── phosphene.sqlite
├── phosphene.sqlite-wal
├── phosphene.sqlite-shm
├── uploads/
│   └── proofs/
└── tmp/
```

WAL 和 SHM 文件只在 SQLite 运行期间出现。Zeabur 的卷说明见 [Volumes](https://zeabur.com/docs/en-US/data-management/volumes)。

`/data` 必须挂在 Phosphene 服务本身。只挂 `/data/uploads` 会漏掉数据库；Dockerfile 中的 `VOLUME` 声明也不能代替平台上真正的持久卷。

### 3. 配置首次认领

Phosphene 没有必填环境变量。若域名会在你完成设置前公开，添加：

```env
PHOSPHENE_SETUP_TOKEN=一段保存在密码管理器中的随机字符串
```

未设置时，由首位成功提交首次设置的人认领实例。设置后，首次设置页会先验证这个 Token。

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口；Zeabur 自动提供 |
| `PUBLIC_URL` | 公开地址；Zeabur 自动地址不正确时才填写 |
| `PHOSPHENE_SETUP_TOKEN` | 可选的首次认领保护 |
| `PHOSPHENE_MCP_AUTH_MODE` | 默认 `token`；公开部署保持默认 |
| `PHOSPHENE_DATA_DIR` | 生产镜像默认 `/data` |
| `SQLITE_PATH` | 可选数据库路径覆盖，必须位于数据目录内 |
| `LOCAL_STORAGE_PATH` | 可选图片路径覆盖，必须位于数据目录内 |
| `LOG_LEVEL` | 日志级别，默认 `info` |

网站密码和 AI Token 都不属于服务端环境变量：密码通过首次设置页提交，AI Token 保存在调用 MCP 的客户端。

### 4. 绑定域名并检查启动

为应用服务生成或绑定 HTTPS 域名，然后访问：

```text
https://你的域名/healthz
```

正常响应：

```json
{"status":"ok","version":"1.0.0"}
```

ready 日志会显示当前 `dataDir`；生产容器应为 `/data`。

### 5. 完成首次设置

打开网站，设置登录密码、双方称呼和时区。完成后立即保存只显示一次的 AI Token，再按照 [MCP 连接与工具](MCP.md) 连接 AI。

首次设置或修改密码时，密码须为 **10–256 个字符**，只支持大小写英文字母、数字和半角符号，可以只用其中一类或任意组合。不支持空格、中文、全角符号、换行或其他不可见字符。请使用英文输入法，例如使用 `!` 而不是 `！`。

页面与服务端都会校验密码。出现“不支持的字符”提示时，请检查输入法及粘贴内容，修改后重新提交；系统不会自动删除或替换密码字符。此规则只用于设置新密码，不会阻止已有用户使用原密码登录。更多说明见 [密码与登录问题](TROUBLESHOOTING.md#网站登录与写操作)。

随后做一次持久化检查：

1. 在设置页修改一个称呼。
2. 重启 Zeabur 服务。
3. 确认称呼仍在，且网站没有重新进入首次设置。
4. 再执行一次 Redeploy，重复确认。

如果 Restart 后数据仍在、Redeploy 后消失，说明之前写入的是容器临时层。检查卷是否挂在当前服务的 `/data`。

## Zeabur Template

仓库根目录的 `zeabur-template.yaml` 会创建发布镜像、域名和 `/data` 卷。部署后仍应检查：

- 卷挂载路径是 `/data`
- `/healthz` 返回 200
- 首次设置后执行 Restart 和 Redeploy，数据都保留

Template 使用 `ghcr.io/3lmglow/phosphene:latest`。发布新镜像后，需要在 Zeabur 重新部署服务以拉取更新。

## Docker Compose

要求 Docker 与 Docker Compose：

```bash
git clone https://github.com/3lmglow/Phosphene.git
cd Phosphene
docker compose up -d --build
```

打开 `http://localhost:8080`。Compose 创建 `phosphene-data` 命名卷并挂载到 `/data`。

如需在首次启动前设置认领 Token：

```bash
export PHOSPHENE_SETUP_TOKEN="replace-with-a-private-random-value"
docker compose up -d --build
```

`docker compose down` 会保留命名卷；`docker compose down -v` 会删除卷和其中的全部 Phosphene 数据。

更新：

```bash
git pull --ff-only
docker compose up -d --build
```

不要让两个 Phosphene 容器同时写入同一个 SQLite 卷。

## Docker Image

```bash
docker run -d \
  --name phosphene \
  --restart unless-stopped \
  -p 8080:8080 \
  -v phosphene-data:/data \
  ghcr.io/3lmglow/phosphene:latest
```

如需固定版本，把 `latest` 替换为对应镜像标签。

## 启动过程

每次启动会依次：

1. 检查数据目录并以非 root 用户运行应用
2. 打开 SQLite，启用 foreign keys、WAL 和 busy timeout
3. 自动运行 Drizzle migrations
4. 初始化图片与临时目录，清理中断操作遗留的临时文件
5. 补充内置奖励和成就
6. 生成缺失的每日任务并处理停机期间的逾期
7. 启动完成通知 worker
8. 开放健康检查与业务入口

## 更新

更新前：

1. 创建 `/data` 卷快照。
2. 从网站下载一份 ZIP。
3. 阅读 [更新说明](RELEASE_NOTES.md)。

更新 fork 时，把上游改动合并到自己连接 Zeabur 的分支并推送。Zeabur 构建新容器后，Phosphene 会自动运行 migration。

更新后检查：

- `/healthz`
- 网站登录和最近任务
- 一张历史证据图片
- MCP `get_overview`
- 已配置完成通知时，发送一次测试事件

PWA 仍显示旧页面时，完全关闭已安装应用，再从浏览器打开网站并刷新一次。

## 回滚

回滚要同时考虑应用镜像和数据库：

- 数据库结构仍兼容旧版本时，可以只回滚应用部署。
- migration 已改变旧版本无法读取的结构时，恢复匹配的旧应用版本和升级前卷快照。

先保留当前卷与第一条 migration 错误，再执行回滚。普通更新问题不需要删除服务、删除卷或重新认领实例。

## 数据与运行边界

- Restart、重新构建和正常发布不会清除已挂载的 `/data`。
- 删除持久卷会删除数据库和图片。
- 生产模式拒绝内存数据库和位于数据目录外的持久化路径。
- 公开域名保持 `PHOSPHENE_MCP_AUTH_MODE=token`。
- 卷快照与网站 ZIP 的区别和恢复方法见 [备份与恢复](BACKUP.md)。

启动、权限、数据丢失、MCP 与图片问题见 [故障排查](TROUBLESHOOTING.md)。
