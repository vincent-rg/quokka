import sqlite3
import os


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
            FOREIGN KEY (imputation_account_id) REFERENCES imputation_accounts(id)
        );

        CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
    """)
    # Migration: add project column if missing
    cols = [r[1] for r in conn.execute("PRAGMA table_info(imputation_accounts)").fetchall()]
    if "project" not in cols:
        conn.execute("ALTER TABLE imputation_accounts ADD COLUMN project TEXT NOT NULL DEFAULT ''")
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


def delete_entry(db_path, entry_id):
    conn = get_connection(db_path)
    conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
    conn.commit()
    conn.close()
