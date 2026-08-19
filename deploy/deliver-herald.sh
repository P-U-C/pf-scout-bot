#!/bin/bash
# Deliver the daily Herald edition to all active SUBS subscribers.
# Runs once per day. Reads herald/latest.txt and sends it on-chain
# to every wallet currently subscribed to the 'herald' service.

python3 << 'PYEOF'
import sqlite3, json, os, subprocess, sys
from datetime import datetime, timezone

DB_PATH = os.path.expanduser('~/.pf-scout/chain-index.db')
SUBS_JSON = os.path.expanduser('~/pft-validator/lens/subs.json')
HERALD_TEXT = os.path.expanduser('~/pft-validator/herald/latest.txt')
DELIVERY_LOG = os.path.expanduser('~/.pf-scout/herald-delivery-log.json')

# Load the edition text to send
try:
    with open(HERALD_TEXT) as f:
        content = f.read().strip()
except Exception as e:
    print(f"ERROR: cannot read {HERALD_TEXT}: {e}", file=sys.stderr)
    sys.exit(1)

if not content:
    print("ERROR: herald text is empty", file=sys.stderr)
    sys.exit(1)

# Load the service registry to find Herald config
try:
    with open(SUBS_JSON) as f:
        reg = json.load(f)
except Exception as e:
    print(f"ERROR: cannot read subs.json: {e}", file=sys.stderr)
    sys.exit(1)

herald_svc = next((s for s in reg.get('services', []) if s.get('service_id') == 'herald'), None)
if not herald_svc:
    print("ERROR: herald service not in subs.json", file=sys.stderr)
    sys.exit(1)

protocol_addr = reg.get('protocol_address', '')
price_drops = herald_svc.get('price_drops', 1000000000)
period_days = herald_svc.get('period_days', 30)

# Find active subscribers (same canonical 7-condition query from subs-verify)
db = sqlite3.connect(DB_PATH)
db.row_factory = sqlite3.Row

subscribers = db.execute(f"""
    SELECT DISTINCT account
    FROM transactions
    WHERE destination = ?
      AND CAST(amount_drops AS INTEGER) >= ?
      AND CAST(amount_drops AS INTEGER) < ?
      AND tx_type = 'Payment'
      AND account != ?
      AND timestamp_iso > datetime('now', '-{period_days} days')
""", (protocol_addr, price_drops, price_drops + 1000000, protocol_addr)).fetchall()
# Match export-subs.sh heuristic: exact-price range match, ignoring memo_type.
# The canonical 7-condition check in the SUBS spec expected memo_type='subs.subscribe',
# but the task node UI wraps all commands in keystone envelopes, so the chain records
# memo_type='keystone' for real subscriptions. We match by price range instead.

active_subs = [r['account'] for r in subscribers]
db.close()

print(f"Active Herald subscribers: {len(active_subs)}")
for s in active_subs:
    print(f"  {s}")

if not active_subs:
    print("No subscribers to deliver to. Exiting.")
    sys.exit(0)

# Load delivery log (dedup: don't re-deliver same edition to same subscriber)
edition_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
try:
    with open(DELIVERY_LOG) as f:
        log = json.load(f)
except:
    log = {}

if edition_date not in log:
    log[edition_date] = []

already_delivered = set(log[edition_date])
to_deliver = [s for s in active_subs if s not in already_delivered]
if not to_deliver:
    print(f"All subscribers already received edition {edition_date}")
    sys.exit(0)

print(f"Delivering edition {edition_date} to {len(to_deliver)} subscriber(s)")

# Use the existing SUBS bot to send the message.
# We write the recipient list to a file and invoke a Node helper that uses
# the bot's keystone/crypto stack to send the encrypted on-chain memo.
delivery_request = {
    'edition_date': edition_date,
    'recipients': to_deliver,
    'content': content,
}

REQUEST_PATH = '/tmp/herald-delivery-request.json'
with open(REQUEST_PATH, 'w') as f:
    json.dump(delivery_request, f)

# Run the Node sender script
node_script = '/home/ubuntu/pf-scout-bot/bot/src/herald-send.ts'
env = os.environ.copy()
env['PFTL_RPC_URL'] = env.get('PFTL_RPC_URL', 'http://127.0.0.1:5015')

try:
    result = subprocess.run(
        ['npx', 'tsx', node_script, REQUEST_PATH],
        cwd='/home/ubuntu/pf-scout-bot/bot',
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    print(result.stdout)
    if result.stderr:
        print('STDERR:', result.stderr, file=sys.stderr)
    if result.returncode != 0:
        print(f"Sender exited {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)
except Exception as e:
    print(f"ERROR running sender: {e}", file=sys.stderr)
    sys.exit(1)

# Parse which recipients were delivered (sender writes result to file)
try:
    with open('/tmp/herald-delivery-result.json') as f:
        delivered = json.load(f).get('delivered', [])
except:
    delivered = to_deliver  # fallback — assume all were delivered

# Update delivery log
log[edition_date].extend(delivered)
log[edition_date] = list(set(log[edition_date]))

# Prune old log entries (keep last 30 days)
from datetime import timedelta
cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).strftime('%Y-%m-%d')
log = {k: v for k, v in log.items() if k >= cutoff}

with open(DELIVERY_LOG, 'w') as f:
    json.dump(log, f, indent=2)

print(f"Delivery complete: {len(delivered)}/{len(to_deliver)} successful")
PYEOF
