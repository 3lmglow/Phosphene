# 安全说明

Phosphene 面向一位用户和一位 AI 的私人实例。

## 部署检查

- 为应用挂载私有持久卷，路径为 `/data`。
- 使用 HTTPS 访问网站与 MCP。
- 域名公开前完成首次设置，或设置私密的 `PHOSPHENE_SETUP_TOKEN`。
- 公网实例保持 `PHOSPHENE_MCP_AUTH_MODE=token`。
- 不通过静态文件服务暴露 `/data`。
- 更新前创建卷快照并下载网站 ZIP。
- 删除服务时确认是否保留持久卷；数据库和图片都在卷中。

## 凭据

- AI Token 保存在可信 MCP 客户端或后端，不放进 URL、浏览器代码、日志、截图或公开仓库。
- Webhook 签名密钥只保存在 Phosphene 与接收端。
- Token 或密钥进入不可信位置后立即轮换。
- 网站 ZIP 不包含登录密码、AI Token 或 Webhook 配置；整卷快照包含当前实例凭据，应作为私密备份保存。

## 数据

- 证据图片重新编码为 WebP，并移除 EXIF 与 GPS。
- 图片和网站 ZIP 只通过需要认证的路由访问。
- ZIP 恢复校验路径、大小、哈希、格式和像素，但仍应只恢复自己实例导出的备份。

备份与恢复流程见 [docs/BACKUP.md](docs/BACKUP.md)。

## 报告漏洞

如果仓库的 Security 页面提供 **Report a vulnerability**，请使用 GitHub Private Vulnerability Report。若该入口不可用，可以在公开 issue 中只请求一个私密联络渠道，不附漏洞细节。

私密报告中提供受影响版本、复现步骤与影响，并移除真实密码、Token、Cookie、任务文字和证据图片。普通问题继续使用公开 issue。
