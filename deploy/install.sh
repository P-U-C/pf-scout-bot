#!/usr/bin/env bash
# install.sh — Deploy pf-scout-api (Phase 1) + pf-scout-bot (Phase 2)
set -euo pipefail

INSTALL_DIR="/opt/pf-scout-bot"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== PF Scout Bot installer ==="
echo "Repo:    $REPO_DIR"
echo "Target:  $INSTALL_DIR"
echo ""

# ── System deps ──────────────────────────────────────────────────────────────
echo "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git python3 python3-pip python3-venv

# Node.js 20 LTS (if not already installed)
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(+process.versions.node.split(".")[0] < 18)')" ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "Node $(node -v) / npm $(npm -v)"

# ── Copy repo to install dir ──────────────────────────────────────────────────
echo "Copying files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='__pycache__' \
  "$REPO_DIR/" "$INSTALL_DIR/"

# ── Phase 1: pf-scout-api (Python) ────────────────────────────────────────────
echo "Setting up pf-scout-api (Phase 1)..."
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install -q --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install -q pf-scout fastapi uvicorn pydantic-settings

# Patch the service to use the venv python
sed -i "s|ExecStart=.*|ExecStart=$INSTALL_DIR/.venv/bin/uvicorn scout_api.main:app --host 127.0.0.1 --port 8420|" \
  "$INSTALL_DIR/deploy/pf-scout-api.service" 2>/dev/null || true

# ── Phase 2: bot (Node.js) ────────────────────────────────────────────────────
echo "Installing bot dependencies..."
cd "$INSTALL_DIR/bot"
npm install --omit=dev

# ── .env ─────────────────────────────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/deploy/.env.example" "$INSTALL_DIR/.env"
  echo ""
  echo "⚠️  Created $INSTALL_DIR/.env from template."
  echo "    Edit it before starting the services:"
  echo "    $EDITOR $INSTALL_DIR/.env"
  echo ""
fi

# ── systemd ───────────────────────────────────────────────────────────────────
echo "Installing systemd services..."
cp "$INSTALL_DIR/deploy/pf-scout-api.service" /etc/systemd/system/
cp "$INSTALL_DIR/deploy/pf-scout-bot.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable pf-scout-api pf-scout-bot

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit /opt/pf-scout-bot/.env  (set BOT_SEED, API keys, etc.)"
echo "  2. Start services:"
echo "       systemctl start pf-scout-api"
echo "       systemctl start pf-scout-bot"
echo "  3. Watch logs:"
echo "       journalctl -fu pf-scout-api"
echo "       journalctl -fu pf-scout-bot"

# Enable enrichment timer (Phase 3)
cp /opt/pf-scout-bot/deploy/pf-scout-enrichment.service /etc/systemd/system/
cp /opt/pf-scout-bot/deploy/pf-scout-enrichment.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable pf-scout-enrichment.timer
systemctl start pf-scout-enrichment.timer
