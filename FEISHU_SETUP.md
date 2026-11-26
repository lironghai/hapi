# 飞书机器人配置

HAPI Hub 通过长连接接收机器人私聊消息。绑定后可以查看当前命名空间的活跃会话、给会话发消息，并处理工具审批。

## 配置应用并启动 Hub

1. 在飞书开放平台创建企业自建应用，启用机器人。申请 `im:message.p2p_msg:readonly`（获取发给机器人的单聊消息）和 `im:message:send_as_bot`（以应用身份发消息）。
2. 在运行 Hub 的终端设置应用凭据。在 Windows PowerShell 中运行以下命令，将占位符换成自己的值。国际版 Lark 另设 `FEISHU_BASE_URL=https://open.larksuite.com`，国内版默认使用 `https://open.feishu.cn`。
3. 从仓库根目录启动 Hub，等待日志出现 `[FeishuBot] WebSocket connected`。
4. 在开放平台「事件与回调」中，为事件和回调分别选择长连接。添加接收消息事件 `im.message.receive_v1` 和卡片交互回调 `card.action.trigger`，发布应用版本，并确保自己的账号在应用可用范围内。[飞书官方配置示例](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start)

```powershell
$env:FEISHU_APP_ID = "<应用 App ID>"
$env:FEISHU_APP_SECRET = "<应用 App Secret>"
bun run --cwd hub start
```

Hub 首次读取环境变量时，会将尚未配置的值保存到 `$HAPI_HOME/settings.json`，默认目录为 `~/.hapi`。也可以直接维护该文件，其中 `feishuAppId`、`feishuAppSecret` 对应上述两个变量。更新凭据后重启 Hub。

## 在私聊中验证

1. 向机器人发送 `/help`，确认机器人可以收发消息。
2. 发送 `/bind <CLI_API_TOKEN>` 绑定默认命名空间，或用 `/bind <CLI_API_TOKEN>:<namespace>` 绑定指定命名空间。此令牌用于访问 Hub，仅在自己管理的机器人私聊中输入。
3. 在同一命名空间启动 HAPI 会话，发送 `/sessions` 获取会话 ID，再发送 `/send <会话ID> <消息>`。后续普通消息会沿用选中的活跃会话。
4. 会话有待审批的工具调用时，在私聊卡片上允许或拒绝。需要填写内容的请求在 HAPI 会话中回答。

将 `FEISHU_NOTIFICATION` 设为 `false` 可以关闭主动通知，同时保留私聊命令。将 `FEISHU_ENABLED` 设为 `false` 可以关闭整个机器人。两个开关均在重启 Hub 后生效。
