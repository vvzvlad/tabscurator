"""Synchronous ``fn(conn)`` bodies for the ``tab_leases`` table (#72).

``open_tab``'s lease remembered per TAB: ``(instance_id, tab_id) -> (leased_at, until)``.
``navigate_tab`` carries a live one to the new url, and a reaped leased tab reads
``tab_reaped``. Each function runs inside one ``Database.write`` / ``Database.read`` call
(no ``await`` inside; Фаза 2 contract).
"""

from __future__ import annotations

import sqlite3


def upsert_tab_lease(
    conn: sqlite3.Connection, instance_id: str, tab_id: int, since: int, until: int
) -> None:
    """Record (or replace) the lease ``open_tab`` took on this tab."""
    conn.execute(
        "INSERT INTO tab_leases (instance_id, tab_id, leased_at, until) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(instance_id, tab_id) DO UPDATE SET "
        "leased_at = excluded.leased_at, until = excluded.until",
        (instance_id, tab_id, since, until),
    )


def get_tab_lease(conn: sqlite3.Connection, instance_id: str, tab_id) -> dict | None:
    """``{since, until}`` for this tab's lease, or ``None`` when it holds none."""
    row = conn.execute(
        "SELECT leased_at, until FROM tab_leases WHERE instance_id = ? AND tab_id = ?",
        (instance_id, tab_id),
    ).fetchone()
    return None if row is None else {"since": row[0], "until": row[1]}


def prune_tab_leases(conn: sqlite3.Connection, cutoff: int) -> int:
    """Delete lease rows with ``until < cutoff``; return the count deleted."""
    cur = conn.execute("DELETE FROM tab_leases WHERE until < ?", (cutoff,))
    return cur.rowcount
