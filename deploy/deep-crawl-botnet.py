#!/usr/bin/env python3
"""
Deep crawl from the botfather outward to fully map the sybil network.
Starts at the botfather address, pulls every transaction, queues every new
counterparty, and recurses until no new addresses are discovered.

Writes everything into the existing chain-index.db.
"""

import sqlite3, json, urllib.request, time, os, sys
from collections import deque
from datetime import datetime, timezone

DB_PATH = os.path.expanduser('~/.pf-scout/chain-index.db')
RPC_URL = os.environ.get('PFTL_RPC_URL', 'http://127.0.0.1:5015')
SEED = 'r9k51cJFVaYRST5vMUsdokiYcwdpQdUJGR'  # Botfather
MAX_DEPTH = int(os.environ.get('MAX_DEPTH', '3'))
MAX_ACCOUNTS_PER_DEPTH = int(os.environ.get('MAX_ACCOUNTS', '2000'))

db = sqlite3.connect(DB_PATH)
db.row_factory = sqlite3.Row

def rpc(method, params):
    req = urllib.request.Request(
        RPC_URL,
        data=json.dumps({"method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def ensure_account(addr, depth):
    now = datetime.now(timezone.utc).isoformat()
    db.execute("""
        INSERT OR IGNORE INTO accounts (address, discovered_at, crawl_depth, tx_count, memo_tx_count)
        VALUES (?, ?, ?, 0, 0)
    """, (addr, now, depth))

def fetch_account_tx(addr):
    """Yield all payment transactions for an address."""
    marker = None
    for page in range(50):  # hard limit
        params = {"account": addr, "limit": 100}
        if marker:
            params["marker"] = marker
        try:
            d = rpc("account_tx", [params])
        except Exception as e:
            return
        result = d.get('result', {})
        if result.get('error'):
            return
        for t in result.get('transactions', []):
            tx = t.get('tx_json', t.get('tx', {}))
            meta = t.get('meta', {})
            if meta.get('TransactionResult') != 'tesSUCCESS':
                continue
            if tx.get('TransactionType') != 'Payment':
                continue
            amt = tx.get('Amount')
            if isinstance(amt, dict) or not amt:
                continue
            yield {
                'hash': tx.get('hash', ''),
                'account': tx.get('Account'),
                'destination': tx.get('Destination'),
                'amount_drops': str(amt),
                'ledger_index': t.get('ledger_index', 0),
                'timestamp_ripple': tx.get('date', 0),
                'has_memo': 1 if tx.get('Memos') else 0,
                'memo_type': (tx.get('Memos', [{}])[0].get('Memo', {}).get('MemoType', '') if tx.get('Memos') else ''),
            }
        marker = result.get('marker')
        if not marker:
            return

def ripple_to_iso(ripple_seconds):
    """Convert Ripple epoch (seconds since 2000-01-01) to ISO datetime."""
    if not ripple_seconds:
        return ''
    try:
        ts = int(ripple_seconds) + 946684800
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except:
        return ''

def store_tx(tx):
    """Insert a transaction if not already in the table."""
    memo_type_decoded = ''
    try:
        memo_type_decoded = bytes.fromhex(tx['memo_type']).decode('utf-8') if tx['memo_type'] else ''
    except:
        pass
    db.execute("""
        INSERT OR IGNORE INTO transactions
        (tx_hash, ledger_index, tx_type, account, destination, amount_drops,
         fee_drops, timestamp_ripple, timestamp_iso, has_memo, memo_type, memo_data_preview, memo_cid, raw_json)
        VALUES (?, ?, 'Payment', ?, ?, ?, '12', ?, ?, ?, ?, '', NULL, '{}')
    """, (
        tx['hash'], tx['ledger_index'], tx['account'], tx['destination'],
        tx['amount_drops'], tx['timestamp_ripple'],
        ripple_to_iso(tx['timestamp_ripple']),
        tx['has_memo'], memo_type_decoded,
    ))

def refresh_balance(addr):
    try:
        d = rpc("account_info", [{"account": addr, "ledger_index": "validated"}])
        result = d.get('result', {})
        if result.get('status') == 'error':
            return None
        balance = result.get('account_data', {}).get('Balance', '0')
        db.execute("UPDATE accounts SET balance_drops = ? WHERE address = ?", (balance, addr))
        return int(balance) / 1e6
    except:
        return None

def crawl_account(addr, depth):
    """Crawl an account's transactions, return set of new counterparties."""
    ensure_account(addr, depth)
    counterparties = set()
    tx_count = 0
    memo_count = 0

    for tx in fetch_account_tx(addr):
        store_tx(tx)
        tx_count += 1
        if tx['has_memo']:
            memo_count += 1
        # Track counterparty
        if tx['account'] == addr:
            if tx['destination']:
                counterparties.add(tx['destination'])
        elif tx['destination'] == addr:
            counterparties.add(tx['account'])

    # Update account stats
    db.execute("""
        UPDATE accounts SET
            tx_count = (SELECT COUNT(*) FROM transactions WHERE account = ?),
            memo_tx_count = (SELECT COUNT(*) FROM transactions WHERE account = ? AND has_memo = 1),
            last_crawled_at = ?
        WHERE address = ?
    """, (addr, addr, datetime.now(timezone.utc).isoformat(), addr))

    refresh_balance(addr)
    db.commit()
    return counterparties, tx_count

def main():
    print(f"Deep crawl starting from {SEED}")
    print(f"Max depth: {MAX_DEPTH}, max accounts per depth: {MAX_ACCOUNTS_PER_DEPTH}")
    print(f"Target: map the complete bot network")
    print()

    visited = set()
    # Queue of (address, depth)
    current_layer = [SEED]
    total_new_accounts = 0
    total_txns_indexed = 0

    start = time.time()

    for depth in range(MAX_DEPTH + 1):
        print(f"\n=== DEPTH {depth} ({len(current_layer)} accounts to crawl) ===")
        next_layer = set()

        for i, addr in enumerate(current_layer):
            if addr in visited:
                continue
            visited.add(addr)

            if len(next_layer) >= MAX_ACCOUNTS_PER_DEPTH:
                print(f"  Hit max accounts limit, skipping rest of layer")
                break

            try:
                counterparties, tx_count = crawl_account(addr, depth)
                total_txns_indexed += tx_count
                total_new_accounts += 1

                # Add new counterparties to next layer
                new_cps = counterparties - visited
                next_layer.update(new_cps)

                if i % 20 == 0 or i == len(current_layer) - 1:
                    elapsed = time.time() - start
                    print(f"  [{elapsed:.0f}s] {i+1}/{len(current_layer)}: {addr[:12]}... {tx_count} txns, {len(new_cps)} new counterparties (total visited: {len(visited)})")
            except Exception as e:
                print(f"  Error on {addr}: {e}")

            time.sleep(0.05)  # Rate limit

        current_layer = list(next_layer)
        if not current_layer:
            print(f"No new accounts at depth {depth+1}, stopping")
            break

    # Final stats
    print(f"\n=== CRAWL COMPLETE ===")
    print(f"Elapsed: {time.time() - start:.0f}s")
    print(f"Accounts visited: {len(visited)}")
    print(f"Transactions indexed: {total_txns_indexed}")

    total_accts = db.execute("SELECT COUNT(*) as c FROM accounts").fetchone()['c']
    active = db.execute("SELECT COUNT(*) as c FROM accounts WHERE tx_count > 0").fetchone()['c']
    zero_bal = db.execute("SELECT COUNT(*) as c FROM accounts WHERE CAST(balance_drops AS INTEGER) = 15000000").fetchone()['c']
    total_txns = db.execute("SELECT COUNT(*) as c FROM transactions").fetchone()['c']
    print(f"\nIndex state after crawl:")
    print(f"  Total accounts: {total_accts}")
    print(f"  Active accounts: {active}")
    print(f"  Total transactions: {total_txns}")
    print(f"  Accounts with exactly 15 PFT (bot signature): {zero_bal}")

    db.close()

if __name__ == '__main__':
    main()
