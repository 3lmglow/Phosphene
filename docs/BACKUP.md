# 备份与恢复

Phosphene 提供两种备份。它们用途不同，正式使用时建议同时保留。另外，每次换新版本时 Phosphene 会自动留一份升级前的数据库，作为额外的保险。

## 选择备份

| 方式 | 包含内容 | 适合 |
| --- | --- | --- |
| `/data` 卷快照 | SQLite、WAL/SHM、净化后的完整图片、当前实例凭据 | 升级前保护、整实例回滚 |
| 网站 ZIP | 任务、提交、积分、奖励、成就、审计、幂等记录、领域事件、投递历史、净化后的完整图片与审核预览 | 日常下载、迁移、恢复业务数据 |
| [升级前的自动备份](#升级前的自动备份) | 换新版本前的整个 SQLite 数据库，包括当前实例凭据；不含图片 | 新版本升级数据库出问题时退回 |

网站 ZIP 不包含或覆盖：

- 登录密码与网站会话
- 密保问题、答案哈希与找回尝试记录
- AI Token 与已授权的应用
- Webhook URL、订阅和签名密钥

因此，把 ZIP 恢复到另一个实例后，仍使用目标实例当前的登录和连接配置。若要连同凭据一起回到原状态，使用 `/data` 卷快照。

不是每个平台都提供卷快照。平台没有快照功能时，以网站 ZIP 为主要备份。

### 在自己的服务器上备份 `/data`

使用 Docker Compose 时，可以先停止 Phosphene，再把整个 `/data` 打包到当前目录：

```bash
docker compose stop app
docker compose run --rm -T --no-deps --entrypoint tar app czf - -C /data . > phosphene-data-$(date +%F).tar.gz
docker compose --profile https start app
```

停止期间网站和 MCP 不可用，通常只需要几秒。打包文件包含当前实例凭据，请和密码一样妥善保存。

## 升级前的自动备份

换了新版本后第一次启动时，Phosphene 会在升级数据库之前，把当前数据库完整复制一份到 `/data/backups/`。文件名以复制时间开头、以要升级到的版本结尾，例如 `2026-11-08T08-00-00.000Z-before-v1.2.2.sqlite`。只保留最近 3 份，更早的会自动删除。同一版本重新启动不会再复制；全新安装的实例也不会。

这份副本不能代替网站 ZIP：它和数据库在同一个卷里，删除卷时会一起消失，也不包含图片。它的用处是：新版本升级数据库后出了问题，可以把数据库退回升级前。退回后，升级之后新增的任务、积分和提交也会一起回到升级前的样子。

使用 Docker Compose 时，退回步骤是：

```bash
docker compose stop app
docker compose run --rm --no-deps --user node --entrypoint ls app -l /data/backups
docker compose run --rm --no-deps --user node --entrypoint sh app -c 'cp /data/backups/要用的文件名.sqlite /data/phosphene.sqlite && rm -f /data/phosphene.sqlite-wal /data/phosphene.sqlite-shm'
```

然后把镜像换回升级前的版本（见 [回滚](DEPLOYMENT.md#回滚)），再启动应用。`--user node` 让复制出的文件仍属于 Phosphene 自己，不要省略。容器平台上可以在平台提供的终端里执行同样的复制；做不到时，用网站 ZIP 或卷快照恢复。

复制失败（例如磁盘已满）不会阻止应用启动，日志中会出现 `Could not save a copy of the database before upgrading`。

## 导出网站 ZIP

1. 登录网站，打开“设置 → 数据与备份”。
2. 点击导出。
3. 下载完成后，把 ZIP 保存到 Phosphene 服务之外的位置。
4. 用日期和实例名称标记文件。

导出使用同一数据库事务快照，并把内容直接写入下载流。导出期间业务入口会短暂进入维护状态，`/healthz` 仍可用。下载中途断开（关掉页面或网络中断）时，导出会立刻停止并退出维护状态，重新点击导出即可。

开始下载前，服务端会先按恢复时的[容量上限](#格式与容量上限)检查这次导出。超过任何一项就不会开始下载，详见 [`backup_too_large`](#backup_too_large)。

当前格式为 version 3，包含：

- 业务设置与记录
- 幂等响应
- `domain_events`
- `webhook_deliveries`
- 净化后的完整图片与审核预览

version 1 和 version 2 ZIP 仍可导入。旧格式没有领域事件与投递历史；version 1 也没有幂等记录。

## 恢复前

1. 确认 ZIP 来自自己的 Phosphene 实例。
2. 为当前 `/data` 创建卷快照。
3. 确认记得当前网站密码。
4. 让用户与 AI 暂停新的写操作。
5. 检查卷剩余空间。

恢复期间，上传 ZIP、当前图片和备份中的图片会暂时同时存在。预留空间可按以下方式估算：

```text
ZIP 大小 + 当前 /data/uploads 大小 + 备份中的图片大小
```

## 从网站恢复

1. 打开“设置 → 数据与备份”。
2. 选择 ZIP。
3. 输入当前网站密码并确认。
4. 等待完成提示。
5. 检查余额、最近任务、奖励、称呼和历史图片。
6. 让 AI 调用一次 `get_overview`。

恢复上传先写入 `/data/tmp`。服务端会验证：

- ZIP 总大小、entry 数量、manifest 大小和解压后总量
- manifest 版本、表结构、字段、行数与关键单例记录
- 归档路径和对象 Key
- 图片大小、SHA-256、WebP 格式、像素和尺寸

图片先写入新的对象 Key。全部文件通过校验后，业务表、幂等记录、领域事件与投递历史在同一数据库事务中替换；seed、派生统计和恢复审计也在该事务内完成。事务成功后才清理旧图片。

校验或数据库事务失败时，原业务数据保持不变。恢复成功后仍保留当前实例的密码、AI Token 与 Webhook 配置。

## 格式与容量上限

| 项目 | 上限 |
| --- | --- |
| ZIP 文件 | 2 GiB |
| manifest | 32 MiB |
| 单个归档图片对象 | 64 MiB |
| 解压后总量 | 4 GiB |
| 归档条目数 | 200,000 |
| 数据库记录总数 | 500,000 |

导出和恢复使用同一组上限。图片在 ZIP 中不压缩，所以图片多而大的实例最先碰到 2 GiB 的 ZIP 上限。导出前，服务端用 manifest 大小、每张图片的实际大小和 ZIP 结构开销算出 ZIP 最大可能的大小；超过上限就不开始下载，而不是生成一个恢复时会被拒绝的 ZIP。

同一时间只运行一个导出或恢复操作。接近上限时，还要确认实例内存与卷容量足够。

## 失败处理

### `invalid_backup`

保留错误信息与原 ZIP，检查下载是否完整、是否被解压后重新打包，以及格式是否来自 Phosphene。旧版 ZIP 不需要手工转换。

### `backup_too_large`

导出时返回 413，表示实例的数据超过了网站 ZIP 能恢复的[上限](#格式与容量上限)，所以没有开始下载。返回内容的 `details.limit` 说明超过的是哪一项：`archive_bytes`（ZIP 大小）、`uncompressed_bytes`（解压后总量）、`entries`（归档条目数）或 `rows`（数据库记录总数）。manifest 本身超过 32 MiB 时返回 `backup_manifest_too_large`。

这时改用 [`/data` 卷快照](#在自己的服务器上备份-data)备份整个实例。卷快照没有这些上限，还包含当前实例凭据。

### 磁盘空间不足

先扩容 `/data` 或恢复操作前的卷快照，再重新执行。不要通过手工删除 `/data/uploads` 腾空间。

### 页面短暂返回 503

导出或恢复正在使用维护锁。等待当前操作结束；`/healthz` 应继续返回 200。

### 恢复后图片异常

先确认恢复接口明确返回成功，再检查具体任务与图片。保留 ZIP、任务 id 和相邻日志用于排查。

更多症状见 [故障排查](TROUBLESHOOTING.md)。

## 建议周期

- 每次升级前：网站 ZIP，平台支持时再加卷快照
- 每周：把网站 ZIP 保存到另一台设备或独立存储
- 每月：在临时实例做一次恢复演练
- 重要任务、积分或奖励调整前：额外创建恢复点

SQLite 使用 WAL。运行中只复制 `phosphene.sqlite` 可能漏掉尚未合并的事务。手工复制数据库文件前先正常停止应用；平时优先使用卷快照或网站 ZIP。
