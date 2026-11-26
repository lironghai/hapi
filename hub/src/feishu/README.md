# Feishu and Lark

The Hub uses the official Node SDK and an outbound WebSocket. Create an internal app, enable its bot, give it access to messages sent privately to the bot and permission to send as the bot, then publish it for the intended users. In Events and Callbacks, select long connection delivery and subscribe to the message event `im.message.receive_v1` and card callback `card.action.trigger`.

Set `FEISHU_APP_ID` and `FEISHU_APP_SECRET` before starting the Hub. The default service is Feishu. Set `FEISHU_BASE_URL=https://open.larksuite.com` for Lark. `FEISHU_ENABLED=false` turns the integration off. `FEISHU_NOTIFICATION=false` keeps chat commands available and turns off outgoing session notifications.

In a private chat with the bot, send `/bind <CLI_API_TOKEN>` for the default namespace or `/bind <CLI_API_TOKEN>:<namespace>` for a named namespace. Use the token configured on the Hub. Feishu receives that token as part of your private message. Each app-specific user binding belongs to one namespace. Several people can bind to the same namespace, so each of them can read the session notifications and act on permission requests there.

| Command | Action |
| --- | --- |
| `/sessions` or `/list` | List active sessions in the bound namespace. |
| `/send <session_id> <message>` | Send a message and select the session for later messages. A unique session ID prefix is accepted. |
| `/cmds` | List slash commands for the selected session, or the most recently updated active session. |
| `/allow <request_id>` or `/deny <request_id>` | Answer a pending permission request by full ID or unique prefix. |
| `/help` | Show available commands. |

Other messages and slash commands go to the selected session, or to the only active session. A permission notification includes Allow and Deny buttons. For an agent question requiring a typed answer, open the session in HAPI. The Hub also sends ready notifications and assistant replies.

If notifications are missing, verify that the app is published, the WebSocket connected, notifications are enabled and the active session is in your bound namespace. If you change the app ID, bind again with the new bot.
