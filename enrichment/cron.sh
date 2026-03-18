#!/usr/bin/env bash
# pf-scout enrichment cron entry point
# Suggested crontab entry (runs every 6 hours):
#   0 */6 * * * /opt/pf-scout-bot/enrichment/cron.sh >> /var/log/pf-scout-enrichment.log 2>&1

set -euo pipefail

# Load environment variables if .env exists
if [[ -f /opt/pf-scout-bot/.env ]]; then
    # shellcheck disable=SC1091
    source /opt/pf-scout-bot/.env
fi

export PYTHONPATH="/opt/pf-scout-bot:${PYTHONPATH:-}"
cd /opt/pf-scout-bot

exec /opt/pf-scout-bot/.venv/bin/python -m enrichment.refresh
