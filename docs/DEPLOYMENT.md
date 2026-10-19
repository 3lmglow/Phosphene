# 部署与运维

Phosphene 的部署结构很简单：

- 一个应用服务
- 一个挂载到 `/data` 的持久存储
- 一个 HTTPS 访问地址

同一个应用进程提供网页、REST API 和 MCP。SQLite 与私有图片都在 `/data` 中，不需要额外部署数据库或对象存储。

> 正在使用 Zeabur？云平台 Zeabur 已宣布停止运营，共享集群 12 月 1 日起暂停（[Zeabur 官方公告](https://zeabur.com/zh-CN/blogs/zeabur-is-shutting-down)）。Phosphene 本身不受影响，请先阅读 [从 Zeabur 迁移](MIGRATE_FROM_ZEABUR.md)。

## 选择部署方式

| 方式 | 适合 | 参考费用 |
| --- | --- | --- |
| [容器平台（以 Sealos 为例）](#方式一容器平台以-sealos-为例) | 不想管理服务器，在网页上点几下就能用 | 约 16–20 元/月 |
| [自己的服务器 + Docker Compose](#方式二自己的服务器--docker-compose) | 已经有服务器，或愿意花十几分钟学着用 | 服务器费用 |

两种方式用的是同一个镜像：先在 GitHub 上 fork 本仓库，由你的 fork 自动构建出属于你自己的镜像。这样部署来源、个人改动和更新节奏都由你自己掌握。

## 第一步：fork 仓库并构建镜像

需要一个 GitHub 账号。

1. 打开 [Phosphene 仓库](https://github.com/3lmglow/Phosphene)，点右上角 **Fork**，再点 **Create fork**。
2. 进入你的 fork，点顶部的 **Actions**。第一次会看到提示，点绿色按钮 **I understand my workflows, go ahead and enable them**。
3. 在左侧选择 **Container**，点右侧 **Run workflow**，分支保持 `main`，再点绿色的 **Run workflow**。
4. 等这次运行出现绿色对勾。第一次构建通常需要几分钟到十几分钟，之后会更快。

完成后，你的镜像地址是：

```text
ghcr.io/你的用户名/phosphene:main
```

用户名全部写成小写。例如用户名是 `Alice`，地址就是 `ghcr.io/alice/phosphene:main`。你也可以在 fork 首页右侧的 **Packages** 里找到它。

服务器或平台位于中国大陆时，直接访问 `ghcr.io` 经常超时，可以换成南京大学开源镜像站的加速地址：

```text
ghcr.nju.edu.cn/你的用户名/phosphene:main
```

### 确认镜像是公开的

由 Actions 构建的镜像通常会和仓库一样是公开的。如果部署时提示 `unauthorized`、`denied` 或找不到镜像：

1. 打开 fork 首页右侧 **Packages** 里的 `phosphene`。
2. 点 **Package settings**，在页面底部 **Danger Zone** 中选择 **Change visibility**，改为 **Public**。

镜像里只有程序本身，不包含你的数据、密码或 Token，公开是安全的。

## 方式一：容器平台（以 Sealos 为例）

[Sealos](https://sealos.run) 提供中文界面和按量计费，有杭州、北京、广州三个国内可用区，以及新加坡可用区。国内可用区不需要额外的网络工具就能访问。

### 1. 选择可用区

登录 Sealos 后在页面上选择可用区：

- 国内可用区：访问快。平台会分配一个可直接使用的 HTTPS 地址；如果要绑定自己的域名，需要先完成 ICP 备案。
- 新加坡：绑定自己的域名不需要备案，价格高一些。

### 2. 创建应用

打开 **应用管理**，点 **创建应用**，按下表填写：

| 位置 | 填写 |
| --- | --- |
| 应用名称 | `phosphene` |
| 镜像源 | **公开** |
| 镜像名称 | 国内可用区填 `ghcr.nju.edu.cn/你的用户名/phosphene:main`；新加坡填 `ghcr.io/你的用户名/phosphene:main` |
| 部署模式 | **固定实例**，实例数 **1** |
| CPU / 内存 | CPU 0.2 核，内存 512M |
| 网络 | 容器端口 **8080**，打开 **公网访问**，协议选 **https** |
| 高级配置 → 本地存储 | 容量 `1G`，挂载路径 **`/data`** |

镜像源要选 **公开**。选成私有时，平台会把地址当作 Docker Hub 上的镜像去拉取，导致失败。

实例数必须是 1：同一份 SQLite 数据只能由一个 Phosphene 进程写入。

内存不建议低于 512M，处理大图时需要短暂占用更多内存。

填完点 **部署应用**。

### 3. 打开网站

等实例状态变为运行中，打开平台分配的公网地址，[完成首次设置](#完成首次设置)。

### 4. 检查数据会不会丢

1. 在“设置”里修改一个称呼。
2. 在 Sealos 中点 **重启**，确认称呼仍在，且网站没有回到首次设置。
3. 点 **变更**，不修改任何内容直接重新部署，再确认一次。

如果重启后数据还在、重新部署后消失，说明本地存储没有挂到 `/data`。

### 参考费用

以 CPU 0.2 核、内存 512M、存储 1G、1 个公网端口计算，2026 年 10 月的价格约为：

| 可用区 | 每月 |
| --- | --- |
| 广州 | 约 16 元 |
| 杭州 | 约 20 元 |

其中公网端口约 10 元/月，是最大的一项。实际价格以 Sealos 控制台的计价为准。

### 其他容器平台

任何能运行 Docker 镜像的平台都可以部署 Phosphene，只要满足：

- 镜像：你的 fork 构建出的 `ghcr.io/你的用户名/phosphene:main`
- 容器端口：`8080`
- 持久存储：挂载到 `/data`
- 实例数：固定为 1
- 内存：至少 512M
- 平台提供 HTTPS 访问地址

海外用户也可以使用 [Railway](https://railway.com)：从 GitHub 部署自己的 fork，或部署上面的镜像，再给服务添加挂载到 `/data` 的 Volume。

## 方式二：自己的服务器 + Docker Compose

### 1. 准备服务器

- 系统：Ubuntu 22.04 或 24.04
- 配置：1 核 1G 内存即可；如果要在服务器上从源码构建，建议 2G 以上
- 地区：中国大陆的服务器需要 ICP 备案才能开放网站端口。没有备案时，选择香港、日本、新加坡等地区

在云服务商控制台的防火墙或安全组中，放行 TCP **80** 和 **443** 端口。

### 2. 登录服务器并安装 Docker

用云服务商提供的网页终端，或在电脑上运行 `ssh root@服务器IP` 登录。然后安装 Docker：

```bash
curl -fsSL https://get.docker.com | sh
```

### 3. 下载部署文件

```bash
git clone https://github.com/你的用户名/Phosphene.git
cd Phosphene
cp docker.env.example .env
nano .env
```

在 `.env` 中修改两行：

```env
PHOSPHENE_IMAGE=ghcr.io/你的用户名/phosphene:main
PHOSPHENE_HOST=服务器的公网IP
```

公网 IP 可以在云服务商控制台查看。修改完按 `Ctrl+O`、回车保存，再按 `Ctrl+X` 退出。

### 4. 启动

```bash
docker compose --profile https up -d
```

这会启动 Phosphene 和 Caddy。Caddy 会自动为你的 IP 申请 Let's Encrypt 证书并定期续期，通常一分钟内完成。

然后在浏览器打开：

```text
https://服务器的公网IP
```

看到首次设置页面后，[完成首次设置](#完成首次设置)。

IP 证书的有效期约 6 天，Caddy 会自动续期，不需要手动处理。更换服务器后 IP 会变化，访问地址也会随之改变：已安装的 PWA 需要重新安装，AI 客户端也要改用新地址。

### 使用自己的域名

已有域名时，先添加一条 A 记录指向服务器 IP，然后把 `.env` 中的 `PHOSPHENE_HOST` 改成域名，再运行一次：

```bash
docker compose --profile https up -d
```

### 已在使用 1Panel 或宝塔

不需要 Caddy。启动时不带 `--profile https`：

```bash
docker compose up -d
```

然后在面板中新建一个网站，反向代理到 `http://127.0.0.1:8080`，并用面板申请 SSL 证书。

Phosphene 默认只在本机的 `127.0.0.1:8080` 上提供 HTTP。如果你的反向代理运行在其他容器里、无法访问本机地址，可以在 `.env` 中加入 `PHOSPHENE_BIND=0.0.0.0`，同时确认防火墙没有对外开放 8080 端口。

### 从源码构建（可选）

不想使用 Actions 构建的镜像时，可以直接在服务器上构建：把 `.env` 中的 `PHOSPHENE_IMAGE` 一行删掉，然后运行：

```bash
docker compose --profile https up -d --build
```

构建需要能访问 Docker Hub 和 npm。中国大陆的服务器通常无法直接完成。

### 常用命令

| 目的 | 命令 |
| --- | --- |
| 查看运行状态 | `docker compose --profile https ps` |
| 查看日志 | `docker compose logs -f app` |
| 重启 | `docker compose --profile https restart` |
| 停止（保留数据） | `docker compose --profile https down` |

`docker compose down -v` 会删除数据卷和其中的全部 Phosphene 数据，不要用它来重启或更新。

Compose 默认给 Phosphene 设置了 512M 内存上限。即使将来出现异常的内存增长，也只会重启 Phosphene 容器，不会拖垮整台服务器。

## 完成首次设置

打开网站，依次设置：

1. 网站登录密码
2. 可选的密保问题与答案（可以跳过）
3. 双方称呼和时区

完成后立即保存只显示一次的 AI Token，再按照 [MCP 连接与工具](MCP.md) 连接 AI。

部署好后请立刻完成首次设置：在完成之前，第一个打开网站并提交设置的人会认领这个实例。如果部署后不能马上完成，或者地址可能先被别人看到，可以在部署时增加环境变量 `PHOSPHENE_SETUP_TOKEN`，值为一段只有你知道的长字符串；首次设置时需要先输入它。

首次设置或修改密码时，密码须为 **10–256 个字符**，只支持大小写英文字母、数字和半角符号，可以只用其中一类或任意组合。不支持空格、中文、全角符号、换行或其他不可见字符。请使用英文输入法，例如使用 `!` 而不是 `！`。

页面与服务端都会校验密码。出现“不支持的字符”提示时，请检查输入法及粘贴内容，修改后重新提交；系统不会自动删除或替换密码字符。此规则只用于设置新密码，不会阻止已有用户使用原密码登录。更多说明见 [密码与登录问题](TROUBLESHOOTING.md#网站登录与写操作)。

密保问题和答案自由填写，不设复杂度要求，答案区分大小写并忽略首尾空格。设置后可在登录页通过“忘记密码？”重置密码；问题会显示在找回页，知道答案的人也能重置密码。跳过密保不影响正常使用，但未设置密保时无法通过此方式找回。

## 环境变量

Phosphene 没有必填环境变量。

| 变量 | 说明 |
| --- | --- |
| `PHOSPHENE_SETUP_TOKEN` | 可选的首次认领保护 |
| `PHOSPHENE_MCP_AUTH_MODE` | 默认 `token`；公网部署保持默认 |
| `PORT` | HTTP 端口，镜像默认 `8080` |
| `PHOSPHENE_DATA_DIR` | 数据目录，镜像默认 `/data` |
| `SQLITE_PATH` | 可选数据库路径覆盖，必须位于数据目录内 |
| `LOCAL_STORAGE_PATH` | 可选图片路径覆盖，必须位于数据目录内 |
| `LOG_LEVEL` | 日志级别，默认 `info` |

以下变量只用于 Docker Compose，写在 `.env` 中：

| 变量 | 说明 |
| --- | --- |
| `PHOSPHENE_IMAGE` | 要运行的镜像；不填时从源码构建 |
| `PHOSPHENE_HOST` | 启用 `https` 时使用的公网 IP 或域名 |
| `PHOSPHENE_BIND` | HTTP 监听地址，默认 `127.0.0.1` |

网站密码和 AI Token 都不属于服务端环境变量：密码通过首次设置页提交，AI Token 保存在调用 MCP 的客户端。

## 数据目录

应用会在 `/data` 中建立：

```text
/data/
├── phosphene.sqlite
├── phosphene.sqlite-wal
├── phosphene.sqlite-shm
├── uploads/
│   └── proofs/
└── tmp/
```

WAL 和 SHM 文件只在 SQLite 运行期间出现。

`/data` 必须挂在 Phosphene 服务本身。只挂 `/data/uploads` 会漏掉数据库；Dockerfile 中的 `VOLUME` 声明也不能代替平台上真正的持久存储。

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

访问 `https://你的地址/healthz` 应返回 `{"status":"ok","version":"..."}`。

## 更新

更新前：

1. 从网站下载一份 ZIP（设置 → 数据与备份）。
2. 平台支持卷快照时，再创建一份 `/data` 快照。
3. 阅读 [更新说明](RELEASE_NOTES.md)。

### 同步你的 fork

1. 打开你的 fork 首页。看到 “This branch is … commits behind” 时，点 **Sync fork → Update branch**。
2. 打开 **Actions → Container**，确认出现了一次新的运行；没有的话，点 **Run workflow** 手动运行。
3. 等运行完成。

### 让部署使用新镜像

- Sealos：点 **重启**，平台会重新拉取 `main` 镜像。如果重启后 `/healthz` 中的版本号没有变化，点 **变更**，把镜像标签换成这次构建在 Actions 中对应的 `sha-xxxxxxx`，再部署。
- Docker Compose：

  ```bash
  docker compose pull
  docker compose --profile https up -d
  ```

  从源码构建时改用：

  ```bash
  git pull --ff-only
  docker compose --profile https up -d --build
  ```

应用启动时会自动运行数据库 migration。

更新后检查：

- `/healthz`
- 网站登录和最近任务
- 一张历史证据图片
- MCP `get_overview`
- 已配置完成通知时，发送一次测试事件

PWA 仍显示旧页面时，完全关闭已安装应用，再从浏览器打开网站并刷新一次。

### 从旧版 Docker Compose 升级

旧版 `docker-compose.yml` 直接在服务器上构建，并对外开放 8080 端口。新版继续支持 `git pull --ff-only` 后运行 `docker compose up -d --build`，数据卷保持不变。

新版默认只在 `127.0.0.1:8080` 提供 HTTP。如果你之前从其他机器或其他容器访问 `服务器IP:8080`，请改用上面的 Caddy 或面板反向代理，或在 `.env` 中设置 `PHOSPHENE_BIND=0.0.0.0`。

## 回滚

回滚要同时考虑应用镜像和数据库：

- 数据库结构仍兼容旧版本时，可以只回滚应用：把镜像标签换成之前的 `sha-xxxxxxx` 并重新部署。
- migration 已改变旧版本无法读取的结构时，恢复匹配的旧应用版本和升级前的卷快照或 ZIP。

先保留当前数据与第一条 migration 错误，再执行回滚。普通更新问题不需要删除服务、删除存储或重新认领实例。

## 数据与运行边界

- 重启、重新构建和正常更新不会清除已挂载的 `/data`。
- 删除持久存储会删除数据库和图片。
- 不要让两个 Phosphene 实例同时写入同一份数据。
- 生产模式拒绝内存数据库和位于数据目录外的持久化路径。
- 公网部署保持 `PHOSPHENE_MCP_AUTH_MODE=token`。
- 卷快照与网站 ZIP 的区别和恢复方法见 [备份与恢复](BACKUP.md)。

启动、权限、数据丢失、MCP 与图片问题见 [故障排查](TROUBLESHOOTING.md)。
