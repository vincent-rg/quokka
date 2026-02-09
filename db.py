import sqlite3
import os
import uuid


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
    """)
    # Migration: add project column if missing
    cols = [r[1] for r in conn.execute("PRAGMA table_info(imputation_accounts)").fetchall()]
    if "project" not in cols:
        conn.execute("ALTER TABLE imputation_accounts ADD COLUMN project TEXT NOT NULL DEFAULT ''")
    # Migration: add group_id column if missing
    entry_cols = [r[1] for r in conn.execute("PRAGMA table_info(entries)").fetchall()]
    if "group_id" not in entry_cols:
        conn.execute("ALTER TABLE entries ADD COLUMN group_id TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_group_id ON entries(group_id)")
    conn.commit()
    conn.close()


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


def create_account(db_path, number, description="", project=""):
    conn = get_connection(db_path)
    cur = conn.execute(
        "INSERT INTO imputation_accounts (number, description, project) VALUES (?, ?, ?)",
        (number, description, project),
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
    allowed = {"number", "description", "project", "active"}
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

def list_entries(db_path, date_from=None, date_to=None):
    conn = get_connection(db_path)
    if date_from and date_to:
        rows = conn.execute(
            """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
               FROM entries e
               LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
               WHERE e.date >= ? AND e.date <= ?
               ORDER BY e.date DESC, e.id""",
            (date_from, date_to),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
               FROM entries e
               LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
               ORDER BY e.date DESC, e.id"""
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
    conn.commit()
    row = conn.execute(
        """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
           FROM entries e
           LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
           WHERE e.id = ?""",
        (entry_id,),
    ).fetchone()
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
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [entry_id]
    conn.execute(f"UPDATE entries SET {set_clause} WHERE id = ?", values)
    conn.commit()
    row = conn.execute(
        """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
           FROM entries e
           LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
           WHERE e.id = ?""",
        (entry_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def duplicate_entry(db_path, entry_id, target_date, link=False):
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        conn.close()
        return None
    src = dict(row)
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
    conn.commit()
    new_row = conn.execute(
        """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
           FROM entries e
           LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
           WHERE e.id = ?""",
        (new_id,),
    ).fetchone()
    conn.close()
    return dict(new_row)


def delete_entry(db_path, entry_id):
    conn = get_connection(db_path)
    # Check if entry is in a group; if so, clean up group after deletion
    row = conn.execute("SELECT group_id FROM entries WHERE id = ?", (entry_id,)).fetchone()
    conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
    if row and row["group_id"]:
        _cleanup_group(conn, row["group_id"])
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
        """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
           FROM entries e
           LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
           WHERE e.group_id = ?
           ORDER BY e.date DESC, e.id""",
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
    conn.execute("UPDATE entries SET group_id = NULL WHERE id = ?", (entry_id,))
    _cleanup_group(conn, group_id)
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

    # Apply resolution to determine shared field values
    resolved = {}
    if resolution:
        for field, value in resolution.items():
            if field in SHARED_FIELDS:
                resolved[field] = value
    else:
        # Default: use target's values for shared fields
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

    conn.commit()

    # Return the updated entry
    row = conn.execute(
        """SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
           FROM entries e
           LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
           WHERE e.id = ?""",
        (entry_id,),
    ).fetchone()
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
        f"""SELECT e.*, a.number AS account_number, a.description AS account_description, a.project AS account_project
            FROM entries e
            LEFT JOIN imputation_accounts a ON e.imputation_account_id = a.id
            WHERE e.id != ?{where_extra}
            ORDER BY e.date DESC, e.id""",
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
            s += 1  # Slight preference for already-grouped entries
        return s

    candidates.sort(key=lambda e: (-score(e), e["date"]))
    return candidates
