#!/usr/bin/env bash
# 飞书 bridge 的显式启动入口；bin/start.sh 继续保留以兼容旧用法。
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash bin/start.sh
