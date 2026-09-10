#!/usr/bin/env bash
# 微信 bridge 独立启动脚本。只加载 .env.wechat，只处理微信消息。
# 首次运行（或传 --login）需要在前台用手机微信扫码。
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v caffeinate >/dev/null 2>&1; then
  echo "[start-wechat] macOS 防睡眠模式(caffeinate -is)"
  exec caffeinate -is npx tsx src/wechat-main.ts "$@"
else
  echo "[start-wechat] 直接启动"
  exec npx tsx src/wechat-main.ts "$@"
fi
