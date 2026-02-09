import sqlite3
import os
import uuid
import json


def get_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path):
    conn = get_connection(db_path)
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
    conn.commit()
    conn.close()


# --- Undo/Redo infrastructure ---

ENTRY_COLUMNS = [
    "id", "date", "duration", "description", "notes",
    "ado_workitem", "ado_pr", "imputation_account_id",
    "imputation_duration", "group_id",
]

UNDO_STACK_LIMIT = 50


def _snapshot_entries(conn, entry_ids):
    if not entry_ids:
        return []
    placeholders = ",".join("?" * len(entry_ids))
    rows = conn.execute(
        f"SELECT * FROM entries WHERE id IN ({placeholders})", list(entry_ids)
    ).fetchall()
    return [dict(r) for r in rows]


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

    # Delete entries that shouldn't exist in target state
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


def perform_undo(db_path):
    conn = get_connection(db_path)
    row = conn.execute(
        "SELECT * FROM undo_log WHERE undone = 0 ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not row:
        conn.close()
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
    conn.close()
    return {"ok": True, "action_type": record["action_type"]}


def perform_redo(db_path):
    conn = get_connection(db_path)
    row = conn.execute(
        "SELECT * FROM undo_log WHERE undone = 1 ORDER BY id ASC LIMIT 1"
    ).fetchone()
    if not row:
        conn.close()
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
    conn.close()
    return {"ok": True, "action_type": record["action_type"]}


# --- Imputation accounts ---

def list_accounts(db_path, include_inactive=False):
    conn = get_connection(db_path)
    if include_inactive:
        rows = conn.execute(
            "SELECT * FROM imputation_accounts ORDER BY number"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM imputation_accounts WHERE active = 1 ORDER BY number"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_account(db_path, number, description="", project="", open_date=None, close_date=None):
    conn = get_connection(db_path)
    cur = conn.execute(
        "INSERT INTO imputation_accounts (number, description, project, open_date, close_date) VALUES (?, ?, ?, ?, ?)",
        (number, description, project, open_date, close_date),
    )
    account_id = cur.lastrowid
    conn.commit()
    row = conn.execute(
        "SELECT * FROM imputation_accounts WHERE id = ?", (account_id,)
    ).fetchone()
    conn.close()
    return dict(row)


def update_account(db_path, account_id, **fields):
    conn = get_connection(db_path)
    allowed = {"number", "description", "project", "open_date", "close_date", "active"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        conn.close()
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
    conn.close()
    return dict(row) if row else None


def delete_account(db_path, account_id):
    conn = get_connection(db_path)
    conn.execute(
        "UPDATE imputation_accounts SET active = 0 WHERE id = ?", (account_id,)
    )
    conn.commit()
    conn.close()


# --- Entries ---

_ENTRY_JOIN_QUERY = """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
   FROM entries e
   LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id"""


def list_entries(db_path, date_from=None, date_to=None):
    conn = get_connection(db_path)
    if date_from and date_to:
        rows = conn.execute(
            _ENTRY_JOIN_QUERY + " WHERE e.date >= ? AND e.date <= ? ORDER BY e.date DESC, e.id",
            (date_from, date_to),
        ).fetchall()
    else:
        rows = conn.execute(
            _ENTRY_JOIN_QUERY + " ORDER BY e.date DESC, e.id"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_entry(db_path, data):
    conn = get_connection(db_path)
    cur = conn.execute(
        """INSERT INTO entries
           (date, duration, description, notes, ado_workitem, ado_pr,
            imputation_account_id, imputation_duration)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data["date"],
            data["duration"],
            data.get("description", ""),
            data.get("notes", ""),
            data.get("ado_workitem", ""),
            data.get("ado_pr", ""),
            data.get("imputation_account_id"),
            data.get("imputation_duration"),
        ),
    )
    entry_id = cur.lastrowid
    after = _snapshot_entries(conn, [entry_id])
    _record_undo(conn, "create_entry", [], after)
    conn.commit()
    row = conn.execute(_ENTRY_JOIN_QUERY + " WHERE e.id = ?", (entry_id,)).fetchone()
    conn.close()
    return dict(row)


def update_entry(db_path, entry_id, data):
    conn = get_connection(db_path)
    allowed = {
        "date", "duration", "description", "notes",
        "ado_workitem", "ado_pr", "imputation_account_id", "imputation_duration",
        "group_id",
    }
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        conn.close()
        return None

    # Determine affected entries (for undo snapshot)
    row = conn.execute("SELECT group_id FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        conn.close()
        return None
    group_id = row["group_id"]
    shared_updates = {k: v for k, v in updates.items() if k in SHARED_FIELDS}

    affected_ids = {entry_id}
    if group_id and shared_updates:
        group_rows = conn.execute("SELECT id FROM entries WHERE group_id = ?", (group_id,)).fetchall()
        affected_ids = {r["id"] for r in group_rows}

    # Snapshot BEFORE
    before = _snapshot_entries(conn, list(affected_ids))

    # Update the target entry
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [entry_id]
    conn.execute(f"UPDATE entries SET {set_clause} WHERE id = ?", values)

    # Propagate shared fields to group members
    if group_id and shared_updates:
        set_clause2 = ", ".join(f"{k} = ?" for k in shared_updates)
        values2 = list(shared_updates.values()) + [group_id]
        conn.execute(f"UPDATE entries SET {set_clause2} WHERE group_id = ?", values2)

    # Snapshot AFTER
    after = _snapshot_entries(conn, list(affected_ids))
    _record_undo(conn, "update_entry", before, after)
    conn.commit()

    row = conn.execute(_ENTRY_JOIN_QUERY + " WHERE e.id = ?", (entry_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def duplicate_entry(db_path, entry_id, target_date, link=False):
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        conn.close()
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
           (date, duration, description, notes, ado_workitem, ado_pr,
            imputation_account_id, imputation_duration, group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            target_date,
            src["duration"],
            src["description"],
            src["notes"],
            src["ado_workitem"],
            src["ado_pr"],
            src["imputation_account_id"],
            src["imputation_duration"],
            group_id,
        ),
    )
    new_id = cur.lastrowid

    # After snapshot: new entry + source if modified
    after_ids = [new_id]
    if link and not src["group_id"]:
        after_ids.append(entry_id)
    after = _snapshot_entries(conn, after_ids)

    action_type = "duplicate_link_entry" if link else "duplicate_entry"
    _record_undo(conn, action_type, before, after)
    conn.commit()

    new_row = conn.execute(_ENTRY_JOIN_QUERY + " WHERE e.id = ?", (new_id,)).fetchone()
    conn.close()
    return dict(new_row)


def delete_entry(db_path, entry_id):
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        conn.close()
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
    conn.close()


def _cleanup_group(conn, group_id):
    """If only one entry remains in a group, clear its group_id."""
    remaining = conn.execute(
        "SELECT id FROM entries WHERE group_id = ?", (group_id,)
    ).fetchall()
    if len(remaining) == 1:
        conn.execute("UPDATE entries SET group_id = NULL WHERE id = ?", (remaining[0]["id"],))


# --- Grouping ---

SHARED_FIELDS = {"description", "ado_workitem", "ado_pr", "imputation_account_id", "imputation_duration"}


def get_group_entries(db_path, group_id):
    conn = get_connection(db_path)
    rows = conn.execute(
        _ENTRY_JOIN_QUERY + " WHERE e.group_id = ? ORDER BY e.date DESC, e.id",
        (group_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_group_shared(db_path, group_id, data):
    """Propagate shared field changes to all entries in a group."""
    conn = get_connection(db_path)
    updates = {k: v for k, v in data.items() if k in SHARED_FIELDS}
    if not updates:
        conn.close()
        return
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [group_id]
    conn.execute(f"UPDATE entries SET {set_clause} WHERE group_id = ?", values)
    conn.commit()
    conn.close()


def ungroup_entry(db_path, entry_id):
    """Remove an entry from its group. If only one remains, dissolve the group."""
    conn = get_connection(db_path)
    row = conn.execute("SELECT group_id FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not row or not row["group_id"]:
        conn.close()
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
    conn.close()


def link_entries(db_path, entry_id, target_entry_id, resolution=None):
    """Link two entries into a group, applying conflict resolution for shared fields."""
    conn = get_connection(db_path)
    src = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    tgt = conn.execute("SELECT * FROM entries WHERE id = ?", (target_entry_id,)).fetchone()
    if not src or not tgt:
        conn.close()
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

    # Snapshot AFTER
    after = _snapshot_entries(conn, list(affected_ids))
    _record_undo(conn, "link_entries", before, after)
    conn.commit()

    # Return the updated entry
    row = conn.execute(_ENTRY_JOIN_QUERY + " WHERE e.id = ?", (entry_id,)).fetchone()
    conn.close()
    return dict(row)


def suggest_groups(db_path, entry_id):
    """Return entries/groups ranked by similarity to the given entry."""
    conn = get_connection(db_path)
    src = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not src:
        conn.close()
        return []
    src = dict(src)

    # Get all other entries (exclude same entry and entries already in same group)
    params = [entry_id]
    where_extra = ""
    if src["group_id"]:
        where_extra = " AND (e.group_id IS NULL OR e.group_id != ?)"
        params.append(src["group_id"])

    rows = conn.execute(
        _ENTRY_JOIN_QUERY + f" WHERE e.id != ?{where_extra} ORDER BY e.date DESC, e.id",
        params,
    ).fetchall()
    conn.close()

    candidates = [dict(r) for r in rows]

    # Score by similarity
    def score(entry):
        s = 0
        if src["ado_workitem"] and entry["ado_workitem"] == src["ado_workitem"]:
            s += 10
        if src["ado_pr"] and entry["ado_pr"] == src["ado_pr"]:
            s += 5
        if src["description"] and entry["description"] and (
            src["description"].lower() in entry["description"].lower()
            or entry["description"].lower() in src["description"].lower()
        ):
            s += 3
        if entry["imputation_account_id"] and entry["imputation_account_id"] == src["imputation_account_id"]:
            s += 2
        if entry["group_id"]:
            s += 1
        return s

    candidates.sort(key=lambda e: (-score(e), e["date"]))
    return candidates
