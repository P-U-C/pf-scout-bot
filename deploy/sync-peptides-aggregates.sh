#!/bin/bash
# sync-peptides-aggregates.sh
#
# Pull the peptides aggregate JSON from the live peptides host into the
# public trend-corpus theme, validate it, secret-scan, commit. Push only
# when DEPLOY_PUSH=1.
#
# Designed to be idempotent and cron-friendly. If the remote file hasn't
# changed (same sha256), this is a no-op.
#
# Env:
#   DEPLOY_PUSH               1 = git push trend-corpus after commit, 0 = local commit only (default 0)
#   AGGREGATES_REMOTE_HOST    SSH alias / host for the peptides runtime (default city-worker-peptides)
#   AGGREGATES_REMOTE_PATH    Path on the remote host to read (default /var/lib/peptide-public/peptides-aggregates.json)
#   AGGREGATES_LOCAL_DEST     Path in the local trend-corpus checkout (default ~/trend-corpus/trends/peptides/aggregates/peptides-aggregates.json)
#   TREND_CORPUS_DIR          Local trend-corpus checkout (default ~/trend-corpus)
#   TREND_CORPUS_PUSH_TOKEN   Optional: fine-grained PAT for the push (only used if DEPLOY_PUSH=1)

set -euo pipefail

REMOTE_HOST="${AGGREGATES_REMOTE_HOST:-city-worker-peptides}"
REMOTE_PATH="${AGGREGATES_REMOTE_PATH:-/var/lib/peptide-public/peptides-aggregates.json}"
TREND_CORPUS_DIR="${TREND_CORPUS_DIR:-$HOME/trend-corpus}"
LOCAL_DEST="${AGGREGATES_LOCAL_DEST:-$TREND_CORPUS_DIR/trends/peptides/aggregates/peptides-aggregates.json}"
SCHEMA_PATH="$TREND_CORPUS_DIR/schemas/aggregates.schema.json"

log() {
    printf "[%s] %s\n" "$(date -u +%FT%TZ)" "$*"
}

require_file() {
    [ -f "$1" ] || { log "missing required file: $1" >&2; exit 1; }
}

require_file "$SCHEMA_PATH"
[ -d "$TREND_CORPUS_DIR/.git" ] || { log "not a git checkout: $TREND_CORPUS_DIR" >&2; exit 1; }

TMP="$(mktemp --suffix=.json)"
trap 'rm -f "$TMP"' EXIT

log "scp $REMOTE_HOST:$REMOTE_PATH -> $TMP"
scp -q "$REMOTE_HOST:$REMOTE_PATH" "$TMP"

log "JSON parse + schema validation"
python3 - "$TMP" "$SCHEMA_PATH" <<'PY'
import json, sys
from pathlib import Path

candidate_path = Path(sys.argv[1])
schema_path = Path(sys.argv[2])

candidate = json.loads(candidate_path.read_text())
schema = json.loads(schema_path.read_text())

required = schema.get("required", [])
missing = [r for r in required if r not in candidate]
if missing:
    print(f"aggregates artifact missing required fields: {missing}", file=sys.stderr)
    sys.exit(2)

# Bound checks the validator will not catch: counts >= 0, threshold >= 1.
if candidate.get("underlying_claim_count", 0) < 0:
    print("underlying_claim_count must be >= 0", file=sys.stderr); sys.exit(2)
if candidate.get("underlying_source_count", 0) < 0:
    print("underlying_source_count must be >= 0", file=sys.stderr); sys.exit(2)
if candidate.get("min_count_threshold", 0) < 1:
    print("min_count_threshold must be >= 1", file=sys.stderr); sys.exit(2)
if candidate.get("theme_id") != "peptides":
    print("aggregates theme_id must be 'peptides'", file=sys.stderr); sys.exit(2)

# generated_at must be parseable as ISO 8601 UTC.
import datetime as dt
ts = candidate.get("generated_at", "")
try:
    dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
except Exception as exc:
    print(f"unparseable generated_at: {ts!r} ({exc})", file=sys.stderr); sys.exit(2)

# Allowlist-only: reject any top-level key not declared in the schema's properties.
allowed = set(schema.get("properties", {}).keys())
extras = [k for k in candidate if k not in allowed]
if extras:
    print(f"aggregates artifact has fields not in schema: {extras}", file=sys.stderr)
    sys.exit(2)

print("aggregates artifact valid")
PY

log "secret-pattern scan on candidate"
python3 - "$TMP" <<'PY'
import re, sys
PATTERNS = [
    r"OPENAI_API_KEY", r"ANTHROPIC_API_KEY", r"GITHUB_TOKEN",
    r"TELEGRAM_BOT_TOKEN", r"AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)",
    r"PRIVATE_KEY", r"MNEMONIC",
    r"ghp_[A-Za-z0-9_]{20,}", r"github_pat_[A-Za-z0-9_]{40,}",
    r"sk-[A-Za-z0-9]{20,}", r"xox[baprs]-[A-Za-z0-9-]{10,}",
    r"-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----",
    r"(?i)(api[_-]?key|secret|token)\s*[:=]\s*['\"][^'\"]+['\"]",
    r"\b505841972\b", r"\bU\d{8}\b",
]
text = open(sys.argv[1]).read()
hits = [p for p in PATTERNS if re.search(p, text)]
if hits:
    print(f"secret pattern hits: {hits}", file=sys.stderr); sys.exit(3)
print("secret scan: clean")
PY

# diff vs current; no-op if unchanged.
if [ -f "$LOCAL_DEST" ]; then
    if cmp -s "$TMP" "$LOCAL_DEST"; then
        log "nothing to publish (sha256 unchanged)"
        exit 0
    fi
fi

mkdir -p "$(dirname "$LOCAL_DEST")"
mv "$TMP" "$LOCAL_DEST"
log "staged $LOCAL_DEST"

cd "$TREND_CORPUS_DIR"

# Make validate must still pass after the new file lands.
log "make validate on trend-corpus"
make validate

# Stage by whitelist -- never git add -A.
git add -- "trends/peptides/aggregates/peptides-aggregates.json"

# Determine sha256 + claims count for the commit message.
SHA="$(sha256sum "$LOCAL_DEST" | awk '{print $1}')"
SUMMARY="$(python3 -c "
import json
d=json.load(open('$LOCAL_DEST'))
print(f'claims={d[\"underlying_claim_count\"]} sources={d[\"underlying_source_count\"]} generated_at={d[\"generated_at\"]}')
")"

if git diff --cached --quiet; then
    log "no staged changes after add -- exiting"
    exit 0
fi

git commit -m "peptides aggregates: $SUMMARY

sha256: $SHA"
log "committed"

if [ "${DEPLOY_PUSH:-0}" = "1" ]; then
    log "DEPLOY_PUSH=1 -- pushing to origin/main"
    if [ -n "${TREND_CORPUS_PUSH_TOKEN:-}" ]; then
        git -c http.extraheader="Authorization: Bearer $TREND_CORPUS_PUSH_TOKEN" push origin main
    else
        git push origin main
    fi
    log "pushed"
else
    log "would push (set DEPLOY_PUSH=1 to actually push)"
fi
