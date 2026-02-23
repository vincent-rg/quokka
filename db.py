import sqlite3
import os
import uuid
import json
from contextlib import contextmanager


@contextmanager
def get_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def init_db(db_path):
    with get_connection(db_path) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS imputation_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                project TEXT NOT NULL DEFAULT '',
                open_date TEXT,
                close_date TEXT,
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                duration INTEGER NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                ado_workitem TEXT NOT NULL DEFAULT '',
                ado_pr TEXT NOT NULL DEFAULT '',
                imputation_account_id INTEGER,
                imputation_duration INTEGER,
                group_id TEXT,
                FOREIGN KEY (imputation_account_id) REFERENCES imputation_accounts(id)
            );

            CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);

            CREATE TABLE IF NOT EXISTS undo_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action_type TEXT NOT NULL,
                before_state TEXT NOT NULL,
                after_state TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                undone INTEGER NOT NULL DEFAULT 0
            );
        """)
        # Migration: add project column if missing
        cols = [r[1] for r in conn.execute("PRAGMA table_info(imputation_accounts)").fetchall()]
        if "project" not in cols:
            conn.execute("ALTER TABLE imputation_accounts ADD COLUMN project TEXT NOT NULL DEFAULT ''")
        # Migration: add open_date/close_date to accounts if missing
        if "open_date" not in cols:
            conn.execute("ALTER TABLE imputation_accounts ADD COLUMN open_date TEXT")
        if "close_date" not in cols:
            conn.execute("ALTER TABLE imputation_accounts ADD COLUMN close_date TEXT")
        # Migration: add group_id column if missing
        entry_cols = [r[1] for r in conn.execute("PRAGMA table_info(entries)").fetchall()]
        if "group_id" not in entry_cols:
            conn.execute("ALTER TABLE entries ADD COLUMN group_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_group_id ON entries(group_id)")
        # Migration: create entry_imputations table
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS entry_imputations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
                FOREIGN KEY (account_id) REFERENCES imputation_accounts(id)
            );
            CREATE INDEX IF NOT EXISTS idx_entry_imputations_entry
                ON entry_imputations(entry_id);
        """)
        # Migrate existing single-account data to entry_imputations
        has_old = conn.execute(
            "SELECT COUNT(*) FROM entries WHERE imputation_account_id IS NOT NULL"
        ).fetchone()[0]
        has_new = conn.execute("SELECT COUNT(*) FROM entry_imputations").fetchone()[0]
        if has_old and not has_new:
            conn.execute("""
                INSERT INTO entry_imputations (entry_id, account_id, duration, position)
                SELECT id, imputation_account_id, COALESCE(imputation_duration, 0), 0
                FROM entries WHERE imputation_account_id IS NOT NULL
            """)
        # Migration: create ado_link_types and entry_ado_items tables
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS ado_link_types (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                url_template TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS entry_ado_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id INTEGER NOT NULL,
                link_type_id INTEGER NOT NULL,
                value TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
                FOREIGN KEY (link_type_id) REFERENCES ado_link_types(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_entry_ado_items_entry
                ON entry_ado_items(entry_id);
        """)
        # Seed default link types if table is empty
        has_types = conn.execute("SELECT COUNT(*) FROM ado_link_types").fetchone()[0]
        if not has_types:
            conn.execute("INSERT INTO ado_link_types (title, url_template, position) VALUES (?, ?, ?)",
                         ("Work Item", "", 0))
            conn.execute("INSERT INTO ado_link_types (title, url_template, position) VALUES (?, ?, ?)",
                         ("Pull Request", "", 1))
        # Migration: add sort_order column if missing
        entry_cols2 = [r[1] for r in conn.execute("PRAGMA table_info(entries)").fetchall()]
        if "sort_order" not in entry_cols2:
            conn.execute("ALTER TABLE entries ADD COLUMN sort_order INTEGER")
        # Migrate existing ado_workitem/ado_pr data to entry_ado_items
        has_ado_items = conn.execute("SELECT COUNT(*) FROM entry_ado_items").fetchone()[0]
        if not has_ado_items:
            wi_type = conn.execute("SELECT id FROM ado_link_types WHERE title = 'Work Item'").fetchone()
            pr_type = conn.execute("SELECT id FROM ado_link_types WHERE title = 'Pull Request'").fetchone()
            if wi_type:
                conn.execute("""
                    INSERT INTO entry_ado_items (entry_id, link_type_id, value, position)
                    SELECT id, ?, ado_workitem, 0 FROM entries WHERE ado_workitem != ''
                """, (wi_type["id"],))
            if pr_type:
                conn.execute("""
                    INSERT INTO entry_ado_items (entry_id, link_type_id, value, position)
                    SELECT id, ?, ado_pr, 1 FROM entries WHERE ado_pr != ''
                """, (pr_type["id"],))
        conn.commit()


# --- Undo/Redo infrastructure ---

ENTRY_COLUMNS = [
    "id", "date", "duration", "description", "notes",
    "ado_workitem", "ado_pr", "imputation_account_id",
    "imputation_duration", "group_id", "sort_order",
]

UNDO_STACK_LIMIT = 50


def _snapshot_entries(conn, entry_ids):
    if not entry_ids:
        return []
    placeholders = ",".join("?" * len(entry_ids))
    rows = conn.execute(
        f"SELECT * FROM entries WHERE id IN ({placeholders})", list(entry_ids)
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        splits = conn.execute(
            "SELECT * FROM entry_imputations WHERE entry_id = ? ORDER BY position",
            (d["id"],),
        ).fetchall()
        d["_splits"] = [dict(s) for s in splits]
        ado_items = conn.execute(
            "SELECT * FROM entry_ado_items WHERE entry_id = ? ORDER BY position",
            (d["id"],),
        ).fetchall()
        d["_ado_items"] = [dict(a) for a in ado_items]
        result.append(d)
    return result


def _record_undo(conn, action_type, before_entries, after_entries):
    if before_entries == after_entries:
        return
    conn.execute("DELETE FROM undo_log WHERE undone = 1")
    conn.execute(
        "INSERT INTO undo_log (action_type, before_state, after_state) VALUES (?, ?, ?)",
        (action_type, json.dumps(before_entries), json.dumps(after_entries)),
    )
    conn.execute("""
        DELETE FROM undo_log WHERE id NOT IN (
            SELECT id FROM undo_log ORDER BY id DESC LIMIT ?
        )
    """, (UNDO_STACK_LIMIT,))


def _restore_entries(conn, target_state, all_entry_ids):
    target_by_id = {e["id"]: e for e in target_state}
    target_ids = set(target_by_id.keys())
    all_ids = set(all_entry_ids)

    # Delete entries that shouldn't exist in target state (CASCADE cleans splits)
    to_delete = all_ids - target_ids
    for eid in to_delete:
        conn.execute("DELETE FROM entries WHERE id = ?", (eid,))

    # Insert or update entries to match target state
    for eid, edata in target_by_id.items():
        existing = conn.execute("SELECT id FROM entries WHERE id = ?", (eid,)).fetchone()
        if existing:
            sets = ", ".join(f"{col} = ?" for col in ENTRY_COLUMNS if col != "id")
            vals = [edata.get(col) for col in ENTRY_COLUMNS if col != "id"]
            vals.append(eid)
            conn.execute(f"UPDATE entries SET {sets} WHERE id = ?", vals)
        else:
            cols = ", ".join(ENTRY_COLUMNS)
            placeholders = ", ".join("?" * len(ENTRY_COLUMNS))
            vals = [edata.get(col) for col in ENTRY_COLUMNS]
            conn.execute(f"INSERT INTO entries ({cols}) VALUES ({placeholders})", vals)

        # Restore splits
        conn.execute("DELETE FROM entry_imputations WHERE entry_id = ?", (eid,))
        for s in edata.get("_splits", []):
            conn.execute(
                "INSERT INTO entry_imputations (id, entry_id, account_id, duration, position) VALUES (?, ?, ?, ?, ?)",
                (s["id"], eid, s["account_id"], s["duration"], s["position"]),
            )

        # Restore ADO items (defaults to [] for old snapshots)
        conn.execute("DELETE FROM entry_ado_items WHERE entry_id = ?", (eid,))
        for a in edata.get("_ado_items", []):
            conn.execute(
                "INSERT INTO entry_ado_items (id, entry_id, link_type_id, value, position) VALUES (?, ?, ?, ?, ?)",
                (a["id"], eid, a["link_type_id"], a["value"], a["position"]),
            )


def undo_status(db_path):
    with get_connection(db_path) as conn:
        can_undo = conn.execute("SELECT COUNT(*) FROM undo_log WHERE undone = 0").fetchone()[0] > 0
        can_redo = conn.execute("SELECT COUNT(*) FROM undo_log WHERE undone = 1").fetchone()[0] > 0
        return {"can_undo": can_undo, "can_redo": can_redo}


def perform_undo(db_path):
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM undo_log WHERE undone = 0 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not row:
            return {"ok": False, "reason": "nothing_to_undo"}

        record = dict(row)
        before = json.loads(record["before_state"])
        after = json.loads(record["after_state"])

        all_ids = set()
        for e in before:
            all_ids.add(e["id"])
        for e in after:
            all_ids.add(e["id"])

        _restore_entries(conn, before, all_ids)
        conn.execute("UPDATE undo_log SET undone = 1 WHERE id = ?", (record["id"],))
        conn.commit()
        return {"ok": True, "action_type": record["action_type"]}


def perform_redo(db_path):
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM undo_log WHERE undone = 1 ORDER BY id ASC LIMIT 1"
        ).fetchone()
        if not row:
            return {"ok": False, "reason": "nothing_to_redo"}

        record = dict(row)
        before = json.loads(record["before_state"])
        after = json.loads(record["after_state"])

        all_ids = set()
        for e in before:
            all_ids.add(e["id"])
        for e in after:
            all_ids.add(e["id"])

        _restore_entries(conn, after, all_ids)
        conn.execute("UPDATE undo_log SET undone = 0 WHERE id = ?", (record["id"],))
        conn.commit()
        return {"ok": True, "action_type": record["action_type"]}


# --- Imputation accounts ---

def list_accounts(db_path, include_inactive=False):
    with get_connection(db_path) as conn:
        if include_inactive:
            rows = conn.execute(
                "SELECT * FROM imputation_accounts ORDER BY number"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM imputation_accounts WHERE active = 1 ORDER BY number"
            ).fetchall()
        return [dict(r) for r in rows]


def create_account(db_path, number, description="", project="", open_date=None, close_date=None):
    with get_connection(db_path) as conn:
        cur = conn.execute(
            "INSERT INTO imputation_accounts (number, description, project, open_date, close_date) VALUES (?, ?, ?, ?, ?)",
            (number, description, project, open_date, close_date),
        )
        account_id = cur.lastrowid
        conn.commit()
        row = conn.execute(
            "SELECT * FROM imputation_accounts WHERE id = ?", (account_id,)
        ).fetchone()
        return dict(row)


def update_account(db_path, account_id, **fields):
    with get_connection(db_path) as conn:
        allowed = {"number", "description", "project", "open_date", "close_date", "active"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return None
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [account_id]
        conn.execute(
            f"UPDATE imputation_accounts SET {set_clause} WHERE id = ?", values
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM imputation_accounts WHERE id = ?", (account_id,)
        ).fetchone()
        return dict(row) if row else None


def delete_account(db_path, account_id):
    with get_connection(db_path) as conn:
        conn.execute(
            "UPDATE imputation_accounts SET active = 0 WHERE id = ?", (account_id,)
        )
        conn.commit()


# --- Entries ---

_ENTRY_QUERY = "SELECT * FROM entries"


def _attach_splits(conn, entries):
    """Attach splits with account details to a list of entry dicts."""
    if not entries:
        return entries
    entry_ids = [e["id"] for e in entries]
    placeholders = ",".join("?" * len(entry_ids))
    rows = conn.execute(f"""
        SELECT ei.*, a.number AS account_number,
               a.description AS account_description,
               a.project AS account_project,
               a.open_date AS account_open_date,
               a.close_date AS account_close_date
        FROM entry_imputations ei
        LEFT JOIN imputation_accounts a ON ei.account_id = a.id
        WHERE ei.entry_id IN ({placeholders})
        ORDER BY ei.entry_id, ei.position
    """, entry_ids).fetchall()
    splits_by_entry = {}
    for r in rows:
        d = dict(r)
        eid = d["entry_id"]
        if eid not in splits_by_entry:
            splits_by_entry[eid] = []
        splits_by_entry[eid].append(d)
    for e in entries:
        e["splits"] = splits_by_entry.get(e["id"], [])
    return entries


def _attach_ado_items(conn, entries):
    """Attach ADO items with link type details to a list of entry dicts."""
    if not entries:
        return entries
    entry_ids = [e["id"] for e in entries]
    placeholders = ",".join("?" * len(entry_ids))
    rows = conn.execute(f"""
        SELECT ai.*, lt.title AS link_type_title,
               lt.url_template AS link_type_url_template
        FROM entry_ado_items ai
        LEFT JOIN ado_link_types lt ON ai.link_type_id = lt.id
        WHERE ai.entry_id IN ({placeholders})
        ORDER BY ai.entry_id, ai.position
    """, entry_ids).fetchall()
    items_by_entry = {}
    for r in rows:
        d = dict(r)
        eid = d["entry_id"]
        if eid not in items_by_entry:
            items_by_entry[eid] = []
        items_by_entry[eid].append(d)
    for e in entries:
        e["ado_items"] = items_by_entry.get(e["id"], [])
    return entries


def list_entries(db_path, date_from=None, date_to=None):
    with get_connection(db_path) as conn:
        if date_from and date_to:
            rows = conn.execute(
                _ENTRY_QUERY + " WHERE date >= ? AND date <= ? ORDER BY date DESC, COALESCE(sort_order, id), id",
                (date_from, date_to),
            ).fetchall()
        else:
            rows = conn.execute(
                _ENTRY_QUERY + " ORDER BY date DESC, COALESCE(sort_order, id), id"
            ).fetchall()
        entries = [dict(r) for r in rows]
        _attach_splits(conn, entries)
        _attach_ado_items(conn, entries)
        return entries


def create_entry(db_path, data):
    with get_connection(db_path) as conn:
        splits_data = data.get("splits")
        ado_items_data = data.get("ado_items")
        cur = conn.execute(
            """INSERT INTO entries
               (date, duration, description, notes, ado_workitem, ado_pr)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                data["date"],
                data["duration"],
                data.get("description", ""),
                data.get("notes", ""),
                data.get("ado_workitem", ""),
                data.get("ado_pr", ""),
            ),
        )
        entry_id = cur.lastrowid
        if splits_data:
            for i, s in enumerate(splits_data):
                conn.execute(
                    "INSERT INTO entry_imputations (entry_id, account_id, duration, position) VALUES (?, ?, ?, ?)",
                    (entry_id, s["account_id"], s["duration"], i),
                )
        if ado_items_data:
            for i, a in enumerate(ado_items_data):
                conn.execute(
                    "INSERT INTO entry_ado_items (entry_id, link_type_id, value, position) VALUES (?, ?, ?, ?)",
                    (entry_id, a["link_type_id"], a["value"], i),
                )
        after = _snapshot_entries(conn, [entry_id])
        _record_undo(conn, "create_entry", [], after)
        conn.commit()
        row = conn.execute(_ENTRY_QUERY + " WHERE id = ?", (entry_id,)).fetchone()
        entry = dict(row)
        _attach_splits(conn, [entry])
        _attach_ado_items(conn, [entry])
        return entry


def update_entry(db_path, entry_id, data):
    with get_connection(db_path) as conn:
        splits_data = data.pop("splits", None)
        ado_items_data = data.pop("ado_items", None)
        allowed = {
            "date", "duration", "description", "notes", "group_id",
        }
        updates = {k: v for k, v in data.items() if k in allowed}

        row = conn.execute("SELECT group_id FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            return None
        group_id = row["group_id"]
        shared_updates = {k: v for k, v in updates.items() if k in SHARED_FIELDS}

        # Determine affected entries
        affected_ids = {entry_id}
        if group_id and (shared_updates or ado_items_data is not None):
            group_rows = conn.execute("SELECT id FROM entries WHERE group_id = ?", (group_id,)).fetchall()
            affected_ids = {r["id"] for r in group_rows}

        if not updates and splits_data is None and ado_items_data is None:
            return None

        # Snapshot BEFORE
        before = _snapshot_entries(conn, list(affected_ids))

        # Update scalar fields on the target entry
        if updates:
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            values = list(updates.values()) + [entry_id]
            conn.execute(f"UPDATE entries SET {set_clause} WHERE id = ?", values)

        # Propagate shared fields to group members
        if group_id and shared_updates:
            set_clause2 = ", ".join(f"{k} = ?" for k in shared_updates)
            values2 = list(shared_updates.values()) + [group_id]
            conn.execute(f"UPDATE entries SET {set_clause2} WHERE group_id = ?", values2)

        # Update splits (per-entry only, not propagated to group)
        if splits_data is not None:
            conn.execute("DELETE FROM entry_imputations WHERE entry_id = ?", (entry_id,))
            for i, s in enumerate(splits_data):
                conn.execute(
                    "INSERT INTO entry_imputations (entry_id, account_id, duration, position) VALUES (?, ?, ?, ?)",
                    (entry_id, s["account_id"], s["duration"], i),
                )

        # Update ADO items (propagated to all group members)
        if ado_items_data is not None:
            for aid in affected_ids:
                conn.execute("DELETE FROM entry_ado_items WHERE entry_id = ?", (aid,))
                for i, a in enumerate(ado_items_data):
                    conn.execute(
                        "INSERT INTO entry_ado_items (entry_id, link_type_id, value, position) VALUES (?, ?, ?, ?)",
                        (aid, a["link_type_id"], a["value"], i),
                    )

        # Snapshot AFTER
        after = _snapshot_entries(conn, list(affected_ids))
        _record_undo(conn, "update_entry", before, after)
        conn.commit()

        row = conn.execute(_ENTRY_QUERY + " WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            return None
        entry = dict(row)
        _attach_splits(conn, [entry])
        _attach_ado_items(conn, [entry])
        return entry


def duplicate_entry(db_path, entry_id, target_date, link=False):
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            return None
        src = dict(row)

        # Before snapshot: source entry if link will modify it
        before_ids = []
        if link and not src["group_id"]:
            before_ids = [entry_id]
        before = _snapshot_entries(conn, before_ids)

        group_id = None
        if link:
            if src["group_id"]:
                group_id = src["group_id"]
            else:
                group_id = str(uuid.uuid4())
                conn.execute("UPDATE entries SET group_id = ? WHERE id = ?", (group_id, entry_id))
        cur = conn.execute(
            """INSERT INTO entries
               (date, duration, description, notes, ado_workitem, ado_pr, group_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                target_date,
                src["duration"],
                src["description"],
                src["notes"],
                src["ado_workitem"],
                src["ado_pr"],
                group_id,
            ),
        )
        new_id = cur.lastrowid

        # Copy splits from source
        src_splits = conn.execute(
            "SELECT * FROM entry_imputations WHERE entry_id = ? ORDER BY position",
            (entry_id,),
        ).fetchall()
        for s in src_splits:
            conn.execute(
                "INSERT INTO entry_imputations (entry_id, account_id, duration, position) VALUES (?, ?, ?, ?)",
                (new_id, s["account_id"], s["duration"], s["position"]),
            )

        # Copy ADO items from source
        src_ado_items = conn.execute(
            "SELECT * FROM entry_ado_items WHERE entry_id = ? ORDER BY position",
            (entry_id,),
        ).fetchall()
        for a in src_ado_items:
            conn.execute(
                "INSERT INTO entry_ado_items (entry_id, link_type_id, value, position) VALUES (?, ?, ?, ?)",
                (new_id, a["link_type_id"], a["value"], a["position"]),
            )

        # After snapshot: new entry + source if modified
        after_ids = [new_id]
        if link and not src["group_id"]:
            after_ids.append(entry_id)
        after = _snapshot_entries(conn, after_ids)

        action_type = "duplicate_link_entry" if link else "duplicate_entry"
        _record_undo(conn, action_type, before, after)
        conn.commit()

        new_row = conn.execute(_ENTRY_QUERY + " WHERE id = ?", (new_id,)).fetchone()
        entry = dict(new_row)
        _attach_splits(conn, [entry])
        _attach_ado_items(conn, [entry])
        return entry


def delete_entry(db_path, entry_id):
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            return

        entry = dict(row)
        group_id = entry.get("group_id")

        # Determine all affected entries
        affected_ids = [entry_id]
        cleanup_target_id = None
        if group_id:
            remaining = conn.execute(
                "SELECT id FROM entries WHERE group_id = ? AND id != ?",
                (group_id, entry_id),
            ).fetchall()
            if len(remaining) == 1:
                cleanup_target_id = remaining[0]["id"]
                affected_ids.append(cleanup_target_id)

        # Snapshot BEFORE
        before = _snapshot_entries(conn, affected_ids)

        # Delete
        conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        if group_id:
            _cleanup_group(conn, group_id)

        # Snapshot AFTER (only cleanup target if it exists)
        after_ids = [cleanup_target_id] if cleanup_target_id else []
        after = _snapshot_entries(conn, after_ids)

        _record_undo(conn, "delete_entry", before, after)
        conn.commit()


def reorder_entry(db_path, entry_id, before_id):
    """Move entry to be positioned before before_id within its day, or to the end if before_id is None."""
    if before_id is not None and before_id == entry_id:
        return {"ok": True}
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT date FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            return None
        date = row["date"]

        rows = conn.execute(
            "SELECT id FROM entries WHERE date = ? ORDER BY COALESCE(sort_order, id), id",
            (date,),
        ).fetchall()
        ids = [r["id"] for r in rows]

        before = _snapshot_entries(conn, ids)

        ids = [i for i in ids if i != entry_id]
        if before_id is not None and before_id in ids:
            idx = ids.index(before_id)
            ids.insert(idx, entry_id)
        else:
            ids.append(entry_id)

        for i, eid in enumerate(ids):
            conn.execute("UPDATE entries SET sort_order = ? WHERE id = ?", (i, eid))

        after = _snapshot_entries(conn, ids)
        _record_undo(conn, "reorder_entry", before, after)
        conn.commit()
        return {"ok": True}


def _cleanup_group(conn, group_id):
    """If only one entry remains in a group, clear its group_id."""
    remaining = conn.execute(
        "SELECT id FROM entries WHERE group_id = ?", (group_id,)
    ).fetchall()
    if len(remaining) == 1:
        conn.execute("UPDATE entries SET group_id = NULL WHERE id = ?", (remaining[0]["id"],))


# --- Grouping ---

SHARED_FIELDS = {"description"}


def get_group_entries(db_path, group_id):
    with get_connection(db_path) as conn:
        rows = conn.execute(
            _ENTRY_QUERY + " WHERE group_id = ? ORDER BY date DESC, id",
            (group_id,),
        ).fetchall()
        entries = [dict(r) for r in rows]
        _attach_splits(conn, entries)
        _attach_ado_items(conn, entries)
        return entries


def update_group_shared(db_path, group_id, data):
    """Propagate shared field changes to all entries in a group."""
    with get_connection(db_path) as conn:
        updates = {k: v for k, v in data.items() if k in SHARED_FIELDS}
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [group_id]
        conn.execute(f"UPDATE entries SET {set_clause} WHERE group_id = ?", values)
        conn.commit()


def ungroup_entry(db_path, entry_id):
    """Remove an entry from its group. If only one remains, dissolve the group."""
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT group_id FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row or not row["group_id"]:
            return
        group_id = row["group_id"]

        # Determine affected entries
        affected_ids = [entry_id]
        remaining = conn.execute(
            "SELECT id FROM entries WHERE group_id = ? AND id != ?",
            (group_id, entry_id),
        ).fetchall()
        if len(remaining) == 1:
            affected_ids.append(remaining[0]["id"])

        # Snapshot BEFORE
        before = _snapshot_entries(conn, affected_ids)

        conn.execute("UPDATE entries SET group_id = NULL WHERE id = ?", (entry_id,))
        _cleanup_group(conn, group_id)

        # Snapshot AFTER
        after = _snapshot_entries(conn, affected_ids)
        _record_undo(conn, "ungroup_entry", before, after)
        conn.commit()


def link_entries(db_path, entry_id, target_entry_id, resolution=None):
    """Link two entries into a group, applying conflict resolution for shared fields."""
    with get_connection(db_path) as conn:
        src = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        tgt = conn.execute("SELECT * FROM entries WHERE id = ?", (target_entry_id,)).fetchone()
        if not src or not tgt:
            return None

        src = dict(src)
        tgt = dict(tgt)

        # Determine the group_id to use
        if tgt["group_id"]:
            group_id = tgt["group_id"]
        elif src["group_id"]:
            group_id = src["group_id"]
        else:
            group_id = str(uuid.uuid4())

        # Collect ALL affected entry IDs
        affected_ids = {entry_id, target_entry_id}
        if tgt["group_id"]:
            rows = conn.execute("SELECT id FROM entries WHERE group_id = ?", (tgt["group_id"],)).fetchall()
            for r in rows:
                affected_ids.add(r["id"])
        if src["group_id"]:
            rows = conn.execute("SELECT id FROM entries WHERE group_id = ?", (src["group_id"],)).fetchall()
            for r in rows:
                affected_ids.add(r["id"])

        # Snapshot BEFORE
        before = _snapshot_entries(conn, list(affected_ids))

        # Apply resolution to determine shared field values
        resolved = {}
        if resolution:
            for field, value in resolution.items():
                if field in SHARED_FIELDS:
                    resolved[field] = value
        else:
            for field in SHARED_FIELDS:
                resolved[field] = tgt[field]

        # Set group_id on source entry
        conn.execute("UPDATE entries SET group_id = ? WHERE id = ?", (group_id, entry_id))

        # If target didn't have a group_id, set it now
        if not tgt["group_id"]:
            conn.execute("UPDATE entries SET group_id = ? WHERE id = ?", (group_id, target_entry_id))

        # Apply resolved shared fields to ALL entries in the group
        if resolved:
            set_clause = ", ".join(f"{k} = ?" for k in resolved)
            values = list(resolved.values()) + [group_id]
            conn.execute(f"UPDATE entries SET {set_clause} WHERE group_id = ?", values)

        # Merge ADO items across all group members (DISTINCT on link_type_id+value)
        all_group_ids = list(affected_ids)
        ph = ",".join("?" * len(all_group_ids))
        all_ado = conn.execute(f"""
            SELECT DISTINCT link_type_id, value FROM entry_ado_items
            WHERE entry_id IN ({ph})
        """, all_group_ids).fetchall()
        merged_items = [dict(r) for r in all_ado]
        # Apply merged set to every group member
        for aid in all_group_ids:
            conn.execute("DELETE FROM entry_ado_items WHERE entry_id = ?", (aid,))
            for i, a in enumerate(merged_items):
                conn.execute(
                    "INSERT INTO entry_ado_items (entry_id, link_type_id, value, position) VALUES (?, ?, ?, ?)",
                    (aid, a["link_type_id"], a["value"], i),
                )

        # Snapshot AFTER
        after = _snapshot_entries(conn, list(affected_ids))
        _record_undo(conn, "link_entries", before, after)
        conn.commit()

        # Return the updated entry
        row = conn.execute(_ENTRY_QUERY + " WHERE id = ?", (entry_id,)).fetchone()
        entry = dict(row)
        _attach_splits(conn, [entry])
        _attach_ado_items(conn, [entry])
        return entry


def suggest_groups(db_path, entry_id):
    """Return entries/groups ranked by similarity to the given entry."""
    with get_connection(db_path) as conn:
        src = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not src:
            return []
        src = dict(src)

        # Get all other entries (exclude same entry and entries already in same group)
        params = [entry_id]
        where_extra = ""
        if src["group_id"]:
            where_extra = " AND (group_id IS NULL OR group_id != ?)"
            params.append(src["group_id"])

        rows = conn.execute(
            _ENTRY_QUERY + f" WHERE id != ?{where_extra} ORDER BY date DESC, id",
            params,
        ).fetchall()
        candidates = [dict(r) for r in rows]
        _attach_splits(conn, candidates)
        _attach_ado_items(conn, candidates)

        # Also attach ADO items to source
        _attach_ado_items(conn, [src])
        src_ado_set = set()
        for a in src.get("ado_items", []):
            src_ado_set.add((a["link_type_id"], a["value"]))

    # Score by similarity
    def score(entry):
        s = 0
        # +10 per shared ADO item (link_type_id + value match)
        for a in entry.get("ado_items", []):
            if (a["link_type_id"], a["value"]) in src_ado_set:
                s += 10
        if src["description"] and entry["description"] and (
            src["description"].lower() in entry["description"].lower()
            or entry["description"].lower() in src["description"].lower()
        ):
            s += 3
        if entry["group_id"]:
            s += 1
        return s

    candidates.sort(key=lambda e: (-score(e), e["date"]))
    return candidates


# --- ADO Link Types ---

def list_link_types(db_path):
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM ado_link_types ORDER BY position, id"
        ).fetchall()
        return [dict(r) for r in rows]


def create_link_type(db_path, title, url_template=""):
    with get_connection(db_path) as conn:
        max_pos = conn.execute("SELECT COALESCE(MAX(position), -1) FROM ado_link_types").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO ado_link_types (title, url_template, position) VALUES (?, ?, ?)",
            (title, url_template, max_pos + 1),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM ado_link_types WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


def update_link_type(db_path, link_type_id, **fields):
    with get_connection(db_path) as conn:
        allowed = {"title", "url_template", "position"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return None
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [link_type_id]
        conn.execute(f"UPDATE ado_link_types SET {set_clause} WHERE id = ?", values)
        conn.commit()
        row = conn.execute("SELECT * FROM ado_link_types WHERE id = ?", (link_type_id,)).fetchone()
        return dict(row) if row else None


def delete_link_type(db_path, link_type_id):
    with get_connection(db_path) as conn:
        conn.execute("DELETE FROM ado_link_types WHERE id = ?", (link_type_id,))
        conn.commit()
