(function () {
    "use strict";

    // --- State ---
    var entries = [];
    var accounts = [];
    var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var COL_COUNT = 8; // number of columns in entry tables

    // --- Helpers ---
    function fmtDate(d) {
        var y = d.getFullYear();
        var m = d.getMonth() + 1;
        var day = d.getDate();
        return y + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
    }

    function dayName(isoDate) {
        var parts = isoDate.split("-");
        var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        return DAY_NAMES[d.getDay()];
    }

    function dateDisplay(isoDate) {
        return dayName(isoDate) + "  " + isoDate;
    }

    function fmtDuration(minutes) {
        if (minutes == null || minutes === "") return "";
        var h = Math.floor(minutes / 60);
        var m = minutes % 60;
        return h + ":" + (m < 10 ? "0" : "") + m;
    }

    function durationOptions() {
        var opts = [];
        for (var m = 15; m <= 720; m += 15) {
            opts.push({ value: m, label: fmtDuration(m) });
        }
        return opts;
    }

    function acctLabel(a) {
        var parts = [a.number || a.account_number];
        if (a.project || a.account_project) parts.push(a.project || a.account_project);
        if (a.description || a.account_description) parts.push(a.description || a.account_description);
        return parts.join(" - ");
    }

    function api(method, path, body) {
        var opts = { method: method, headers: {} };
        if (body !== undefined) {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(body);
        }
        return fetch(path, opts).then(function (r) { return r.json(); });
    }

    // --- Load data ---
    function loadEntries() {
        return api("GET", "/api/entries")
            .then(function (data) {
                entries = data;
                renderDays();
            });
    }

    function loadAccounts() {
        return api("GET", "/api/accounts").then(function (data) {
            accounts = data;
        });
    }

    // --- Group entries by date ---
    function groupByDate() {
        var groups = [];
        var map = {};
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!map[e.date]) {
                map[e.date] = { date: e.date, entries: [] };
                groups.push(map[e.date]);
            }
            map[e.date].entries.push(e);
        }
        return groups;
    }

    // --- Render ---
    function renderDays() {
        var container = document.getElementById("days-container");
        container.innerHTML = "";
        var groups = groupByDate();
        var grandTotal = 0;

        for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            var dayTotal = 0;
            for (var i = 0; i < group.entries.length; i++) {
                dayTotal += group.entries[i].duration || 0;
            }
            grandTotal += dayTotal;
            container.appendChild(makeDayGroup(group, dayTotal));
        }

        document.getElementById("total-label").textContent = "Total: " + fmtDuration(grandTotal);
    }

    function makeDayGroup(group, dayTotal) {
        var div = document.createElement("div");
        div.className = "day-group";
        div.dataset.date = group.date;

        // Header
        var hdr = document.createElement("div");
        hdr.className = "day-header";
        var dateSpan = document.createElement("span");
        dateSpan.className = "day-date";
        dateSpan.textContent = dateDisplay(group.date);
        var totalSpan = document.createElement("span");
        totalSpan.className = "day-total";
        totalSpan.textContent = fmtDuration(dayTotal);
        var rightSpan = document.createElement("span");
        rightSpan.className = "day-right";
        var addDayBtn = document.createElement("button");
        addDayBtn.className = "btn-add-day";
        addDayBtn.textContent = "+";
        addDayBtn.title = "Add entry this day";
        addDayBtn.onclick = function () {
            api("POST", "/api/entries", { date: group.date, duration: 60 }).then(loadEntries);
        };
        rightSpan.appendChild(addDayBtn);
        rightSpan.appendChild(totalSpan);
        hdr.appendChild(dateSpan);
        hdr.appendChild(rightSpan);
        div.appendChild(hdr);

        // Table
        var table = document.createElement("table");
        var thead = document.createElement("thead");
        var headerRow = document.createElement("tr");
        var cols = [
            ["col-dur", "Duration"],
            ["col-desc", "Description"],
            ["col-wi", "WI"],
            ["col-pr", "PR"],
            ["col-acct", "Account"],
            ["col-idur", "Imp. Dur."],
            ["col-notes", "Notes"],
            ["col-act", ""],
        ];
        for (var c = 0; c < cols.length; c++) {
            var th = document.createElement("th");
            th.className = cols[c][0];
            th.textContent = cols[c][1];
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement("tbody");
        for (var i = 0; i < group.entries.length; i++) {
            tbody.appendChild(makeEntryRow(group.entries[i]));
        }
        table.appendChild(tbody);
        div.appendChild(table);

        // Drop target
        div.addEventListener("dragover", function (ev) {
            ev.preventDefault();
            div.classList.add("drag-over");
        });
        div.addEventListener("dragleave", function (ev) {
            if (!div.contains(ev.relatedTarget)) {
                div.classList.remove("drag-over");
            }
        });
        div.addEventListener("drop", function (ev) {
            ev.preventDefault();
            div.classList.remove("drag-over");
            var raw = ev.dataTransfer.getData("text/plain");
            if (!raw) return;
            var parts = raw.split(":");
            var entryId = parts[0];
            var sourceDate = parts[1] || "";
            var sameDay = sourceDate === group.date;
            showDropMenu(ev.clientX, ev.clientY, entryId, group.date, sameDay);
        });

        return div;
    }

    // --- Drop context menu ---
    function showDropMenu(x, y, entryId, targetDate, sameDay) {
        closeDropMenu();

        var menu = document.createElement("div");
        menu.className = "drop-menu";
        menu.style.left = x + "px";
        menu.style.top = y + "px";

        var moveBtn = document.createElement("button");
        moveBtn.textContent = "Move here";
        if (sameDay) {
            moveBtn.className = "disabled";
        } else {
            moveBtn.onclick = function () {
                api("POST", "/api/entries/" + entryId, { date: targetDate }).then(loadEntries);
                closeDropMenu();
            };
        }
        menu.appendChild(moveBtn);

        var dupBtn = document.createElement("button");
        dupBtn.textContent = "Duplicate here";
        dupBtn.onclick = function () {
            api("POST", "/api/entries/" + entryId + "/duplicate", { date: targetDate }).then(loadEntries);
            closeDropMenu();
        };
        menu.appendChild(dupBtn);

        var hr = document.createElement("hr");
        menu.appendChild(hr);

        var cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = closeDropMenu;
        menu.appendChild(cancelBtn);

        document.body.appendChild(menu);

        // Adjust if menu goes off-screen
        var rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + "px";
        if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + "px";

        // Close on outside click (next tick so this click doesn't trigger it)
        setTimeout(function () {
            document.addEventListener("mousedown", onOutsideClick);
        }, 0);
    }

    function onOutsideClick(ev) {
        var menu = document.querySelector(".drop-menu");
        if (menu && !menu.contains(ev.target)) {
            closeDropMenu();
        }
    }

    function closeDropMenu() {
        var menu = document.querySelector(".drop-menu");
        if (menu) menu.remove();
        document.removeEventListener("mousedown", onOutsideClick);
    }

    function makeEntryRow(entry) {
        var tr = document.createElement("tr");
        tr.dataset.id = entry.id;
        tr.draggable = true;

        // Drag start
        tr.addEventListener("dragstart", function (ev) {
            ev.dataTransfer.setData("text/plain", entry.id + ":" + entry.date);
            ev.dataTransfer.effectAllowed = "move";
            tr.classList.add("dragging");
        });
        tr.addEventListener("dragend", function () {
            tr.classList.remove("dragging");
            // Remove all drag-over highlights
            var groups = document.querySelectorAll(".day-group.drag-over");
            for (var i = 0; i < groups.length; i++) groups[i].classList.remove("drag-over");
        });

        // Duration
        addCell(tr, entry, "duration", fmtDuration(entry.duration), "duration-select");
        // Description
        addCell(tr, entry, "description", entry.description || "", "text");
        // ADO Work Item
        addCell(tr, entry, "ado_workitem", entry.ado_workitem || "", "text");
        // ADO PR
        addCell(tr, entry, "ado_pr", entry.ado_pr || "", "text");
        // Account
        var al = entry.account_number ? acctLabel(entry) : "";
        addCell(tr, entry, "imputation_account_id", al, "account-select");
        // Imputation duration
        addCell(tr, entry, "imputation_duration", fmtDuration(entry.imputation_duration), "duration-select");
        // Notes
        addCell(tr, entry, "notes", entry.notes ? "\u270E " + truncate(entry.notes, 15) : "", "notes");
        // Actions
        var actTd = document.createElement("td");
        var actions = document.createElement("span");
        actions.className = "row-actions";

        // Drag handle
        var handle = document.createElement("span");
        handle.className = "btn-row drag-handle";
        handle.textContent = "\u2261";
        handle.title = "Drag to move to another day";
        actions.appendChild(handle);

        // Date change
        var dateBtn = document.createElement("button");
        dateBtn.className = "btn-row";
        dateBtn.textContent = "\u{1F4C5}";
        dateBtn.title = "Change date";
        dateBtn.onclick = function (ev) {
            ev.stopPropagation();
            openDatePicker(actTd, entry);
        };
        actions.appendChild(dateBtn);

        // Delete (trash can)
        var delBtn = document.createElement("button");
        delBtn.className = "btn-row btn-delete";
        delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5.3 4V2.7a1.3 1.3 0 011.3-1.3h2.8a1.3 1.3 0 011.3 1.3V4M13 4v9.3a1.3 1.3 0 01-1.3 1.3H4.3A1.3 1.3 0 013 13.3V4"/></svg>';
        delBtn.title = "Delete";
        delBtn.onclick = function () {
            if (confirm("Delete this entry?")) {
                api("POST", "/api/entries/" + entry.id + "/delete").then(loadEntries);
            }
        };
        actions.appendChild(delBtn);

        actTd.appendChild(actions);
        tr.appendChild(actTd);

        return tr;
    }

    function openDatePicker(td, entry) {
        // Remove any existing picker
        var existing = td.querySelector("input[type=date]");
        if (existing) return;
        var input = document.createElement("input");
        input.type = "date";
        input.value = entry.date;
        input.style.position = "absolute";
        input.style.zIndex = "10";
        td.style.position = "relative";
        td.appendChild(input);
        input.focus();

        function done() {
            if (input.value && input.value !== entry.date) {
                api("POST", "/api/entries/" + entry.id, { date: input.value }).then(loadEntries);
            } else {
                input.remove();
            }
        }
        input.onblur = done;
        input.onkeydown = function (ev) {
            if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
            if (ev.key === "Escape") { input.remove(); }
        };
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
                opt2.textContent = acctLabel(accounts[j]);
                input.appendChild(opt2);
            }
            input.value = entry.imputation_account_id != null ? String(entry.imputation_account_id) : "";
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
                input.remove();
                display.style.display = "";
            } else if (ev.key === "Tab") {
                ev.preventDefault();
                input.blur();
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
        var rows = document.querySelectorAll(".day-group tr[data-id]");
        for (var i = 0; i < rows.length; i++) {
            var tds = rows[i].querySelectorAll("td");
            for (var j = 0; j < tds.length - 1; j++) {
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

    // --- Scroll to today ---
    function scrollToToday() {
        var today = fmtDate(new Date());
        var group = document.querySelector('.day-group[data-date="' + today + '"]');
        if (group) {
            group.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }

    // --- Add entry ---
    function addEntryToday() {
        var today = fmtDate(new Date());
        api("POST", "/api/entries", { date: today, duration: 60 }).then(function () {
            loadEntries().then(scrollToToday);
        });
    }

    function addEntryForDate() {
        var container = document.querySelector(".header-right");
        var existing = container.querySelector(".header-date-picker");
        if (existing) { existing.remove(); return; }
        var input = document.createElement("input");
        input.type = "date";
        input.className = "header-date-picker";
        input.value = fmtDate(new Date());
        container.appendChild(input);
        input.focus();

        function done() {
            var date = input.value;
            input.remove();
            if (date) {
                api("POST", "/api/entries", { date: date, duration: 60 }).then(function () {
                    loadEntries().then(function () {
                        var group = document.querySelector('.day-group[data-date="' + date + '"]');
                        if (group) group.scrollIntoView({ behavior: "smooth", block: "start" });
                    });
                });
            }
        }
        input.onchange = done;
        input.onblur = function () { setTimeout(function () { if (input.parentNode) input.remove(); }, 200); };
        input.onkeydown = function (ev) {
            if (ev.key === "Escape") input.remove();
        };
    }

    // --- Accounts modal ---
    function openAccountsModal() {
        document.getElementById("accounts-modal").classList.remove("hidden");
        renderAccounts();
    }

    function closeAccountsModal() {
        document.getElementById("accounts-modal").classList.add("hidden");
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

        function makeField(field) {
            var td = document.createElement("td");
            var inp = document.createElement("input");
            inp.value = acct[field] || "";
            inp.onblur = function () {
                if (inp.value !== (acct[field] || "")) {
                    var data = {};
                    data[field] = inp.value;
                    api("POST", "/api/accounts/" + acct.id, data).then(renderAccounts);
                }
            };
            inp.onkeydown = function (ev) { if (ev.key === "Enter") inp.blur(); };
            td.appendChild(inp);
            tr.appendChild(td);
        }

        makeField("number");
        makeField("description");
        makeField("project");

        // Delete
        var tdAct = document.createElement("td");
        var btn = document.createElement("button");
        btn.className = "btn-row btn-delete";
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
    document.getElementById("btn-today").onclick = scrollToToday;
    document.getElementById("btn-add").onclick = addEntryToday;
    document.getElementById("btn-add-date").onclick = addEntryForDate;
    document.getElementById("btn-accounts").onclick = openAccountsModal;
    document.getElementById("btn-close-accounts").onclick = closeAccountsModal;
    document.getElementById("btn-add-account").onclick = addAccount;

    // Close notes popup on outside click
    document.addEventListener("click", function (ev) {
        var popup = document.getElementById("notes-popup");
        if (!popup.classList.contains("hidden") && !popup.contains(ev.target)) {
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
    loadAccounts().then(function () {
        loadEntries().then(scrollToToday);
    });

})();
