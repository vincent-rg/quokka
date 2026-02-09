(function () {
    "use strict";

    // --- State ---
    var entries = [];
    var accounts = [];
    var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var COL_COUNT = 9; // number of columns in entry tables
    var COL_DEFAULTS = [70, 180, 70, 70, 130, 70, 120, 28, 50];
    var colWidths = (function () {
        try {
            var saved = JSON.parse(localStorage.getItem("colWidths"));
            if (saved && saved.length === COL_DEFAULTS.length) return saved;
        } catch (e) {}
        return COL_DEFAULTS.slice();
    })();

    function totalColWidth() {
        var s = 0;
        for (var i = 0; i < colWidths.length; i++) s += colWidths[i];
        return s;
    }

    function saveColWidths() {
        localStorage.setItem("colWidths", JSON.stringify(colWidths));
    }

    // Group colors: 8 distinct hues for left-border + highlight
    var GROUP_COLORS = [
        "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
        "#9b59b6", "#1abc9c", "#e67e22", "#e91e63"
    ];
    var GROUP_COLORS_LIGHT = [
        "#fde8e8", "#e8f4fd", "#e8faf0", "#fef3e0",
        "#f3e8fd", "#e0faf5", "#fdeee0", "#fde0eb"
    ];

    function groupColorIndex(groupId) {
        var hash = 0;
        for (var i = 0; i < groupId.length; i++) {
            hash = ((hash << 5) - hash) + groupId.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash) % GROUP_COLORS.length;
    }

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
                updateUndoButtons();
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
            api("POST", "/api/entries", { date: group.date, duration: 0 }).then(loadEntries);
        };
        rightSpan.appendChild(addDayBtn);
        rightSpan.appendChild(totalSpan);
        hdr.appendChild(dateSpan);
        hdr.appendChild(rightSpan);
        div.appendChild(hdr);

        // Table
        var table = document.createElement("table");
        table.style.tableLayout = "fixed";
        table.style.width = totalColWidth() + "px";

        // Colgroup for synced widths
        var colgroup = document.createElement("colgroup");
        for (var ci = 0; ci < COL_COUNT; ci++) {
            var col = document.createElement("col");
            col.style.width = colWidths[ci] + "px";
            colgroup.appendChild(col);
        }
        table.appendChild(colgroup);

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
            ["col-link", ""],
            ["col-act", ""],
        ];
        for (var c = 0; c < cols.length; c++) {
            var th = document.createElement("th");
            th.className = cols[c][0];
            th.textContent = cols[c][1];
            // Resize handle (not on last column)
            if (c < cols.length - 1) {
                var handle = document.createElement("div");
                handle.className = "col-resize";
                handle.dataset.colIndex = c;
                th.appendChild(handle);
            }
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

        var dupLinkBtn = document.createElement("button");
        dupLinkBtn.textContent = "Duplicate & link";
        dupLinkBtn.onclick = function () {
            api("POST", "/api/entries/" + entryId + "/duplicate", { date: targetDate, link: true }).then(loadEntries);
            closeDropMenu();
        };
        menu.appendChild(dupLinkBtn);

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
        if (entry.group_id) {
            tr.dataset.group = entry.group_id;
            var ci = groupColorIndex(entry.group_id);
            tr.style.borderLeft = "3px solid " + GROUP_COLORS[ci];
        }

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

        // Duration (warning icon for 0:00)
        var durDisplay = fmtDuration(entry.duration);
        if (!entry.duration) durDisplay = "\u26A0 0:00";
        addCell(tr, entry, "duration", durDisplay, "duration-select", !entry.duration ? "zero-warn" : null);
        // Description
        addCell(tr, entry, "description", entry.description || "", "text");
        // ADO Work Item
        addCell(tr, entry, "ado_workitem", entry.ado_workitem || "", "text");
        // ADO PR
        addCell(tr, entry, "ado_pr", entry.ado_pr || "", "text");
        // Account (with date warning)
        var al = entry.account_number ? acctLabel(entry) : "";
        var acctWarn = null;
        if (entry.imputation_account_id) {
            for (var ai = 0; ai < accounts.length; ai++) {
                if (accounts[ai].id === entry.imputation_account_id) {
                    var a = accounts[ai];
                    if (a.open_date && entry.date < a.open_date) {
                        acctWarn = "Account not yet open (opens " + a.open_date + ")";
                    } else if (a.close_date && entry.date > a.close_date) {
                        acctWarn = "Account closed (closed " + a.close_date + ")";
                    }
                    break;
                }
            }
        }
        addCell(tr, entry, "imputation_account_id", al, "account-select", null, acctWarn);
        // Imputation duration
        addCell(tr, entry, "imputation_duration", fmtDuration(entry.imputation_duration), "duration-select");
        // Notes
        addCell(tr, entry, "notes", entry.notes ? "\u270E " + truncate(entry.notes, 15) : "", "notes");
        // Link
        var linkTd = document.createElement("td");
        var linkBtn = document.createElement("button");
        linkBtn.className = "btn-link";
        if (entry.group_id) {
            linkBtn.textContent = "\uD83D\uDD17"; // 🔗
            linkBtn.title = "Grouped - click for details";
            linkBtn.onclick = function (ev) {
                ev.stopPropagation();
                openGroupPopup(linkTd, entry);
            };
        } else {
            linkBtn.textContent = "+";
            linkBtn.className = "btn-link faint";
            linkBtn.title = "Link to another entry";
            linkBtn.onclick = function (ev) {
                ev.stopPropagation();
                openGroupingModal(entry);
            };
        }
        linkTd.appendChild(linkBtn);
        tr.appendChild(linkTd);
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

    function addCell(tr, entry, field, displayText, inputType, extraClass, warning) {
        var td = document.createElement("td");
        var display = document.createElement("span");
        display.className = "cell-display";
        if (extraClass) display.classList.add(extraClass);
        if (warning) {
            var warn = document.createElement("span");
            warn.className = "date-warn";
            warn.textContent = "\u26A0 ";
            warn.title = warning;
            display.appendChild(warn);
        }
        if (!displayText && displayText !== 0) {
            display.classList.add("placeholder");
            display.appendChild(document.createTextNode("\u00b7\u00b7\u00b7"));
        } else {
            display.appendChild(document.createTextNode(displayText));
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
                data[field] = val ? parseInt(val) : (field === "duration" ? 0 : null);
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
            var headerH = document.querySelector("header").offsetHeight;
            var y = group.getBoundingClientRect().top + window.scrollY - headerH;
            window.scrollTo({ top: y, behavior: "smooth" });
        } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }

    // --- Add entry ---
    function addEntryToday() {
        var today = fmtDate(new Date());
        api("POST", "/api/entries", { date: today, duration: 0 }).then(function () {
            loadEntries().then(scrollToToday);
        });
    }

    function addEntryForDate() {
        var container = document.querySelector(".toolbar");
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
                api("POST", "/api/entries", { date: date, duration: 0 }).then(function () {
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

        // Date fields
        function makeDateField(field) {
            var td = document.createElement("td");
            var inp = document.createElement("input");
            inp.type = "date";
            inp.value = acct[field] || "";
            inp.onblur = function () {
                var newVal = inp.value || null;
                var oldVal = acct[field] || null;
                if (newVal !== oldVal) {
                    var data = {};
                    data[field] = newVal;
                    api("POST", "/api/accounts/" + acct.id, data).then(renderAccounts);
                }
            };
            inp.onkeydown = function (ev) { if (ev.key === "Enter") inp.blur(); };
            td.appendChild(inp);
            tr.appendChild(td);
        }
        makeDateField("open_date");
        makeDateField("close_date");

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

    // --- Column resize ---
    function applyColWidths() {
        var w = totalColWidth() + "px";
        var tables = document.querySelectorAll(".day-group table");
        for (var t = 0; t < tables.length; t++) tables[t].style.width = w;
        var headers = document.querySelectorAll(".day-group .day-header");
        for (var h = 0; h < headers.length; h++) headers[h].style.minWidth = w;
        var allCols = document.querySelectorAll(".day-group colgroup col");
        for (var i = 0; i < allCols.length; i++) {
            allCols[i].style.width = colWidths[i % COL_COUNT] + "px";
        }
    }

    (function () {
        var resizing = false, startX = 0, colIdx = 0, startW = 0;

        document.getElementById("days-container").addEventListener("mousedown", function (ev) {
            if (!ev.target.classList.contains("col-resize")) return;
            ev.preventDefault();
            resizing = true;
            colIdx = parseInt(ev.target.dataset.colIndex);
            startX = ev.clientX;
            startW = colWidths[colIdx];
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        });

        document.addEventListener("mousemove", function (ev) {
            if (!resizing) return;
            var delta = ev.clientX - startX;
            colWidths[colIdx] = Math.max(30, startW + delta);
            applyColWidths();
        });

        document.addEventListener("mouseup", function () {
            if (!resizing) return;
            resizing = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            saveColWidths();
        });

        // Double-click: expand column to fill page if table is narrower than viewport
        document.getElementById("days-container").addEventListener("dblclick", function (ev) {
            if (!ev.target.classList.contains("col-resize")) return;
            ev.preventDefault();
            var ci = parseInt(ev.target.dataset.colIndex);
            var dayGroup = ev.target.closest(".day-group");
            if (!dayGroup) return;
            var available = document.documentElement.clientWidth
                - parseFloat(getComputedStyle(document.querySelector("main")).paddingLeft) * 2
                - parseFloat(getComputedStyle(dayGroup).borderLeftWidth) * 2;
            var tw = totalColWidth();
            if (tw < available) {
                colWidths[ci] = colWidths[ci] + (available - tw);
                applyColWidths();
                saveColWidths();
            }
        });
    })();

    // --- Group hover cross-highlight ---
    document.getElementById("days-container").addEventListener("mouseenter", function (ev) {
        var tr = ev.target.closest("tr[data-group]");
        if (!tr) return;
        var gid = tr.dataset.group;
        var lightColor = GROUP_COLORS_LIGHT[groupColorIndex(gid)];
        var rows = document.querySelectorAll('tr[data-group="' + gid + '"]');
        for (var i = 0; i < rows.length; i++) {
            var tds = rows[i].querySelectorAll("td");
            for (var j = 0; j < tds.length; j++) tds[j].style.background = lightColor;
        }
    }, true);

    document.getElementById("days-container").addEventListener("mouseleave", function (ev) {
        var tr = ev.target.closest("tr[data-group]");
        if (!tr) return;
        var gid = tr.dataset.group;
        var rows = document.querySelectorAll('tr[data-group="' + gid + '"]');
        for (var i = 0; i < rows.length; i++) {
            var tds = rows[i].querySelectorAll("td");
            for (var j = 0; j < tds.length; j++) tds[j].style.background = "";
        }
    }, true);

    // --- Group info popup (ungroup) ---
    function openGroupPopup(anchor, entry) {
        closeGroupPopup();
        var groupEntries = entries.filter(function (e) { return e.group_id === entry.group_id; });
        var total = 0;
        for (var i = 0; i < groupEntries.length; i++) total += groupEntries[i].duration || 0;

        var popup = document.createElement("div");
        popup.className = "group-popup";
        popup.id = "group-popup-active";

        var totalDiv = document.createElement("div");
        totalDiv.className = "group-total";
        totalDiv.textContent = "Group total: " + fmtDuration(total) + " (" + groupEntries.length + " entries)";
        popup.appendChild(totalDiv);

        var ungroupBtn = document.createElement("button");
        ungroupBtn.textContent = "Ungroup this entry";
        ungroupBtn.onclick = function () {
            api("POST", "/api/entries/" + entry.id + "/ungroup").then(function () {
                closeGroupPopup();
                loadEntries();
            });
        };
        popup.appendChild(ungroupBtn);

        document.body.appendChild(popup);

        var rect = anchor.getBoundingClientRect();
        popup.style.left = Math.min(rect.left, window.innerWidth - 180) + "px";
        popup.style.top = (rect.bottom + 4) + "px";

        setTimeout(function () {
            document.addEventListener("mousedown", onGroupPopupOutside);
        }, 0);
    }

    function onGroupPopupOutside(ev) {
        var popup = document.getElementById("group-popup-active");
        if (popup && !popup.contains(ev.target)) closeGroupPopup();
    }

    function closeGroupPopup() {
        var popup = document.getElementById("group-popup-active");
        if (popup) popup.remove();
        document.removeEventListener("mousedown", onGroupPopupOutside);
    }

    // --- Grouping modal ---
    var groupingSourceEntry = null;
    var groupingSuggestions = [];
    var groupingSelectedId = null;

    function openGroupingModal(entry) {
        groupingSourceEntry = entry;
        groupingSelectedId = null;
        document.getElementById("grouping-modal").classList.remove("hidden");
        document.getElementById("grouping-filter").value = "";
        document.getElementById("conflict-section").classList.add("hidden");
        document.getElementById("grouping-suggestions").innerHTML = '<div style="padding:10px;color:var(--muted)">Loading...</div>';

        api("GET", "/api/entries/" + entry.id + "/suggest-links").then(function (data) {
            groupingSuggestions = data;
            renderGroupingSuggestions("");
        });
    }

    function closeGroupingModal() {
        document.getElementById("grouping-modal").classList.add("hidden");
        groupingSourceEntry = null;
        groupingSuggestions = [];
        groupingSelectedId = null;
    }

    function renderGroupingSuggestions(filter) {
        var container = document.getElementById("grouping-suggestions");
        container.innerHTML = "";
        var lower = filter.toLowerCase();

        var filtered = groupingSuggestions.filter(function (e) {
            if (!lower) return true;
            return (e.description || "").toLowerCase().indexOf(lower) >= 0
                || (e.ado_workitem || "").toLowerCase().indexOf(lower) >= 0
                || (e.ado_pr || "").toLowerCase().indexOf(lower) >= 0
                || (e.date || "").indexOf(lower) >= 0;
        });

        if (filtered.length === 0) {
            container.innerHTML = '<div style="padding:10px;color:var(--muted)">No matches</div>';
            return;
        }

        for (var i = 0; i < Math.min(filtered.length, 50); i++) {
            var e = filtered[i];
            var item = document.createElement("div");
            item.className = "suggestion-item";
            if (e.id === groupingSelectedId) item.classList.add("selected");
            item.dataset.entryId = e.id;

            var dateSpan = document.createElement("span");
            dateSpan.className = "s-date";
            dateSpan.textContent = e.date;
            item.appendChild(dateSpan);

            var descSpan = document.createElement("span");
            descSpan.className = "s-desc";
            descSpan.textContent = e.description || "(no description)";
            item.appendChild(descSpan);

            if (e.ado_workitem) {
                var wiSpan = document.createElement("span");
                wiSpan.className = "s-wi";
                wiSpan.textContent = "WI:" + e.ado_workitem;
                item.appendChild(wiSpan);
            }

            if (e.group_id) {
                var gSpan = document.createElement("span");
                gSpan.className = "s-group";
                gSpan.textContent = "\uD83D\uDD17 grouped";
                item.appendChild(gSpan);
            }

            (function (entry) {
                item.onclick = function () {
                    groupingSelectedId = entry.id;
                    renderGroupingSuggestions(document.getElementById("grouping-filter").value);
                    showConflictResolution(entry);
                };
            })(e);

            container.appendChild(item);
        }
    }

    var SHARED_FIELD_LABELS = {
        description: "Description",
        ado_workitem: "Work Item",
        ado_pr: "PR",
        imputation_account_id: "Account",
        imputation_duration: "Imp. Duration"
    };

    function showConflictResolution(target) {
        var section = document.getElementById("conflict-section");
        var fieldsDiv = document.getElementById("conflict-fields");
        fieldsDiv.innerHTML = "";
        var hasDiffs = false;

        var sharedFields = ["description", "ado_workitem", "ado_pr", "imputation_account_id", "imputation_duration"];
        for (var i = 0; i < sharedFields.length; i++) {
            var field = sharedFields[i];
            var srcVal = groupingSourceEntry[field];
            var tgtVal = target[field];

            // Normalize nulls
            if (srcVal === null || srcVal === undefined) srcVal = "";
            if (tgtVal === null || tgtVal === undefined) tgtVal = "";
            if (srcVal == tgtVal) continue;

            hasDiffs = true;
            var row = document.createElement("div");
            row.className = "conflict-row";

            var nameSpan = document.createElement("span");
            nameSpan.className = "field-name";
            nameSpan.textContent = SHARED_FIELD_LABELS[field] || field;
            row.appendChild(nameSpan);

            var srcDisplay = formatFieldValue(field, srcVal);
            var tgtDisplay = formatFieldValue(field, tgtVal);

            // Radio: target value (default)
            var radioName = "conflict-" + field;
            var labelTgt = document.createElement("label");
            var radioTgt = document.createElement("input");
            radioTgt.type = "radio";
            radioTgt.name = radioName;
            radioTgt.value = "target";
            radioTgt.checked = true;
            radioTgt.dataset.field = field;
            radioTgt.dataset.val = JSON.stringify(tgtVal);
            labelTgt.appendChild(radioTgt);
            labelTgt.appendChild(document.createTextNode(" " + (tgtDisplay || "(empty)")));
            row.appendChild(labelTgt);

            // Radio: source value
            var labelSrc = document.createElement("label");
            var radioSrc = document.createElement("input");
            radioSrc.type = "radio";
            radioSrc.name = radioName;
            radioSrc.value = "source";
            radioSrc.dataset.field = field;
            radioSrc.dataset.val = JSON.stringify(srcVal);
            labelSrc.appendChild(radioSrc);
            labelSrc.appendChild(document.createTextNode(" " + (srcDisplay || "(empty)")));
            row.appendChild(labelSrc);

            fieldsDiv.appendChild(row);
        }

        if (hasDiffs) {
            section.classList.remove("hidden");
        } else {
            section.classList.add("hidden");
        }
    }

    function formatFieldValue(field, val) {
        if (field === "imputation_duration" && val) return fmtDuration(val);
        if (field === "imputation_account_id" && val) {
            for (var i = 0; i < accounts.length; i++) {
                if (accounts[i].id == val) return acctLabel(accounts[i]);
            }
            return String(val);
        }
        return String(val || "");
    }

    function applyGroupingLink() {
        if (!groupingSelectedId || !groupingSourceEntry) return;

        // Gather resolution from radio buttons
        var resolution = {};
        var radios = document.querySelectorAll("#conflict-fields input[type=radio]:checked");
        for (var i = 0; i < radios.length; i++) {
            var r = radios[i];
            resolution[r.dataset.field] = JSON.parse(r.dataset.val);
        }

        api("POST", "/api/entries/" + groupingSourceEntry.id + "/link", {
            target_entry_id: groupingSelectedId,
            resolution: resolution
        }).then(function () {
            closeGroupingModal();
            loadEntries();
        });
    }

    // --- Event listeners ---
    document.getElementById("btn-undo").onclick = doUndo;
    document.getElementById("btn-redo").onclick = doRedo;
    document.getElementById("btn-today").onclick = scrollToToday;
    document.getElementById("btn-add").onclick = addEntryToday;
    document.getElementById("btn-add-date").onclick = addEntryForDate;
    document.getElementById("btn-accounts").onclick = openAccountsModal;
    document.getElementById("btn-close-accounts").onclick = closeAccountsModal;
    document.getElementById("btn-add-account").onclick = addAccount;
    document.getElementById("btn-close-grouping").onclick = closeGroupingModal;
    document.getElementById("btn-cancel-link").onclick = closeGroupingModal;
    document.getElementById("btn-apply-link").onclick = applyGroupingLink;
    document.getElementById("grouping-filter").oninput = function () {
        renderGroupingSuggestions(this.value);
    };

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

    // Close modals on backdrop click
    document.getElementById("accounts-modal").onclick = function (ev) {
        if (ev.target === this) closeAccountsModal();
    };
    document.getElementById("grouping-modal").onclick = function (ev) {
        if (ev.target === this) closeGroupingModal();
    };

    // --- Undo / Redo ---
    var FRIENDLY_ACTIONS = {
        create_entry: "create",
        update_entry: "edit",
        delete_entry: "delete",
        duplicate_entry: "duplicate",
        duplicate_link_entry: "duplicate & link",
        ungroup_entry: "ungroup",
        link_entries: "link"
    };

    function showToast(msg) {
        var existing = document.getElementById("undo-toast");
        if (existing) existing.remove();
        var toast = document.createElement("div");
        toast.id = "undo-toast";
        toast.className = "undo-toast";
        toast.textContent = msg;
        document.body.appendChild(toast);
        toast.offsetHeight; // force reflow
        toast.classList.add("visible");
        setTimeout(function () {
            toast.classList.remove("visible");
            setTimeout(function () { toast.remove(); }, 300);
        }, 2000);
    }

    function updateUndoButtons() {
        api("GET", "/api/undo-status").then(function (status) {
            document.getElementById("btn-undo").disabled = !status.can_undo;
            document.getElementById("btn-redo").disabled = !status.can_redo;
        });
    }

    function doUndo() {
        api("POST", "/api/undo").then(function (result) {
            if (result.ok) {
                showToast("Undo: " + (FRIENDLY_ACTIONS[result.action_type] || result.action_type));
                loadEntries();
            }
        });
    }

    function doRedo() {
        api("POST", "/api/redo").then(function (result) {
            if (result.ok) {
                showToast("Redo: " + (FRIENDLY_ACTIONS[result.action_type] || result.action_type));
                loadEntries();
            }
        });
    }

    document.addEventListener("keydown", function (ev) {
        var tag = ev.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        if ((ev.ctrlKey || ev.metaKey) && ev.key === "z" && !ev.shiftKey) {
            ev.preventDefault();
            doUndo();
        }
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || (ev.key === "z" && ev.shiftKey))) {
            ev.preventDefault();
            doRedo();
        }
    });

    // --- Init ---
    loadAccounts().then(function () {
        loadEntries();
    });

})();
