#!/bin/bash
# send-expiry-reminders.sh — daily cron wrapper for the expiry-reminder sender.
#
# Cron schedule: 10 0 * * *  (00:10 UTC, 5 minutes after deliver-herald.sh)
#
# DRY_RUN=1 to preview without sending. Sender logic lives in
# bot/src/send-expiry-reminders.ts.

cd /home/ubuntu/pf-scout-bot/bot

SUBS_SEED=$(grep '^SUBS_SEED=' ../.env | cut -d= -f2)
TASKNODE_ENCRYPTION_PUBKEY=$(grep '^TASKNODE_ENCRYPTION_PUBKEY=' ../.env | cut -d= -f2)
KEYSTONE_API_KEY=$(grep '^SUBS_KEYSTONE_API_KEY=' ../.env | cut -d= -f2)
PFTL_RPC_URL=http://127.0.0.1:5015
XRPL_SERVER=wss://ws.testnet.postfiat.org

export SUBS_SEED TASKNODE_ENCRYPTION_PUBKEY KEYSTONE_API_KEY PFTL_RPC_URL XRPL_SERVER

npx tsx src/send-expiry-reminders.ts
