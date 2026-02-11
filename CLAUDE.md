# Quokka - Work Time Tracker

Personal app to track daily work entries with imputation (time allocation to accounts).

## Tech Stack

- **Backend**: Python 3.9.13 stdlib only (`http.server` + `sqlite3`), no third-party deps
- **Frontend**: Vanilla HTML/CSS/JS, no frameworks, no build step
- **Database**: SQLite, single file `quokka.db`
- **Server**: Binds to localhost only, no auth

## File Map

| File | Purpose |
|---|---|
| `server.py` | HTTP server, routing, request handlers, daily DB backup |
| `db.py` | All SQLite operations: schema, migrations, CRUD, undo/redo, grouping |
| `static/app.js` | Entire frontend in one IIFE (~1660 lines): state, rendering, inline editing, popups, views |
| `static/style.css` | All styles (~650 lines) |
| `static/index.html` | Minimal shell: header/toolbar, 3 view containers, modals |
| `static/quokka.svg` | Logo |
| `config.json` | Port and DB path (gitignored, `config.json.default` is tracked) |
| `specs` | Original requirements doc (gitignored) |
| `start.ps1` / `stop.ps1` | PowerShell scripts to start/stop the server |

## Architecture

### Three Views (switched via `<select>` in toolbar)

1. **Entries** (default) - Day-grouped tables of work entries, inline-editable spreadsheet-style
2. **Accounts** - CRUD table for imputation accounts (number, description, project, open/close dates)
3. **Imputations** - Monthly report: time aggregated by date and account, with month navigation

### Data Model

- **entries**: date, duration (minutes, 15min increments), description, notes, ado_workitem, ado_pr, group_id
- **imputation_accounts**: number (unique alphanumeric), description, project, open_date, close_date, active
- **entry_imputations**: many-to-many splits (entry_id, account_id, duration, position)
- **undo_log**: full before/after snapshots for undo/redo (50-entry stack)

### Key Patterns

- **API**: Simple GET/POST to `/api/*`, JSON bodies. Not REST (e.g. `POST /api/entries/1/delete`)
- **Rendering**: Full re-render on every change (`loadEntries()` -> `renderDays()`)
- **Inline editing**: Click cell -> swap display span for input/select -> commit on blur
- **Undo/redo**: Snapshot-based. `_snapshot_entries()` captures full state before/after each mutation
- **Grouping**: Entries share a `group_id` (UUID). Shared fields (description, workitem, PR) propagate to all group members
- **Splits**: Each entry can have multiple imputation splits (account + duration). Edited via chip UI with popup selects
- **Column resize**: Drag handles on table headers, widths persisted to localStorage
- **Drag & drop**: Entries draggable between day groups (move, duplicate, or duplicate+link)

### DB Migrations

All in `db.py:init_db()` - incremental `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS` with data migration from legacy single-account columns to `entry_imputations` table.

## Legacy / Dead Code

- `entries.imputation_account_id` and `entries.imputation_duration` columns still exist in schema but are unused (migrated to `entry_imputations`). Kept for backward compat with existing DBs.
- `ENTRY_COLUMNS` list in db.py still references these legacy columns (used by undo/redo snapshots).

## Potential Refactoring Notes

- **app.js size**: Single 1660-line IIFE. Could be split by view/feature but currently manageable since there's no build step.
- **Column resize duplication**: Two nearly identical IIFEs (lines ~981-1027 for entries, ~1030-1072 for accounts) doing the same resize logic.
- **Popup close patterns**: 5+ different popup/menu types each with their own close-on-outside-click handler. Could be unified.
- ~~**db.py connection management**~~: Done — `get_connection` is now a `@contextmanager`; all public functions use `with get_connection(db_path) as conn:`.
- **perform_undo / perform_redo**: Nearly identical (~25 lines each), differing only in query direction and which state to restore.
- **Server routing**: POST routes use a chain of `re.match()` calls. Could use a routing table.
- **No frontend error handling**: `api()` helper doesn't handle HTTP errors or network failures.

## Current TODO

1. **File logging for server** - Server uses `logging` but runs headless; add a file handler so logs persist to disk.
2. **Imputation dropdown overflow** - Account dropdown overflows page (long titles). Duration dropdown appears off-screen after selection. Need suggestions before implementing.
3. **Loading indicator / page lock** - No feedback when actions are processing (e.g. "+ today"). Add animated loading overlay to lock UI and show progress.
4. **Empty placeholder for today** - When today has no entries, add a visible placeholder section so entries can be dragged into it.
5. **"(today)" label on date header** - Append " (today)" after the date in the entries list when the date matches today.
