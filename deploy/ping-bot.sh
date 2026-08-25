#!/bin/bash
# Heartbeat ping for PF Scout bot — runs every 10 minutes via cron.
#
# This used to be `claude -p "Use the ping tool to send a heartbeat."`: a full
# model session, cold-starting an MCP server underneath it, to call one tool
# that takes no arguments and decides nothing. Measured 2026-08-25 across this
# script and ping-subs.sh: ~2,000 model turns a day, 62M tokens a day,
# **1.86 billion tokens a month** — more of the subscription than every piece
# of real work on this box combined. Spent on saying "still here".
#
# An MCP server is JSON-RPC over stdio. Nothing here needs to think, so nothing
# here thinks. mcp-call.py speaks the protocol directly.
#
# It also closes the orphan leak this script was famous for: npx double-forks,
# so a claude that exited still reparented its ~74MB server to PID 1 (718 of
# them OOM'd this box once). mcp-call.py keeps the server as a direct child and
# kills it on the way out.
exec timeout -k 15 180 /home/ubuntu/scripts/mcp-call.py \
  --config /tmp/register-bot-mcp.json --tool ping --timeout 150 >/dev/null 2>&1
