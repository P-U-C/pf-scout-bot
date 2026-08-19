#!/bin/bash
# Keep SUBS bot alive
if ! pgrep -f "subs-bot.ts" > /dev/null; then
  cd /home/ubuntu/pf-scout-bot/bot
  SUBS_SEED=$(grep '^SUBS_SEED=' ../.env | cut -d= -f2) \
  TASKNODE_ENCRYPTION_PUBKEY=$(grep '^TASKNODE_ENCRYPTION_PUBKEY=' ../.env | cut -d= -f2) \
  KEYSTONE_API_KEY=$(grep '^SUBS_KEYSTONE_API_KEY=' ../.env | cut -d= -f2) \
  PFTL_RPC_URL=http://127.0.0.1:5015 \
  XRPL_SERVER=wss://ws.testnet.postfiat.org \
  nohup npx tsx src/subs-bot.ts >> /tmp/subs-bot.log 2>&1 &
  echo "[$(date)] SUBS bot restarted PID: $!" >> /tmp/subs-bot-ping.log
fi
