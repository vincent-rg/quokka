(function () {
    "use strict";

    // --- State ---
    var weekOffset = 0; // 0 = current week
    var entries = [];
    var accounts = [];

    // --- Helpers ---
    function getMonday(date) {
        var d = new Date(date);
        var day = d.getDay();
        var diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function addDays(d, n) {
        var r = new Date(d);
        r.setDate(r.getDate() + n);
        return r;
    }

    function fmtDate(d) {
        return d.toISOString().slice(0, 10);
    }

    function fmtDuration(minutes) {
        if (minutes == null || minutes === "") return "";
        var h = Math.floor(minutes / 60);
        var m = minutes % 60;
        return h + ":" + (m < 10 ? "0" : "") + m;
    }

    function parseDuration(str) {
        if (!str) return null;
        var parts = str.split(":");
        if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        return parseInt(str) * 60; // treat as hours
    }

    function durationOptions() {
        var opts = [];
        for (var m = 15; m <= 720; m += 15) {
            opts.push({ value: m, label: fmtDuration(m) });
        }
        return opts;
    }

    function api(method, path, body) {
        var opts = { method: method, headers: {} };
        if (body !== undefined) {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(body);
        }
        return fetch(path, opts).then(function (r) { return r.json(); });
    }

    // --- Week range ---
    function getWeekRange() {
        var mon = getMonday(new Date());
        mon = addDays(mon, weekOffset * 7);
        var sun = addDays(mon, 6);
        return { from: fmtDate(mon), to: fmtDate(sun), monday: mon };
    }

    function updateWeekLabel() {
        var range = getWeekRange();
        var label = range.from + "  to  " + range.to;
        document.getElementById("week-label").textContent = label;
    }

    // --- Load data ---
    function loadEntries() {
        var range = getWeekRange();
        return api("GET", "/api/entries?from=" + range.from + "&to=" + range.to)
            .then(function (data) {
                entries = data;
                renderEntries();
            });
    }

    function loadAccounts() {
        return api("GET", "/api/accounts").then(function (data) {
            accounts = data;
        });
    }

    // --- Render entries table ---
    function renderEntries() {
        var tbody = document.getElementById("entries-body");
        tbody.innerHTML = "";

        var currentDate = null;
        var dayTotal = 0;
        var weekTotal = 0;

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];

            // Day separator + previous day total
            if (e.date !== currentDate) {
                if (currentDate !== null) {
                    tbody.appendChild(makeDayTotalRow(currentDate, dayTotal));
                    dayTotal = 0;
                }
                currentDate = e.date;
            }

            dayTotal += e.duration || 0;
            weekTotal += e.duration || 0;
            tbody.appendChild(makeEntryRow(e));
        }

        // Last day total
        if (currentDate !== null) {
            tbody.appendChild(makeDayTotalRow(currentDate, dayTotal));
        }

        document.getElementById("week-total").textContent = "Week total: " + fmtDuration(weekTotal);
    }

    function makeDayTotalRow(date, total) {
        var tr = document.createElement("tr");
        tr.className = "day-total";
        var td = document.createElement("td");
        td.colSpan = 9;
        td.textContent = date + " \u2014 " + fmtDuration(total);
        tr.appendChild(td);
        return tr;
    }

    function makeEntryRow(entry) {
        var tr = document.createElement("tr");
        tr.dataset.id = entry.id;

        // Determine if first entry for this date for separator styling
        var idx = entries.indexOf(entry);
        if (idx === 0 || entries[idx - 1].date !== entry.date) {
            tr.className = "day-separator";
        }

        // Date
        addCell(tr, entry, "date", entry.date, "date");
        // Duration
        addCell(tr, entry, "duration", fmtDuration(entry.duration), "duration-select");
        // Description
        addCell(tr, entry, "description", entry.description || "", "text");
        // ADO Work Item
        addCell(tr, entry, "ado_workitem", entry.ado_workitem || "", "text");
        // ADO PR
        addCell(tr, entry, "ado_pr", entry.ado_pr || "", "text");
        // Account
        var acctLabel = entry.account_number || "";
        if (entry.account_number && entry.account_description) {
            acctLabel = entry.account_number + " - " + entry.account_description;
        }
        addCell(tr, entry, "imputation_account_id", acctLabel, "account-select");
        // Imputation duration
        addCell(tr, entry, "imputation_duration", fmtDuration(entry.imputation_duration), "duration-select");
        // Notes
        addCell(tr, entry, "notes", entry.notes ? "\u270E " + truncate(entry.notes, 15) : "", "notes");
        // Delete
        var actTd = document.createElement("td");
        var btn = document.createElement("button");
        btn.className = "btn-delete";
        btn.textContent = "\u00d7";
        btn.title = "Delete";
        btn.onclick = function () {
            if (confirm("Delete this entry?")) {
                api("POST", "/api/entries/" + entry.id + "/delete").then(loadEntries);
            }
        };
        actTd.appendChild(btn);
        tr.appendChild(actTd);

        return tr;
    }

    function truncate(s, n) {
        return s.length > n ? s.slice(0, n) + "\u2026" : s;
    }

    function addCell(tr, entry, field, displayText, inputType) {
        var td = document.createElement("td");
        var display = document.createElement("span");
        display.className = "cell-display";
        if (!displayText && displayText !== 0) {
            display.classList.add("placeholder");
            display.textContent = "\u00b7\u00b7\u00b7";
        } else {
            display.textContent = displayText;
        }

        display.onclick = function () {
            startEdit(td, entry, field, inputType);
        };

        td.appendChild(display);
        tr.appendChild(td);
    }

    // --- Inline editing ---
    function startEdit(td, entry, field, inputType) {
        // Already editing?
        if (td.querySelector("input, select")) return;

        var display = td.querySelector(".cell-display");

        if (inputType === "notes") {
            openNotesPopup(td, entry);
            return;
        }

        var input;

        if (inputType === "duration-select") {
            input = document.createElement("select");
            var emptyOpt = document.createElement("option");
            emptyOpt.value = "";
            emptyOpt.textContent = "\u2014";
            input.appendChild(emptyOpt);
            var opts = durationOptions();
            for (var i = 0; i < opts.length; i++) {
                var opt = document.createElement("option");
                opt.value = opts[i].value;
                opt.textContent = opts[i].label;
                input.appendChild(opt);
            }
            input.value = entry[field] != null ? String(entry[field]) : "";
        } else if (inputType === "account-select") {
            input = document.createElement("select");
            var emptyOpt2 = document.createElement("option");
            emptyOpt2.value = "";
            emptyOpt2.textContent = "\u2014 none \u2014";
            input.appendChild(emptyOpt2);
            for (var j = 0; j < accounts.length; j++) {
                var opt2 = document.createElement("option");
                opt2.value = accounts[j].id;
                opt2.textContent = accounts[j].number + " - " + accounts[j].description;
                input.appendChild(opt2);
            }
            input.value = entry.imputation_account_id != null ? String(entry.imputation_account_id) : "";
        } else if (inputType === "date") {
            input = document.createElement("input");
            input.type = "date";
            input.value = entry[field] || "";
        } else {
            input = document.createElement("input");
            input.type = "text";
            input.value = entry[field] || "";
        }

        display.style.display = "none";
        td.appendChild(input);
        input.focus();
        if (input.select) input.select();

        function commit() {
            var val = input.value;
            var data = {};

            if (inputType === "duration-select") {
                data[field] = val ? parseInt(val) : null;
            } else if (inputType === "account-select") {
                data[field] = val ? parseInt(val) : null;
            } else {
                data[field] = val;
            }

            api("POST", "/api/entries/" + entry.id, data).then(loadEntries);
        }

        input.onblur = function () {
            commit();
        };
        input.onkeydown = function (ev) {
            if (ev.key === "Enter") {
                ev.preventDefault();
                input.blur();
            } else if (ev.key === "Escape") {
                // Cancel: restore display
                input.remove();
                display.style.display = "";
            } else if (ev.key === "Tab") {
                ev.preventDefault();
                input.blur();
                // Move to next/prev editable cell
                setTimeout(function () {
                    var cells = getAllEditableCells();
                    var currentIdx = cells.indexOf(td);
                    var nextIdx = ev.shiftKey ? currentIdx - 1 : currentIdx + 1;
                    if (nextIdx >= 0 && nextIdx < cells.length) {
                        cells[nextIdx].querySelector(".cell-display").click();
                    }
                }, 50);
            }
        };
    }

    function getAllEditableCells() {
        var cells = [];
        var rows = document.querySelectorAll("#entries-body tr[data-id]");
        for (var i = 0; i < rows.length; i++) {
            var tds = rows[i].querySelectorAll("td");
            for (var j = 0; j < tds.length - 1; j++) { // exclude action column
                if (tds[j].querySelector(".cell-display")) {
                    cells.push(tds[j]);
                }
            }
        }
        return cells;
    }

    // --- Notes popup ---
    function openNotesPopup(td, entry) {
        var popup = document.getElementById("notes-popup");
        var textarea = document.getElementById("notes-textarea");
        textarea.value = entry.notes || "";

        var rect = td.getBoundingClientRect();
        popup.style.left = Math.min(rect.left, window.innerWidth - 320) + "px";
        popup.style.top = (rect.bottom + 4) + "px";
        popup.classList.remove("hidden");
        textarea.focus();

        document.getElementById("notes-save").onclick = function () {
            api("POST", "/api/entries/" + entry.id, { notes: textarea.value })
                .then(function () {
                    popup.classList.add("hidden");
                    loadEntries();
                });
        };
        document.getElementById("notes-cancel").onclick = function () {
            popup.classList.add("hidden");
        };
    }

    // --- Add entry ---
    function addEntry() {
        var today = fmtDate(new Date());
        var range = getWeekRange();
        var date = today;
        // If today is not in the displayed week, use monday of displayed week
        if (date < range.from || date > range.to) {
            date = range.from;
        }
        api("POST", "/api/entries", { date: date, duration: 60 }).then(loadEntries);
    }

    // --- Accounts modal ---
    function openAccountsModal() {
        document.getElementById("accounts-modal").classList.remove("hidden");
        renderAccounts();
    }

    function closeAccountsModal() {
        document.getElementById("accounts-modal").classList.add("hidden");
        // Reload entries to reflect any account changes
        loadEntries();
    }

    function renderAccounts() {
        loadAccounts().then(function () {
            var tbody = document.getElementById("accounts-body");
            tbody.innerHTML = "";
            for (var i = 0; i < accounts.length; i++) {
                tbody.appendChild(makeAccountRow(accounts[i]));
            }
        });
    }

    function makeAccountRow(acct) {
        var tr = document.createElement("tr");

        // Number
        var tdNum = document.createElement("td");
        var inpNum = document.createElement("input");
        inpNum.value = acct.number;
        inpNum.onblur = function () {
            if (inpNum.value !== acct.number) {
                api("POST", "/api/accounts/" + acct.id, { number: inpNum.value }).then(function () {
                    loadAccounts();
                });
            }
        };
        inpNum.onkeydown = function (ev) { if (ev.key === "Enter") inpNum.blur(); };
        tdNum.appendChild(inpNum);
        tr.appendChild(tdNum);

        // Description
        var tdDesc = document.createElement("td");
        var inpDesc = document.createElement("input");
        inpDesc.value = acct.description;
        inpDesc.onblur = function () {
            if (inpDesc.value !== acct.description) {
                api("POST", "/api/accounts/" + acct.id, { description: inpDesc.value }).then(function () {
                    loadAccounts();
                });
            }
        };
        inpDesc.onkeydown = function (ev) { if (ev.key === "Enter") inpDesc.blur(); };
        tdDesc.appendChild(inpDesc);
        tr.appendChild(tdDesc);

        // Delete
        var tdAct = document.createElement("td");
        var btn = document.createElement("button");
        btn.className = "btn-delete";
        btn.textContent = "\u00d7";
        btn.title = "Deactivate";
        btn.onclick = function () {
            if (confirm("Deactivate account " + acct.number + "?")) {
                api("POST", "/api/accounts/" + acct.id + "/delete").then(renderAccounts);
            }
        };
        tdAct.appendChild(btn);
        tr.appendChild(tdAct);

        return tr;
    }

    function addAccount() {
        api("POST", "/api/accounts", { number: "NEW", description: "" }).then(renderAccounts);
    }

    // --- Event listeners ---
    document.getElementById("btn-prev").onclick = function () { weekOffset--; updateWeekLabel(); loadEntries(); };
    document.getElementById("btn-next").onclick = function () { weekOffset++; updateWeekLabel(); loadEntries(); };
    document.getElementById("btn-today").onclick = function () { weekOffset = 0; updateWeekLabel(); loadEntries(); };
    document.getElementById("btn-add").onclick = addEntry;
    document.getElementById("btn-accounts").onclick = openAccountsModal;
    document.getElementById("btn-close-accounts").onclick = closeAccountsModal;
    document.getElementById("btn-add-account").onclick = addAccount;

    // Close notes popup on outside click
    document.addEventListener("click", function (ev) {
        var popup = document.getElementById("notes-popup");
        if (!popup.classList.contains("hidden") && !popup.contains(ev.target)) {
            // Check if click was on a notes cell
            var target = ev.target;
            while (target && target !== document.body) {
                if (target.classList && target.classList.contains("cell-display")) return;
                target = target.parentNode;
            }
            popup.classList.add("hidden");
        }
    });

    // Close modal on backdrop click
    document.getElementById("accounts-modal").onclick = function (ev) {
        if (ev.target === this) closeAccountsModal();
    };

    // --- Init ---
    updateWeekLabel();
    loadAccounts().then(loadEntries);

})();
