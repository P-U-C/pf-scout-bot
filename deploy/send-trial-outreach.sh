#!/bin/bash
# send-trial-outreach.sh — outreach to active contributors not yet in
# the SUBS CRM. Each gets a free 7-day Herald trial.
#
# DRY_RUN=1 to preview targets without sending. Sender logic lives in
# bot/src/send-trial-outreach.ts (extracted from inline heredoc on
# 2026-05-20 because tsx 4.21+ `npx tsx -e` no longer resolves
# `./src/chain.js` correctly under ESM packages).

cd /home/ubuntu/pf-scout-bot/bot

SUBS_SEED=$(grep '^SUBS_SEED=' ../.env | cut -d= -f2)
TASKNODE_ENCRYPTION_PUBKEY=$(grep '^TASKNODE_ENCRYPTION_PUBKEY=' ../.env | cut -d= -f2)
KEYSTONE_API_KEY=$(grep '^SUBS_KEYSTONE_API_KEY=' ../.env | cut -d= -f2)
PFTL_RPC_URL=http://127.0.0.1:5015
XRPL_SERVER=wss://ws.testnet.postfiat.org

export SUBS_SEED TASKNODE_ENCRYPTION_PUBKEY KEYSTONE_API_KEY PFTL_RPC_URL XRPL_SERVER

npx tsx src/send-trial-outreach.ts
