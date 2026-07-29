# feishu-claude-bridge

> 飞书话题 ↔ 本地 Agent CLI 的薄通道(纯对话版)。在飞书群里 @ 机器人提问，bridge 把消息转给跑在你本机的 `claude` 或 `codex` CLI，再把回复实时渲染成飞书卡片贴回话题。

基于飞书 Channel SDK 实现，只保留**对话**核心。

## 工作原理

```
飞书群 @bot ──(飞书 Channel SDK WebSocket 长连)──► ChannelClient.events()
   │
   ▼  BridgeHandler.handleOne
   1. parseMessage           解析出 threadId / 文本 / sender
   2. sessionStore.get       查这个话题之前的 agent session
   3. card.start             飞书回一张「⏳ 处理中」卡片(顶楼 @ 用 reply_in_thread 开话题)
   4. renderPrompt           极简 prompt(线程上下文 + 用户消息)
   5. runAgent               spawn `claude` 或 `codex exec --json`(带 session 续接)
   6. 流式事件               card.handle 节流刷新卡片(实时显示文本 / 工具调用)
   7. card.finalize          用累计的回复文本定稿,exitCode 0 即 ✅
   8. sessionStore.put       存 sessionId,下一轮续接同一对话
```

- **话题续接**：顶楼 @bot 开一个话题；话题内再次 @bot 的回复(有 `root_id`)归到同一 `threadId` → 命中同一 agent session → Claude 用 `--resume`，Codex 用 `codex exec resume`，上下文连续。话题内未 @bot 的消息会被忽略。
- **群消息触发**：群聊和群话题中的每一条消息都必须直接 @bot 才会处理；未 @ 的普通讨论一律忽略。使用 `@bot 已解决`、`@bot done` 等结束词可以清理该话题的 agent session。
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
   - 接收消息相关 scope(`im:message.group_at_msg`、`im:message.p2p_msg` 等按需)
5. 发布版本并通过审核(企业内部应用一般自助通过)。
6. 在「凭证与基础信息」拿到 **App ID / App Secret**。
7. 把机器人**拉进一个飞书群**(群设置 → 群机器人 → 添加)。

## 安装 & 运行

```bash
cd feishu-claude-bridge
npm install                 # 会一并安装 vendored 的飞书 SDK
cp .env.example .env        # 填 FEISHU_APP_ID / FEISHU_APP_SECRET
npm run typecheck && npm test
bash bin/start.sh           # 长驻;控制台应打印 connected as <bot名>
```

使用本地 Codex：

```dotenv
AGENT_KIND=codex
AGENT_BIN=codex
```

Codex 模式会使用 `codex --dangerously-bypass-approvals-and-sandbox exec --json ...`，也就是完全放开沙箱和审批，方便访问网络和本机资源。请只把机器人放进可信群。

> 后台运行 + 写日志:
> `nohup bash bin/start.sh > ~/.feishu-claude-bridge/bridge.log 2>&1 &`

### ⚠️ macOS 必读:防睡眠(否则消息会延迟/收不到)

macOS 的节能 / **App Nap** 会把空闲或后台的 node 进程挂起 → 飞书长连接(WS)心跳停 →
被判定超时断开 → 重连慢(实测约 24s),消息卡在断开窗口、延迟几分钟甚至收不到。

`bin/start.sh` 已用 **`caffeinate -is`** 包裹运行来防止这点(直接 `npm start` 不防睡眠,
**不要用它长跑**)。即便如此,**合盖 / 系统休眠仍会断**。

**要真正稳定长期运行,把 bridge 放到一台常开、不休眠、网络稳定的机器(如 Linux 服务器)** ——
这是飞书长连接服务的部署前提,笔记本本质上不适合长驻。Linux 无此节能问题,`bin/start.sh`
会自动跳过 caffeinate 直接运行。

跑起来后，在群里 **@机器人** 发一句话 → 它会开一个**话题**并刷新出回复卡片。后续在该话题里每次都需要再次 **@机器人**，bridge 才会把新消息交给同一个本地 Codex session；未 @ 的普通讨论不会触发。发送 `@机器人 已解决` / `@机器人 done` 等结束词可清理该话题会话。

bridge 有三层丢消息保护：每 30 秒发送一次飞书应用层 ping，15 秒收不到 pong 就强制断开并自动重连；每 20 分钟主动刷新一次长连接；每 60 秒通过历史消息接口补拉遗漏的直接 @，并在 `~/.feishu-claude-bridge/delivery-state.json` 中持久化游标、按 `message_id` 去重。运行日志同时写入 `~/.feishu-claude-bridge/bridge.log`，不再只存在于启动终端。

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
| `CLAUDE_BIN` | | 旧配置兼容项；未设置 `AGENT_BIN` 时仍生效 |
| `SUBPROCESS_TIMEOUT_MS` | | 单轮超时，默认 30 分钟 |
| `FCB_CHANNEL_REFRESH_MS` | | WS 主动刷新周期，默认 1200000（20 分钟）；`0` 关闭 |
| `FCB_CATCHUP_INTERVAL_MS` | | 遗漏 @ 补拉周期，默认 60000（1 分钟）；`0` 关闭 |
| `FCB_CATCHUP_LOOKBACK_MS` | | 首次启用补拉的回看窗口，默认 300000（5 分钟） |

## 项目结构

```
src/
├── main.ts                 入口 + 优雅退出
├── config.ts               .env 校验
├── lark/
│   ├── transport.ts        LarkMessageEvent 类型 + AsyncQueue
│   ├── channel.ts          Channel SDK WS:入站 events() + 出站 reply/updateCard
│   ├── message.ts          parseMessage(抽文本 + 话题 threadId)
│   └── card.ts             CardRenderer:建卡 / 节流刷新 / finalize
├── claude/
│   ├── runner.ts           spawn claude/codex + NDJSON 解析
│   ├── sessionStore.ts     threadId → sessionId 持久化
│   └── prompt.ts           极简 prompt
└── bridge/
    └── handler.ts          编排:per-thread 串行 + 并发信号量 + handleOne
```
