#!/bin/bash
# Heartbeat ping for PF Scout bot — runs every 10 minutes via cron
export PATH="/home/ubuntu/.claude/local/bin:$PATH"
/home/ubuntu/.local/bin/claude -p "Use the ping tool to send a heartbeat." \
  --mcp-config /tmp/register-bot-mcp.json \
  --permission-mode bypassPermissions \
  --output-format text < /dev/null 2>/dev/null
