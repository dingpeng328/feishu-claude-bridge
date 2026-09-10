# Feishu / WeChat local-agent bridges

> 两个相互隔离的本地 bridge：飞书话题可接 `claude` 或 `codex` CLI；微信 ClawBot 固定接本地 `codex` CLI。二者可以同时运行，每个进程只接收和回复自己的平台消息。

飞书侧基于 Channel SDK；微信侧使用腾讯公开的 ClawBot iLink 协议。两个入口都只保留**对话**核心。

## 双 bridge 隔离方式

| | 飞书进程 | 微信进程 |
|---|---|---|
| 配置文件 | `.env` | `.env.wechat` |
| 启动脚本 | `bin/start-feishu.sh`（兼容 `bin/start.sh`） | `bin/start-wechat.sh` |
| npm 命令 | `npm run start:feishu` | `npm run start:wechat` |
| 本地状态 | `~/.feishu-claude-bridge/` | `~/.wechat-codex-bridge/` |
| 消息源 | 飞书 Channel WebSocket | 微信 ClawBot iLink 长轮询 |

配置、PID 锁、日志、消息游标和 Codex 会话映射全部分开。停止或重启其中一个，不会停止另一个；两边只复用仓库里的 Agent runner 代码。

## 飞书工作原理

```
飞书群 @bot ──(飞书 Channel SDK WebSocket 长连)──► ChannelClient.events()
   │
   ▼  BridgeHandler.handleOne
   1. parseMessage           解析出 threadId / 文本 / sender
   2. sessionStore.get       查这个话题之前的 agent session
   3. getThreadContext       话题内 @ 时分页拉取首楼 + 全部回复
   4. card.start             启动原生 CardKit Markdown 流(顶楼 @ 用 reply_in_thread 开话题)
   5. renderPrompt           完整话题快照 + 当前用户消息
   6. runAgent               spawn `claude` 或 `codex exec --json`(带 session 续接)
   7. 流式事件               SDK 节流刷新正文；超长回复自动续卡
   8. card.finalize          用累计的回复文本定稿并结束打字机状态
   9. sessionStore.put       存 sessionId,下一轮续接同一对话
```

- **话题续接**：顶楼 @bot 开一个话题；在同一次 bridge 运行期间，话题内再次 @bot 的回复(有 `root_id`)归到同一 `threadId` → 命中同一 agent session → Claude 用 `--resume`，Codex 用 `codex exec resume`。bridge 每次启动都会清空上一次运行保存的 session 映射，所以重启后收到的第一条消息一定创建新的 agent session。每次话题内 @bot 时，还会重新分页拉取首楼和全部话题回复，因此期间未 @bot 的普通讨论也会进入本轮上下文。
- **群消息触发**：群聊和群话题中的每一条消息都必须直接 @bot 才会触发处理；未 @ 的普通讨论不会单独触发，但会在下一次话题内 @bot 时被一并读取。使用 `@bot 已解决`、`@bot done` 等结束词可以清理该话题的 agent session。
- **本机登录态**：复用你本机 CLI 的登录。Claude 模式下 bridge 会主动剥掉 `ANTHROPIC_API_KEY`，避免切到 API 计费。
- **共享 cwd**：默认 `~/.feishu-claude-bridge/work`；也可以设成某个项目仓库，让 agent 读写代码、执行命令。

## 前置

- **Node.js 20+**
- **`claude` CLI 或 `codex` CLI 且已登录**(Claude 先跑一次 `claude` 走 /login；Codex 先跑一次 `codex login`)
- **一个飞书自建应用**(下面配)
- 一台常开的机器(bridge 长驻接事件)

## 飞书 App 配置(需你本人在开放平台操作)

1. [飞书开放平台](https://open.feishu.cn/) → 创建**企业自建应用**。
2. **添加「机器人」能力**。
3. **事件订阅**：连接方式选**「使用长连接接收事件」**(WebSocket，不用配回调 URL)；订阅事件 `im.message.receive_v1`(接收消息)。
4. **权限管理**开通 scope：
   - `im:message`(读取与发送单聊/群消息)
   - `im:message:send_as_bot`(以应用身份发消息)
   - `im:message.group_msg`(读取群内完整话题历史)
   - 接收消息相关 scope(`im:message.group_at_msg`、`im:message.p2p_msg` 等按需)
5. 发布版本并通过审核(企业内部应用一般自助通过)。
6. 在「凭证与基础信息」拿到 **App ID / App Secret**。
7. 把机器人**拉进一个飞书群**(群设置 → 群机器人 → 添加)。

## 安装 & 运行

```bash
cd feishu-claude-bridge
npm install                 # 安装官方 @larksuite/channel SDK
cp .env.example .env        # 填 FEISHU_APP_ID / FEISHU_APP_SECRET
npm run typecheck && npm test
bash bin/start-feishu.sh    # 长驻;控制台应打印 connected as <bot名>
```

使用本地 Codex：

```dotenv
AGENT_KIND=codex
AGENT_BIN=codex
```

Codex 模式会使用 `codex --dangerously-bypass-approvals-and-sandbox exec --json ...`，也就是完全放开沙箱和审批，方便访问网络和本机资源。请只把机器人放进可信群。

> 后台运行 + 写日志:
> `nohup bash bin/start-feishu.sh >/dev/null 2>&1 &`

## 微信 bridge 安装与运行

微信侧采用 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 公开的 ClawBot iLink 协议，首次启动通过微信扫码取得本机凭证，不需要填写飞书 App ID/Secret，也不会读取 `.env` 里的飞书配置。

```bash
cd feishu-claude-bridge
npm install
cp .env.wechat.example .env.wechat
# 编辑 WECHAT_WORK_DIR，指向允许 Codex 工作的目录

# 首次必须前台启动并扫码；以后会复用本机凭证
bash bin/start-wechat.sh

# 需要重新绑定时
bash bin/start-wechat.sh --login
```

微信中可直接发文字或带文字转写的语音；`/new` 新建 Codex 会话，`/stop` 中止当前处理，`/status` 查看状态。每次进程重启会开启新的 Codex 会话边界，但消息消费游标会保留，用于避免重复处理。

扫码成功后的凭证仅写入 `~/.wechat-codex-bridge/account.json`（权限 `0600`）；日志不会输出 bot token。微信 Codex 默认运行在 `workspace-write` 沙箱，并自动批准沙箱内操作；可在 `.env.wechat` 改成 `read-only`。删除、发布、推送和生产写入仍要求对话中明确确认。

两个进程同时长驻：

```bash
nohup bash bin/start-feishu.sh >/dev/null 2>&1 &
nohup bash bin/start-wechat.sh >/dev/null 2>&1 &
```

日志分别位于 `~/.feishu-claude-bridge/bridge.log` 和 `~/.wechat-codex-bridge/bridge.log`。

> 进程和运行状态虽然隔离，但如果两份配置把 `WORK_DIR` / `WECHAT_WORK_DIR` 指向同一个 Git 工作区，两边同时改同一文件仍可能冲突。需要文件级完全隔离时，请给两个 bridge 配置不同的 Git worktree。

### ⚠️ macOS 必读:防睡眠(否则消息会延迟/收不到)

macOS 的节能 / **App Nap** 会把空闲或后台的 node 进程挂起 → 飞书长连接(WS)心跳停 →
被判定超时断开 → 重连慢(实测约 24s),消息卡在断开窗口、延迟几分钟甚至收不到。

两个 `bin/start-*.sh` 都已用 **`caffeinate -is`** 包裹运行来防止这点(直接运行 npm 命令不防睡眠,
**不要用它长跑**)。即便如此,**合盖 / 系统休眠仍会断**。

**要真正稳定长期运行,把 bridge 放到一台常开、不休眠、网络稳定的机器(如 Linux 服务器)** ——
这是飞书长连接服务的部署前提,笔记本本质上不适合长驻。Linux 无此节能问题,`bin/start.sh`
会自动跳过 caffeinate 直接运行。

跑起来后，在群里 **@机器人** 发一句话 → 它会开一个**话题**并刷新出回复卡片。后续在该话题里每次都需要再次 **@机器人** 才会触发；触发后 bridge 会拉取首楼和全部回复（包括期间未 @ 的普通讨论），再交给当前 bridge 进程内该话题的 Codex session 综合回答。重启 bridge 后，即使是原话题的新消息也会从新 session 开始；飞书话题文本仍会被拉取作为可见上下文。发送 `@机器人 已解决` / `@机器人 done` 等结束词可清理该话题会话。

bridge 有三层丢消息保护：官方 SDK 负责底层 ping/pong，并以 15 秒超时识别未响应连接；独立 keepalive 每 15 秒检查连接状态，连续 3 次异常且飞书网络可达时强制重连；bridge 每 20 分钟主动刷新一次长连接，并每 60 秒通过历史消息接口补拉遗漏的直接 @。补拉游标和 `message_id` 去重记录持久化在 `~/.feishu-claude-bridge/delivery-state.json`。对于从另一台机器或旧游标再次刷入的话题消息，bridge 还会检查共享的话题历史：若当前机器人已在该消息之后成功回复过，则跳过重复执行；仍处于处理中、被打断或失败的卡片不会阻止重试，机器人对更早消息的回复也不会阻止后来新发的 @。运行日志同时写入 `~/.feishu-claude-bridge/bridge.log`，不再只存在于启动终端。

回复展示使用飞书原生 CardKit Markdown 流：卡片顶部在整个生成期间固定显示“⏳ 正在处理”，完成后明确切换为“✅ 回复完成”，并显示从消息开始调度到最终结束的处理耗时；正文不堆叠工具调用和内部路径，标题层级会适配聊天卡片；单张卡片接近 30000 字符时由 SDK 自动创建续卡。失败或中断也会显示明确终态及处理耗时，内部错误只保留在服务日志中。原生流结束后，bridge 会按 `card_id + sequence` 对消息引用的同一个 CardKit 实体强制写入最终状态并回读校验；旧卡片才回退到 `message_id` 更新。若回读暂未看到终态，只会延迟重试更新同一张原卡片，不会新增一条重复回复。

补拉需要在飞书开放平台为机器人应用开通 **获取群组中所有消息**（`im:message.group_msg`）权限；没有该权限时，程序会记录一次明确告警并停用本进程的 HTTP 补拉，WS 接收和定期主动重连不受影响。

## 配置项(`.env`)

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | ✓ | 应用 App ID |
| `FEISHU_APP_SECRET` | ✓ | 应用 App Secret |
| `FEISHU_BOT_OPEN_ID` | | 机器人 open_id(仅日志) |
| `ALLOWED_CHAT_IDS` | | 逗号分隔的群白名单；留空 = 所有群 |
| `WORK_DIR` | | agent 运行的工作目录(所有话题共享）。留空=`~/.feishu-claude-bridge/work`（干净 scratch）；设成某仓库=机器人可读该仓库代码 / 用其 skill。sessions/delivery/log/pid 始终在 `~/.feishu-claude-bridge/`，不污染此目录 |
| `AGENT_KIND` | | `claude` 或 `codex`，默认 `claude`；当前推荐设为 `codex` |
| `AGENT_BIN` | | agent 路径；`AGENT_KIND=claude` 默认 `claude`，`AGENT_KIND=codex` 默认 `codex` |
| `AGENT_SYSTEM_PROMPT` | | 新 Agent 会话的角色/行为提示词；未配置时使用内置默认值。`.env` 双引号内可用 `\n` 表示多行；空字符串可关闭 |
| `CLAUDE_BIN` | | 旧配置兼容项；未设置 `AGENT_BIN` 时仍生效 |
| `SUBPROCESS_TIMEOUT_MS` | | 单轮超时，默认 30 分钟 |
| `FCB_CHANNEL_REFRESH_MS` | | WS 主动刷新周期，默认 1200000（20 分钟）；`0` 关闭 |
| `FCB_CATCHUP_INTERVAL_MS` | | 遗漏 @ 补拉周期，默认 60000（1 分钟）；`0` 关闭 |
| `FCB_CATCHUP_LOOKBACK_MS` | | 首次启用补拉的回看窗口，默认 300000（5 分钟） |

`AGENT_SYSTEM_PROMPT` 的内置默认值是：

```text
你是一个通过飞书话题和用户对话的助手,运行在用户本机的 Agent CLI 里。
请自然、简洁地用中文回复;需要时可以在工作目录里读写文件、执行命令。
```

这段提示词只负责角色和回答风格；`thread_id`、完整话题历史和当前消息仍由 bridge 自动拼接。配置修改后需重启 bridge，并从新的 Agent 会话开始生效。

## 微信配置项（`.env.wechat`）

| 变量 | 说明 |
|---|---|
| `WECHAT_WORK_DIR` | Codex 工作目录；默认 `~/.wechat-codex-bridge/work` |
| `WECHAT_AGENT_BIN` | Codex CLI 路径；默认 `codex` |
| `WECHAT_AGENT_SYSTEM_PROMPT` | 新微信 Codex 会话的系统提示词 |
| `WECHAT_SUBPROCESS_TIMEOUT_MS` | 单轮超时；默认 30 分钟 |
| `WECHAT_CODEX_SANDBOX` | `read-only` 或 `workspace-write`；默认后者 |
| `WECHAT_CODEX_APPROVE_FOR_ME` | 是否让 Codex 自动审查并批准操作；仅适用于 `workspace-write`，默认 `true` |
| `WECHAT_STATE_DIR` | 微信独立状态目录；默认 `~/.wechat-codex-bridge` |
| `WECHAT_API_BASE_URL` | 登录后 API base URL 的后备值；通常不需要修改 |
| `WECHAT_BOT_TYPE` | ClawBot 类型；默认 `3` |
| `WECHAT_BOT_AGENT` | 协议客户端标识；默认 `WechatCodexBridge/0.1.0` |

也可用 `WECHAT_ENV_FILE=/absolute/path/to/file` 指定另一份微信配置文件，适合在同一代码目录下管理不同运行环境。

## 项目结构

```
src/
├── main.ts                 飞书入口 + 优雅退出
├── wechat-main.ts          微信独立入口 + 扫码登录 + 优雅退出
├── config.ts               .env 校验
├── lark/
│   ├── transport.ts        LarkMessageEvent 类型 + AsyncQueue
│   ├── channel.ts          Channel SDK WS 入站 + 原生 CardKit stream 出站
│   ├── message.ts          parseMessage(抽文本 + 话题 threadId)
│   └── card.ts             CardRenderer:正文快照 / 展示优化 / finalize
├── claude/
│   ├── runner.ts           spawn claude/codex + NDJSON 解析
│   ├── sessionStore.ts     threadId → sessionId 持久化
│   └── prompt.ts           极简 prompt
├── bridge/
    └── handler.ts          编排:per-thread 串行 + 并发信号量 + handleOne
└── wechat/
    ├── config.ts           .env.wechat 校验 + 独立路径
    ├── auth.ts             ClawBot 扫码与凭证保存
    ├── protocol.ts         iLink 协议客户端
    ├── client.ts           长轮询、游标、去重、收发消息
    ├── handler.ts          微信会话 → 本地 Codex
    └── state.ts            微信凭证与消费状态
```
