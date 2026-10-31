"""Synchronous ``fn(conn)`` bodies for the ``page_notes`` table (§16 item 26).

A row is one Tack export the extension sent from a page; Claude reads the open ones and
marks them done. Each function runs inside one ``Database.write`` / ``Database.read`` call
(no ``await`` inside; Фаза 2 contract).
"""

from __future__ import annotations

import sqlite3


def insert_page_note(
    conn: sqlite3.Connection, instance_id: str, url: str, title: str, md: str,
    count: int, created_at: int,
) -> int:
    """Store one export and return its id."""
    cur = conn.execute(
        "INSERT INTO page_notes (instance_id, url, title, md, count, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (instance_id, url, title, md, count, created_at),
    )
    return int(cur.lastrowid)


def list_page_notes(
    conn: sqlite3.Connection, include_done: bool = False, url_contains: str | None = None
) -> list[dict]:
    """Notes oldest first; open ones only unless ``include_done``. ``url_contains`` is a
    case-insensitive substring of the page url (``instr`` rather than ``LIKE``, so a ``%``
    or ``_`` in it is matched literally)."""
    sql = (
        "SELECT id, instance_id, url, title, count, created_at, done_at, md "
        "FROM page_notes WHERE 1=1"
    )
    args: list = []
    if not include_done:
        sql += " AND done_at IS NULL"
    if url_contains:
        sql += " AND instr(lower(url), lower(?)) > 0"
        args.append(url_contains)
    sql += " ORDER BY created_at, id"
    return [
        {
            "id": r[0], "instance": r[1], "url": r[2], "title": r[3], "count": r[4],
            "created_at": r[5], "done_at": r[6], "md": r[7],
        }
        for r in conn.execute(sql, args).fetchall()
    ]


def mark_page_notes_done(conn: sqlite3.Connection, ids: list[int], done_at: int) -> int:
    """Set ``done_at`` on the still-open notes among ``ids``; return how many changed.
    An already-done note keeps its first ``done_at`` and is not counted."""
    if not ids:
        return 0
    marks = ", ".join("?" for _ in ids)
    cur = conn.execute(
        f"UPDATE page_notes SET done_at = ? WHERE done_at IS NULL AND id IN ({marks})",
        (done_at, *ids),
    )
    return int(cur.rowcount or 0)
