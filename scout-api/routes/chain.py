"""
chain.py — Chain-native routes serving data from chain-index.db.

Provides wallet-based contributor intelligence using only on-chain signals:
- Transaction activity (total, memo count)
- Interaction graph (who talks to whom)
- Network centrality (peer count, edge count)
- Activity recency
- Sybil cluster membership
"""

import sqlite3
import os
from typing import Optional, List
from fastapi import APIRouter, Query
from pydantic import BaseModel

router = APIRouter()

CHAIN_DB = os.environ.get(
    "CHAIN_INDEX_DB",
    os.path.expanduser("~/.pf-scout/chain-index.db"),
)


def get_db():
    conn = sqlite3.connect(CHAIN_DB)
    conn.row_factory = sqlite3.Row
    return conn


# ─── Models ──────────────────────────────────────────────────────────

class WalletProfile(BaseModel):
    address: str
    tx_count: int = 0
    memo_tx_count: int = 0
    peer_count: int = 0
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    activity_score: float = 0.0  # normalized 0-1
    top_counterparties: list = []
    sybil_cluster: Optional[str] = None
    sybil_confidence: Optional[float] = None


class WalletSummary(BaseModel):
    address: str
    tx_count: int = 0
    memo_tx_count: int = 0
    peer_count: int = 0
    activity_score: float = 0.0
    sybil_flagged: bool = False


class ChainSearchResponse(BaseModel):
    results: list
    total: int
    query: str


class ChainStats(BaseModel):
    total_accounts: int
    active_accounts: int
    total_transactions: int
    memo_transactions: int
    total_edges: int
    sybil_clusters: int
    last_crawl: Optional[str] = None


# ─── Helper: compute activity score ──────────────────────────────────

def compute_activity_score(row: dict, max_memo: int) -> float:
    if max_memo <= 0:
        return 0.0
    # Weighted: 70% memo activity, 30% peer diversity
    memo_score = min(row.get("memo_tx_count", 0) / max(max_memo, 1), 1.0)
    peer_score = min(row.get("peer_count", 0) / 30, 1.0)  # 30 peers = max score
    return round(memo_score * 0.7 + peer_score * 0.3, 4)


# ─── Routes ──────────────────────────────────────────────────────────

@router.get("/stats", response_model=ChainStats)
def chain_stats():
    db = get_db()
    try:
        accounts = db.execute("SELECT COUNT(*) as c FROM accounts").fetchone()["c"]
        active = db.execute("SELECT COUNT(*) as c FROM accounts WHERE memo_tx_count > 0").fetchone()["c"]
        txns = db.execute("SELECT COUNT(*) as c FROM transactions").fetchone()["c"]
        memo_txns = db.execute("SELECT COUNT(*) as c FROM transactions WHERE has_memo = 1").fetchone()["c"]
        edges = db.execute("SELECT COUNT(*) as c FROM edges").fetchone()["c"]
        clusters = db.execute("SELECT COUNT(DISTINCT cluster_id) as c FROM sybil_clusters").fetchone()["c"]
        last_crawl = db.execute("SELECT value FROM crawl_state WHERE key = 'last_crawl_at'").fetchone()
        return ChainStats(
            total_accounts=accounts,
            active_accounts=active,
            total_transactions=txns,
            memo_transactions=memo_txns,
            total_edges=edges,
            sybil_clusters=clusters,
            last_crawl=last_crawl["value"] if last_crawl else None,
        )
    finally:
        db.close()


@router.get("/list", response_model=list)
def list_wallets(
    limit: int = Query(10, ge=1, le=50),
    sort: str = Query("activity", description="activity | memos | peers"),
    min_memos: int = Query(0),
):
    db = get_db()
    try:
        # Get max memo count for normalization
        max_row = db.execute("SELECT MAX(memo_tx_count) as m FROM accounts").fetchone()
        max_memo = max_row["m"] if max_row else 1

        # Get peer counts
        peer_counts = {}
        for row in db.execute("""
            SELECT address, COUNT(DISTINCT counterparty) as peers FROM (
                SELECT from_address as address, to_address as counterparty FROM edges
                UNION ALL
                SELECT to_address as address, from_address as counterparty FROM edges
            ) GROUP BY address
        """).fetchall():
            peer_counts[row["address"]] = row["peers"]

        # Get sybil flags
        sybil_flags = set()
        for row in db.execute("SELECT DISTINCT address FROM sybil_clusters").fetchall():
            sybil_flags.add(row["address"])

        # Get accounts
        order = {
            "activity": "memo_tx_count DESC, tx_count DESC",
            "memos": "memo_tx_count DESC",
            "peers": "tx_count DESC",
        }.get(sort, "memo_tx_count DESC")

        rows = db.execute(f"""
            SELECT address, tx_count, memo_tx_count
            FROM accounts
            WHERE memo_tx_count >= ?
            ORDER BY {order}
            LIMIT ?
        """, (min_memos, limit)).fetchall()

        results = []
        for row in rows:
            addr = row["address"]
            peer_count = peer_counts.get(addr, 0)
            r = dict(row)
            r["peer_count"] = peer_count
            score = compute_activity_score(r, max_memo)
            results.append(WalletSummary(
                address=addr,
                tx_count=row["tx_count"],
                memo_tx_count=row["memo_tx_count"],
                peer_count=peer_count,
                activity_score=score,
                sybil_flagged=addr in sybil_flags,
            ).model_dump())

        return results
    finally:
        db.close()


@router.get("/profile/{address}")
def wallet_profile(address: str):
    db = get_db()
    try:
        # Account info
        acct = db.execute("SELECT * FROM accounts WHERE address = ?", (address,)).fetchone()
        if not acct:
            return {"error": "Wallet not found", "address": address}

        # Peer count
        peers = db.execute("""
            SELECT COUNT(DISTINCT counterparty) as c FROM (
                SELECT to_address as counterparty FROM edges WHERE from_address = ?
                UNION ALL
                SELECT from_address as counterparty FROM edges WHERE to_address = ?
            )
        """, (address, address)).fetchone()["c"]

        # Top counterparties
        top_cps = db.execute("""
            SELECT counterparty, SUM(tx_count) as txns, SUM(memo_tx_count) as memos FROM (
                SELECT to_address as counterparty, tx_count, memo_tx_count FROM edges WHERE from_address = ?
                UNION ALL
                SELECT from_address as counterparty, tx_count, memo_tx_count FROM edges WHERE to_address = ?
            ) GROUP BY counterparty ORDER BY memos DESC, txns DESC LIMIT 5
        """, (address, address)).fetchall()

        # First/last transaction timestamps
        first_tx = db.execute(
            "SELECT MIN(timestamp_iso) as t FROM transactions WHERE account = ? OR destination = ?",
            (address, address)
        ).fetchone()
        last_tx = db.execute(
            "SELECT MAX(timestamp_iso) as t FROM transactions WHERE account = ? OR destination = ?",
            (address, address)
        ).fetchone()

        # Sybil status
        sybil = db.execute(
            "SELECT cluster_id, confidence, signals FROM sybil_clusters WHERE address = ?",
            (address,)
        ).fetchone()

        # Activity score
        max_row = db.execute("SELECT MAX(memo_tx_count) as m FROM accounts").fetchone()
        max_memo = max_row["m"] if max_row else 1
        r = dict(acct)
        r["peer_count"] = peers
        score = compute_activity_score(r, max_memo)

        return WalletProfile(
            address=address,
            tx_count=acct["tx_count"],
            memo_tx_count=acct["memo_tx_count"],
            peer_count=peers,
            first_seen=first_tx["t"] if first_tx else None,
            last_seen=last_tx["t"] if last_tx else None,
            activity_score=score,
            top_counterparties=[
                {"address": cp["counterparty"], "memos": cp["memos"], "txns": cp["txns"]}
                for cp in top_cps
            ],
            sybil_cluster=sybil["cluster_id"] if sybil else None,
            sybil_confidence=sybil["confidence"] if sybil else None,
        ).model_dump()
    finally:
        db.close()


@router.post("/search")
def search_wallets(query: str = "", limit: int = 10):
    """Search wallets by address prefix or return most active."""
    db = get_db()
    try:
        if query and len(query) >= 3:
            rows = db.execute("""
                SELECT address, tx_count, memo_tx_count FROM accounts
                WHERE address LIKE ? AND memo_tx_count > 0
                ORDER BY memo_tx_count DESC LIMIT ?
            """, (f"%{query}%", limit)).fetchall()
        else:
            rows = db.execute("""
                SELECT address, tx_count, memo_tx_count FROM accounts
                WHERE memo_tx_count > 0
                ORDER BY memo_tx_count DESC LIMIT ?
            """, (limit,)).fetchall()

        return {
            "results": [dict(r) for r in rows],
            "total": len(rows),
            "query": query,
        }
    finally:
        db.close()


@router.get("/richlist")
def rich_list(limit: int = Query(10, ge=1, le=50)):
    """Top PFT holders — users only (infrastructure wallets excluded)."""
    db = get_db()
    try:
        # Get infrastructure addresses to exclude
        infra = set(r["address"] for r in db.execute(
            "SELECT address FROM wallet_labels WHERE label_type = 'infrastructure'"
        ).fetchall())

        rows = db.execute("""
            SELECT a.address, a.balance_drops, a.tx_count, a.memo_tx_count,
                   l.label
            FROM accounts a
            LEFT JOIN wallet_labels l ON a.address = l.address
            WHERE a.balance_drops IS NOT NULL AND CAST(a.balance_drops AS INTEGER) > 0
            ORDER BY CAST(a.balance_drops AS INTEGER) DESC
        """).fetchall()

        results = []
        rank = 0
        for row in rows:
            if row["address"] in infra:
                continue
            rank += 1
            if rank > limit:
                break
            bal_drops = int(row["balance_drops"] or 0)
            pft = bal_drops / 1_000_000
            results.append({
                "rank": rank,
                "address": row["address"],
                "label": row["label"],
                "balance_pft": round(pft, 2),
                "tx_count": row["tx_count"],
                "memo_tx_count": row["memo_tx_count"],
            })
        return {"richlist": results, "total": len(results)}
    finally:
        db.close()


@router.get("/infra")
def infra_wallets():
    """Show tagged infrastructure wallets with balances."""
    db = get_db()
    try:
        rows = db.execute("""
            SELECT l.address, l.label, l.label_type, a.balance_drops, a.tx_count, a.memo_tx_count
            FROM wallet_labels l
            LEFT JOIN accounts a ON l.address = a.address
            WHERE l.label_type = 'infrastructure'
            ORDER BY CAST(COALESCE(a.balance_drops, '0') AS INTEGER) DESC
        """).fetchall()

        results = []
        for row in rows:
            bal_drops = int(row["balance_drops"] or 0)
            pft = bal_drops / 1_000_000
            results.append({
                "address": row["address"],
                "label": row["label"],
                "balance_pft": round(pft, 2),
                "tx_count": row["tx_count"] or 0,
                "memo_tx_count": row["memo_tx_count"] or 0,
            })
        return {"infrastructure": results, "total": len(results)}
    finally:
        db.close()


@router.post("/tag")
def tag_wallet(address: str, label: str, tagged_by: str = "user"):
    """Tag a wallet with a label. Anyone can tag."""
    db = get_db()
    try:
        # Check wallet exists
        acct = db.execute("SELECT 1 FROM accounts WHERE address = ?", (address,)).fetchone()
        if not acct:
            return {"error": "Wallet not found in index", "address": address}

        # Don't allow overwriting infrastructure tags
        existing = db.execute(
            "SELECT label_type FROM wallet_labels WHERE address = ?", (address,)
        ).fetchone()
        if existing and existing["label_type"] == "infrastructure":
            return {"error": "Cannot overwrite infrastructure labels", "address": address}

        db.execute("""
            INSERT OR REPLACE INTO wallet_labels (address, label, label_type, tagged_by, tagged_at)
            VALUES (?, ?, 'user', ?, datetime('now'))
        """, (address, label, tagged_by))
        db.commit()
        return {"tagged": True, "address": address, "label": label, "tagged_by": tagged_by}
    finally:
        db.close()


@router.get("/labels")
def all_labels():
    """List all wallet labels."""
    db = get_db()
    try:
        rows = db.execute("SELECT * FROM wallet_labels ORDER BY label_type, label").fetchall()
        return {"labels": [dict(r) for r in rows], "total": len(rows)}
    finally:
        db.close()


@router.get("/sybil")
def sybil_report():
    """Return all sybil clusters."""
    db = get_db()
    try:
        rows = db.execute("""
            SELECT cluster_id, address, confidence, signals, detected_at
            FROM sybil_clusters ORDER BY cluster_id, address
        """).fetchall()

        clusters = {}
        for row in rows:
            cid = row["cluster_id"]
            if cid not in clusters:
                clusters[cid] = {
                    "cluster_id": cid,
                    "confidence": row["confidence"],
                    "detected_at": row["detected_at"],
                    "addresses": [],
                    "signals": row["signals"],
                }
            clusters[cid]["addresses"].append(row["address"])

        return {"clusters": list(clusters.values()), "total": len(clusters)}
    finally:
        db.close()


@router.get("/whales")
def whales(limit: int = Query(10, ge=1, le=20)):
    """Top PFT holders — contributors only."""
    db = get_db()
    try:
        infra = set(r["address"] for r in db.execute(
            "SELECT address FROM wallet_labels WHERE label_type = 'infrastructure'"
        ).fetchall())
        rows = db.execute("""
            SELECT a.address, a.balance_drops, a.tx_count, a.memo_tx_count, l.label
            FROM accounts a LEFT JOIN wallet_labels l ON a.address = l.address
            WHERE a.balance_drops IS NOT NULL AND CAST(a.balance_drops AS INTEGER) > 0
            ORDER BY CAST(a.balance_drops AS INTEGER) DESC
        """).fetchall()
        results = []
        rank = 0
        for row in rows:
            if row["address"] in infra: continue
            rank += 1
            if rank > limit: break
            bal = int(row["balance_drops"] or 0) / 1_000_000
            results.append({"rank": rank, "address": row["address"], "label": row["label"],
                           "balance_pft": round(bal, 2), "memos": row["memo_tx_count"]})
        return {"whales": results}
    finally:
        db.close()


@router.get("/active")
def most_active(limit: int = Query(10, ge=1, le=20)):
    """Top wallets by memo activity — who's actually working."""
    db = get_db()
    try:
        infra = set(r["address"] for r in db.execute(
            "SELECT address FROM wallet_labels WHERE label_type = 'infrastructure'"
        ).fetchall())
        rows = db.execute("""
            SELECT a.address, a.memo_tx_count, a.tx_count, a.balance_drops, l.label
            FROM accounts a LEFT JOIN wallet_labels l ON a.address = l.address
            WHERE a.memo_tx_count > 0
            ORDER BY a.memo_tx_count DESC
        """).fetchall()
        results = []
        rank = 0
        for row in rows:
            if row["address"] in infra: continue
            rank += 1
            if rank > limit: break
            bal = int(row["balance_drops"] or 0) / 1_000_000
            results.append({"rank": rank, "address": row["address"], "label": row["label"],
                           "memos": row["memo_tx_count"], "txns": row["tx_count"],
                           "balance_pft": round(bal, 2)})
        return {"active": results}
    finally:
        db.close()


@router.get("/connections/{address}")
def connections(address: str, limit: int = Query(8, ge=1, le=20)):
    """Who does this wallet talk to? Top relationships."""
    db = get_db()
    try:
        rows = db.execute("""
            SELECT counterparty, SUM(tx_count) as txns, SUM(memo_tx_count) as memos,
                   SUM(CAST(total_amount_drops AS INTEGER)) as amt_drops
            FROM (
                SELECT to_address as counterparty, tx_count, memo_tx_count, total_amount_drops
                FROM edges WHERE from_address = ?
                UNION ALL
                SELECT from_address, tx_count, memo_tx_count, total_amount_drops
                FROM edges WHERE to_address = ?
            ) GROUP BY counterparty ORDER BY memos DESC, txns DESC LIMIT ?
        """, (address, address, limit)).fetchall()
        results = []
        for row in rows:
            label_row = db.execute("SELECT label FROM wallet_labels WHERE address = ?", (row["counterparty"],)).fetchone()
            pft = int(row["amt_drops"] or 0) / 1_000_000
            results.append({"address": row["counterparty"], "label": label_row["label"] if label_row else None,
                           "memos": row["memos"], "txns": row["txns"], "pft": round(pft, 2)})
        return {"address": address, "connections": results}
    finally:
        db.close()


@router.get("/check/{address}")
def check_wallet(address: str):
    """Quick health check on a wallet — is it legit?"""
    db = get_db()
    try:
        acct = db.execute("SELECT * FROM accounts WHERE address = ?", (address,)).fetchone()
        if not acct:
            return {"error": "Wallet not found", "address": address}
        
        label = db.execute("SELECT label, label_type FROM wallet_labels WHERE address = ?", (address,)).fetchone()
        sybil = db.execute("SELECT cluster_id, confidence, signals FROM sybil_clusters WHERE address = ?", (address,)).fetchone()
        
        peers = db.execute("""
            SELECT COUNT(DISTINCT cp) as c FROM (
                SELECT to_address as cp FROM edges WHERE from_address = ?
                UNION ALL SELECT from_address FROM edges WHERE to_address = ?
            )
        """, (address, address)).fetchone()["c"]
        
        first_tx = db.execute("SELECT MIN(timestamp_iso) as t FROM transactions WHERE (account = ? OR destination = ?) AND timestamp_iso != ''", (address, address)).fetchone()
        last_tx = db.execute("SELECT MAX(timestamp_iso) as t FROM transactions WHERE (account = ? OR destination = ?) AND timestamp_iso != ''", (address, address)).fetchone()
        
        bal = int(acct["balance_drops"] or 0) / 1_000_000
        total_memos = db.execute("SELECT SUM(memo_tx_count) FROM accounts").fetchone()[0] or 1
        share = round(acct["memo_tx_count"] / total_memos * 100, 2)
        
        return {
            "address": address,
            "label": label["label"] if label else None,
            "type": label["label_type"] if label else "contributor",
            "balance_pft": round(bal, 2),
            "memos": acct["memo_tx_count"],
            "txns": acct["tx_count"],
            "peers": peers,
            "network_share": share,
            "first_seen": first_tx["t"] if first_tx else None,
            "last_seen": last_tx["t"] if last_tx else None,
            "sybil_flagged": sybil is not None,
            "sybil_cluster": sybil["cluster_id"] if sybil else None,
            "sybil_confidence": sybil["confidence"] if sybil else None,
            "verdict": "CLEAN" if not sybil else f"FLAGGED ({sybil['cluster_id']}, {sybil['confidence']*100:.0f}%)"
        }
    finally:
        db.close()


@router.get("/pulse")
def network_pulse():
    """Network heartbeat — what's happening right now?"""
    db = get_db()
    try:
        total_accounts = db.execute("SELECT COUNT(*) FROM accounts WHERE tx_count > 0").fetchone()[0]
        total_memos = db.execute("SELECT COUNT(*) FROM transactions WHERE has_memo = 1").fetchone()[0]
        total_edges = db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        sybil_clusters = db.execute("SELECT COUNT(DISTINCT cluster_id) FROM sybil_clusters").fetchone()[0]
        
        # Concentration HHI
        total_memo_sum = db.execute("SELECT SUM(memo_tx_count) FROM accounts").fetchone()[0] or 1
        hhi_rows = db.execute("SELECT memo_tx_count FROM accounts WHERE memo_tx_count > 0").fetchall()
        hhi = sum((r[0] / total_memo_sum) ** 2 for r in hhi_rows)
        
        health = "Healthy" if hhi < 0.15 else ("Moderate" if hhi < 0.25 else "Concentrated")
        
        last_crawl = db.execute("SELECT value FROM crawl_state WHERE key = 'last_crawl_at'").fetchone()
        
        return {
            "wallets": total_accounts,
            "relationships": total_edges,
            "memos": total_memos,
            "sybil_clusters": sybil_clusters,
            "concentration_hhi": round(hhi, 4),
            "health": health,
            "last_indexed": last_crawl["value"] if last_crawl else None,
            "lens_url": "https://pft.permanentupperclass.com/lens/"
        }
    finally:
        db.close()


@router.get("/earners")
def top_earners(limit: int = Query(10, ge=1, le=20)):
    """Top wallets by incoming PFT — who's getting paid?"""
    db = get_db()
    try:
        infra = set(r["address"] for r in db.execute(
            "SELECT address FROM wallet_labels WHERE label_type = 'infrastructure'"
        ).fetchall())
        rows = db.execute("""
            SELECT to_address as address, SUM(CAST(total_amount_drops AS INTEGER)) as total_in
            FROM edges GROUP BY to_address
            ORDER BY total_in DESC
        """).fetchall()
        results = []
        rank = 0
        for row in rows:
            if row["address"] in infra: continue
            rank += 1
            if rank > limit: break
            pft = int(row["total_in"] or 0) / 1_000_000
            label_row = db.execute("SELECT label FROM wallet_labels WHERE address = ?", (row["address"],)).fetchone()
            results.append({"rank": rank, "address": row["address"],
                           "label": label_row["label"] if label_row else None,
                           "total_received_pft": round(pft, 2)})
        return {"earners": results}
    finally:
        db.close()


# ─── SUBS Protocol Routes ───────────────────────────────────────────

SUBS_JSON = os.path.expanduser("~/pft-validator/lens/subs.json")


@router.get("/subs/services")
def subs_services():
    """List all registered services from subs.json."""
    import json
    try:
        with open(SUBS_JSON) as f:
            data = json.load(f)
        return data
    except FileNotFoundError:
        return {"services": [], "error": "subs.json not found"}


@router.get("/subs/status/{address}")
def subs_status(address: str):
    """Check subscription status for a wallet against all services."""
    import json
    try:
        with open(SUBS_JSON) as f:
            registry = json.load(f)
    except FileNotFoundError:
        return {"subscriptions": [], "error": "subs.json not found"}

    db = get_db()
    try:
        services = registry.get("services", [])
        subs_protocol_addr = registry.get("protocol_address", "")
        results = []

        for svc in services:
            service_id = svc.get("service_id", "")
            price_drops = int(svc.get("price_drops", 0))
            period_days = int(svc.get("period_days", 30))

            # Check for subscription payment. Task Node sends all messages as
            # keystone-encrypted envelopes, so we match on amount rather than
            # memo_type. Any payment >= service price to the protocol address
            # from this user counts as a subscription.
            row = db.execute("""
                SELECT tx_hash, timestamp_iso, CAST(amount_drops AS INTEGER) as amount_drops
                FROM transactions
                WHERE destination = ?
                  AND account = ?
                  AND CAST(amount_drops AS INTEGER) >= ?
                  AND tx_type = 'Payment'
                ORDER BY timestamp_iso DESC
                LIMIT 1
            """, (subs_protocol_addr, address, price_drops)).fetchone()

            if not row:
                continue

            from datetime import datetime, timedelta, timezone
            payment_time = datetime.fromisoformat(row["timestamp_iso"].replace("Z", "+00:00"))
            expires_at = payment_time + timedelta(days=period_days)
            now = datetime.now(timezone.utc)

            if now >= expires_at:
                state = "expired"
            elif now >= expires_at - timedelta(hours=72):
                state = "expiring"
            else:
                state = "active"

            results.append({
                "service_id": service_id,
                "service_name": svc.get("name", ""),
                "state": state,
                "entitled": state in ("active", "expiring"),
                "started_at": row["timestamp_iso"],
                "expires_at": expires_at.isoformat(),
                "payment_tx": row["tx_hash"],
                "amount_pft": row["amount_drops"] / 1_000_000,
            })

        return {"subscriber": address, "subscriptions": results}
    finally:
        db.close()
