#!/usr/bin/env bash
# feishu-claude-bridge 启动脚本
#
# macOS 关键点:系统节能 / App Nap 会把空闲或后台的 node 进程挂起,导致飞书
# 长连接(WS)的心跳停掉 → 被判定超时断开 → 消息延迟甚至收不到。用 caffeinate
# 包裹运行可防止系统/进程被节能挂起,连接保持稳定。
#
# 用法:
#   bash bin/start.sh            # 前台运行(关终端即停)
#   nohup bash bin/start.sh >/dev/null 2>&1 &   # 后台；程序自身会写 bridge.log
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v caffeinate >/dev/null 2>&1; then
  echo "[start] macOS 防睡眠模式(caffeinate -is)"
  exec caffeinate -is npx tsx src/main.ts
else
  # Linux / 服务器:无此节能问题,直接跑
  echo "[start] 直接启动"
  exec npx tsx src/main.ts
fi
