#!/bin/bash
# Heartbeat ping for SUBS bot — runs every 10 minutes via cron
export PATH="/home/ubuntu/.claude/local/bin:$PATH"
# timeout: while Keystone is unreachable this call hangs forever and leaks its
# stdio pft-chatbot-mcp server (~74 MB) to PPID 1. SIGTERM first so claude can
# shut its MCP children down cleanly; -k SIGKILLs if it ignores that.
timeout -k 15 180 /home/ubuntu/.local/bin/claude -p "Use the ping tool to send a heartbeat." \
  --mcp-config /tmp/register-subs-mcp-fresh.json \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  --output-format text < /dev/null 2>/dev/null
