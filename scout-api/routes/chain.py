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
    """Top PFT holders among indexed wallets."""
    db = get_db()
    try:
        rows = db.execute("""
            SELECT address, balance_drops, tx_count, memo_tx_count
            FROM accounts
            WHERE balance_drops IS NOT NULL AND CAST(balance_drops AS INTEGER) > 0
            ORDER BY CAST(balance_drops AS INTEGER) DESC
            LIMIT ?
        """, (limit,)).fetchall()

        results = []
        for i, row in enumerate(rows):
            bal_drops = int(row["balance_drops"] or 0)
            pft = bal_drops / 1_000_000
            results.append({
                "rank": i + 1,
                "address": row["address"],
                "balance_pft": round(pft, 2),
                "tx_count": row["tx_count"],
                "memo_tx_count": row["memo_tx_count"],
            })
        return {"richlist": results, "total": len(results)}
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
