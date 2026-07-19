# 故障排查

先确认三个基础事实：

1. 网站地址是域名根路径，例如 `https://example.zeabur.app/`；
2. MCP 地址是在同一域名后加 `/mcp`；
3. 持久卷挂在 Phosphene App 服务的 `/data`。

## 部署一直 Crash / Restarting

按运行日志从上到下找第一条错误，不要只看最后一条“进程退出”。

### `Phosphene cannot write to /data`

应用以非 root 的 `node` 用户运行，卷必须允许它写入。

- 确认卷挂载路径是 `/data`；
- 确认挂载对象是 Phosphene App，而不是其他服务；
- 若使用自建 Docker 主机，检查 bind mount 目录权限；优先改用 Docker 命名卷；
- 修正后重新部署，不要把数据目录改去 `/tmp` 绕过检查。

### `PHOSPHENE_DATA_DIR must be an absolute path`

生产环境的数据根目录必须是绝对路径。Zeabur 一般不需要设置这个变量；删除错误的自定义值，让镜像默认使用 `/data`。

### `SQLITE_PATH and LOCAL_STORAGE_PATH must stay inside PHOSPHENE_DATA_DIR`

数据库和图片被配置到了持久化根目录之外。Zeabur 上通常应删除这两个覆盖变量。需要自定义时，使用类似：

```text
PHOSPHENE_DATA_DIR=/data
SQLITE_PATH=/data/phosphene.sqlite
LOCAL_STORAGE_PATH=/data/uploads
```

### 内存不足 / OOM / Exit 137

- 普通启动建议至少 512 MB 内存；
- ZIP 已采用流式导出和磁盘恢复；若仍在该操作期间 OOM，记录 ZIP 大小与 Metrics 后提交问题；
- 若错误发生在图片提交时，确认单张不超过 10 MB、总数不超过 4 张；
- 查看 Zeabur Metrics，区分 Node 堆限制与平台容器内存上限。

### `ENOSPC` / No space left on device

恢复期间上传 ZIP、旧图片和新图片会短暂同时存在。先保留或回挂恢复前卷快照，再扩容 `/data`；
不要通过手工删除 `/data/uploads` 腾空间。容量估算见 [备份与恢复](BACKUP.md)。

## 部署或重启后回到首次设置页

这通常不是登录 Cookie 失效，而是应用打开了一个新的空数据库。

1. 检查是否存在持久卷；
2. 检查挂载路径是否精确为 `/data`；
3. 检查新部署是否仍使用同一个卷，而不是创建了同名的新卷；
4. 查看 ready 日志的 `dataDir`；
5. 不要再次认领并继续使用，先确认旧卷是否仍可重新挂回。

如果只执行 Restart 数据仍在、Redeploy 后消失，几乎可以确定此前使用的是容器临时文件系统。

## 网站可以打开，但 MCP 连不上

### 浏览器打开 `/mcp` 显示 405

正常。Streamable HTTP MCP 使用 POST；浏览器地址栏发的是 GET。健康检查访问 `/healthz`，工具握手交给 MCP 客户端。

### `401 ai_token_required`

- Header 名应为 `Authorization` 或 `X-Phosphene-MCP-Token`；
- Bearer 写法必须是 `Bearer`、一个空格、完整 Token；
- Header 应配置在 AI 客户端或自建 AI 后端，不是在 Phosphene 的 Zeabur 环境变量中。

### `401 invalid_ai_token`

- 检查是否漏复制 Token 的末尾；
- 检查网站中是否已经轮换 Token；轮换后旧 Token 全部失效；
- 完整 Token 无法从数据库找回，只能再次轮换并更新客户端。

### `401 conflicting_ai_token`

客户端同时发送了两个不同的 Token。只保留一个 Header，或确保两处值完全相同。

### 已连接但没有工具

- Transport 选择 Streamable HTTP / HTTP，不是旧 SSE；
- URL 必须以 `/mcp` 结尾；
- 客户端若只支持 stdio，使用仓库的 `dist/server/stdio-bridge.js`；
- 先调用 `get_overview` 验证工具列表和权限。

## 网站登录或写操作失败

### 登录反复提示密码错误

- 密码区分大小写；
- Phosphene 没有找回密码或邮件重置入口；
- 不要删除数据库来“重置密码”，这会同时删除业务数据；
- 如果仍有已登录设备，可先导出数据和创建卷快照，再决定恢复方案。

### 页面提示安全令牌 / CSRF 错误

- 刷新页面重新取得 Cookie；
- 确认浏览器没有只拦截 `phosphene_csrf` Cookie；
- 确认网站始终通过同一个 HTTPS 域名访问，不要在 IP、HTTP 和域名之间切换；
- 清除该站点 Cookie 后需要重新登录。

### Token 轮换按钮没有反应

新版页面会显示具体错误。确认会话未过期，然后刷新并重试。轮换成功后务必立即保存新 Token；页面不会再次展示原文。

## 图片问题

### 图片提交被拒绝

支持真实 JPEG、PNG、WebP；扩展名正确但内容不是图片也会被拒绝。每次最多 4 张、单张最多 10 MB、像素总数最多 2400 万。HEIC/HEIF 需要先在设备上转换。

### AI 看不到图片

AI 必须通过 `query_tasks(status="submitted", include_proof=true)` 查询，服务端才会附带审核预览。AI 新建任务只开放 `none`、`text`、`text_and_image`，因此需要图片时也会同时有文字证据。

### ZIP 恢复返回 `invalid_backup`

- 只选择由自己实例导出的原始 ZIP，不要解压后重新打包；
- 检查浏览器下载是否完整；
- 旧 version 1 ZIP 仍受支持，不需要手工转换；
- 保留恢复前卷快照和错误信息，不要连续上传来源不明的文件。

### 页面短暂返回 `503 backup_maintenance`

导出或恢复开始后，Phosphene 会等待已进入的请求结束并短暂关闭业务入口，防止备份时间点
不一致。等待当前操作完成即可；`/healthz` 仍应返回 200。若没有人在操作备份但状态长期不消失，
检查服务是否正在重启或恢复是否因卷空间不足卡住。

### 恢复后图片仍异常

同一 ZIP 支持在原实例就地恢复，不会再因旧对象 Key 已存在而失败。先检查恢复是否明确返回成功，
再打开历史任务验证；如果只有某张图片失败，保留 ZIP、任务 id 和相关日志并提交问题，不要删除
整个 `/data/uploads`。

## PWA 没更新或不能安装

- PWA 安装需要 HTTPS，`localhost` 开发环境除外；
- Android/Chrome/Edge 可用浏览器安装提示；
- iPhone/iPad 使用 Safari“分享 → 添加到主屏幕”；
- 更新后完全关闭已安装 PWA，再从浏览器打开网站刷新一次；
- 离线缓存只保存应用壳层，不保存任务 API、MCP 或私有图片；断网时不能提交任务。

## 更新后出现数据库错误

1. 停止反复重启，先保留当前 `/data` 卷；
2. 记录失败版本、上一版本和第一条 migration 错误；
3. 尝试回滚到上一应用部署；
4. 若旧应用无法读取新结构，使用升级前的整卷快照恢复；
5. 不要手工删除 Drizzle migration 记录或直接修改生产 SQLite 表。

## 提交问题时应提供什么

可以提供：

- Phosphene commit 或镜像标签；
- 部署方式、内存大小、卷挂载路径；
- 去除隐私后的第一条报错和相邻日志；
- `/healthz` 的状态；
- 问题发生在首次部署、更新、重启、MCP、图片还是恢复。

不要提供网站密码、Setup Token、AI Token、Cookie、真实任务文字或证据图片。
