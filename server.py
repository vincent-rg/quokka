#!/usr/bin/env python3
"""Quokka - Work time tracker server."""

import json
import os
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def load_config():
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)


CONFIG = load_config()
DB_PATH = os.path.join(BASE_DIR, CONFIG.get("database", "quokka.db"))


class QuokkaHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the Quokka app."""

    def log_message(self, format, *args):
        # Quieter logging: just method + path
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, message):
        self._send_json({"error": message}, status)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def _serve_static(self, filepath):
        if not os.path.isfile(filepath):
            self.send_error(404)
            return
        ext = os.path.splitext(filepath)[1]
        mime = MIME_TYPES.get(ext, "application/octet-stream")
        with open(filepath, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    # --- Routing ---

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            self._serve_static(os.path.join(STATIC_DIR, "index.html"))
        elif path.startswith("/static/"):
            # Prevent directory traversal
            rel = path[len("/static/"):]
            if ".." in rel:
                self.send_error(403)
                return
            self._serve_static(os.path.join(STATIC_DIR, rel))
        elif path == "/api/entries":
            self._handle_list_entries(parsed)
        elif path == "/api/accounts":
            self._handle_list_accounts()
        else:
            m = re.match(r"^/api/entries/(\d+)/suggest-links$", path)
            if m:
                self._handle_suggest_links(int(m.group(1)))
            else:
                self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path

        # Entry routes
        m = re.match(r"^/api/entries/(\d+)/duplicate$", path)
        if m:
            self._handle_duplicate_entry(int(m.group(1)))
            return

        m = re.match(r"^/api/entries/(\d+)/ungroup$", path)
        if m:
            self._handle_ungroup_entry(int(m.group(1)))
            return

        m = re.match(r"^/api/entries/(\d+)/link$", path)
        if m:
            self._handle_link_entry(int(m.group(1)))
            return

        m = re.match(r"^/api/entries/(\d+)/delete$", path)
        if m:
            self._handle_delete_entry(int(m.group(1)))
            return

        m = re.match(r"^/api/entries/(\d+)$", path)
        if m:
            self._handle_update_entry(int(m.group(1)))
            return

        if path == "/api/entries":
            self._handle_create_entry()
            return

        # Account routes
        m = re.match(r"^/api/accounts/(\d+)/delete$", path)
        if m:
            self._handle_delete_account(int(m.group(1)))
            return

        m = re.match(r"^/api/accounts/(\d+)$", path)
        if m:
            self._handle_update_account(int(m.group(1)))
            return

        if path == "/api/accounts":
            self._handle_create_account()
            return

        self.send_error(404)

    # --- Entry handlers ---

    def _handle_list_entries(self, parsed):
        qs = parse_qs(parsed.query)
        date_from = qs.get("from", [None])[0]
        date_to = qs.get("to", [None])[0]
        entries = db.list_entries(DB_PATH, date_from, date_to)
        self._send_json(entries)

    def _handle_create_entry(self):
        data = self._read_body()
        if not data.get("date") or data.get("duration") is None:
            self._send_error(400, "date and duration are required")
            return
        entry = db.create_entry(DB_PATH, data)
        self._send_json(entry, 201)

    def _handle_update_entry(self, entry_id):
        data = self._read_body()
        entry = db.update_entry(DB_PATH, entry_id, data)
        if entry is None:
            self._send_error(404, "Entry not found")
            return
        # Propagate shared fields to group members
        if entry.get("group_id"):
            shared_updates = {k: v for k, v in data.items() if k in db.SHARED_FIELDS}
            if shared_updates:
                db.update_group_shared(DB_PATH, entry["group_id"], shared_updates)
        self._send_json(entry)

    def _handle_duplicate_entry(self, entry_id):
        data = self._read_body()
        target_date = data.get("date")
        if not target_date:
            self._send_error(400, "date is required")
            return
        link = data.get("link", False)
        entry = db.duplicate_entry(DB_PATH, entry_id, target_date, link=link)
        if entry is None:
            self._send_error(404, "Entry not found")
            return
        self._send_json(entry, 201)

    def _handle_delete_entry(self, entry_id):
        db.delete_entry(DB_PATH, entry_id)
        self._send_json({"ok": True})

    # --- Grouping handlers ---

    def _handle_ungroup_entry(self, entry_id):
        db.ungroup_entry(DB_PATH, entry_id)
        self._send_json({"ok": True})

    def _handle_link_entry(self, entry_id):
        data = self._read_body()
        target_entry_id = data.get("target_entry_id")
        if not target_entry_id:
            self._send_error(400, "target_entry_id is required")
            return
        resolution = data.get("resolution")
        entry = db.link_entries(DB_PATH, entry_id, target_entry_id, resolution)
        if entry is None:
            self._send_error(404, "Entry not found")
            return
        self._send_json(entry)

    def _handle_suggest_links(self, entry_id):
        suggestions = db.suggest_groups(DB_PATH, entry_id)
        self._send_json(suggestions)

    # --- Account handlers ---

    def _handle_list_accounts(self):
        accounts = db.list_accounts(DB_PATH)
        self._send_json(accounts)

    def _handle_create_account(self):
        data = self._read_body()
        if not data.get("number"):
            self._send_error(400, "number is required")
            return
        try:
            account = db.create_account(
                DB_PATH, data["number"], data.get("description", ""),
                data.get("project", ""),
            )
        except Exception:
            self._send_error(409, "Account number already exists")
            return
        self._send_json(account, 201)

    def _handle_update_account(self, account_id):
        data = self._read_body()
        account = db.update_account(DB_PATH, account_id, **data)
        if account is None:
            self._send_error(404, "Account not found")
            return
        self._send_json(account)

    def _handle_delete_account(self, account_id):
        db.delete_account(DB_PATH, account_id)
        self._send_json({"ok": True})


def main():
    db.init_db(DB_PATH)
    port = CONFIG.get("port", 8080)
    server = HTTPServer(("127.0.0.1", port), QuokkaHandler)
    print(f"Quokka running on http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
