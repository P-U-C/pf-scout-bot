#!/bin/bash
# Hourly pipeline: crawl chain, classify, export all feeds, push to git
set -e
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting hourly pipeline ==="
cd /home/ubuntu/pf-scout-bot/indexer
PFTL_RPC_URL=http://127.0.0.1:5015 npx tsx src/index.ts all
bash /home/ubuntu/pf-scout-bot/deploy/export-audit.sh
bash /home/ubuntu/pf-scout-bot/deploy/export-graph.sh
bash /home/ubuntu/pf-scout-bot/deploy/export-health.sh
bash /home/ubuntu/pf-scout-bot/deploy/export-auth.sh
bash /home/ubuntu/pf-scout-bot/deploy/export-subs.sh
bash /home/ubuntu/pf-scout-bot/deploy/export-herald.sh
bash /home/ubuntu/pf-scout-bot/deploy/export-herald-latest.sh
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) Pipeline complete ==="
