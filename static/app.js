(function () {
    "use strict";

    // --- State ---
    var entries = [];
    var accounts = [];
    var linkTypes = [];
    var filterTerm = "";
    var dropBeforeId = null;  // entry id to drop before (null = end of day)
    var dropIndicatorEl = null; // singleton indicator <tr>
    var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var COL_COUNT = 7; // number of columns in entry tables
    var COL_DEFAULTS = [70, 180, 180, 180, 120, 28, 50];
    var colWidths = (function () {
        try {
            var saved = JSON.parse(localStorage.getItem("colWidths"));
            if (saved && saved.length === COL_DEFAULTS.length) return saved;
            // Migrate from old 8-column layout (drop WI+PR cols at index 2,3, insert ADO Items at 180px)
            if (saved && saved.length === 8) {
                var m = [saved[0], saved[1], 180, saved[4], saved[5], saved[6], saved[7]];
                localStorage.setItem("colWidths", JSON.stringify(m));
                return m;
            }
            // Migrate from old 9-column layout
            if (saved && saved.length === 9) {
                var m2 = [saved[0], saved[1], 180, saved[6], saved[7], saved[8], 50];
                localStorage.setItem("colWidths", JSON.stringify(m2));
                return m2;
            }
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

    // Account table column widths
    var ACCT_COL_COUNT = 6;
    var ACCT_COL_DEFAULTS = [80, 180, 120, 100, 100, 40];
    var acctColWidths = (function () {
        try {
            var saved = JSON.parse(localStorage.getItem("acctColWidths"));
            if (saved && saved.length === ACCT_COL_DEFAULTS.length) return saved;
        } catch (e) {}
        return ACCT_COL_DEFAULTS.slice();
    })();

    function totalAcctColWidth() {
        var s = 0;
        for (var i = 0; i < acctColWidths.length; i++) s += acctColWidths[i];
        return s;
    }

    function saveAcctColWidths() {
        localStorage.setItem("acctColWidths", JSON.stringify(acctColWidths));
    }

    // ADO Links table column widths
    var LT_COL_COUNT = 3;
    var LT_COL_DEFAULTS = [140, 360, 40];
    var ltColWidths = (function () {
        try {
            var saved = JSON.parse(localStorage.getItem("ltColWidths"));
            if (saved && saved.length === LT_COL_DEFAULTS.length) return saved;
        } catch (e) {}
        return LT_COL_DEFAULTS.slice();
    })();

    function totalLtColWidth() {
        var s = 0;
        for (var i = 0; i < ltColWidths.length; i++) s += ltColWidths[i];
        return s;
    }

    function saveLtColWidths() {
        localStorage.setItem("ltColWidths", JSON.stringify(ltColWidths));
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

    function checkSplitsDateWarning(splits, entryDate) {
        if (!splits) return null;
        for (var i = 0; i < splits.length; i++) {
            var s = splits[i];
            if (s.account_open_date && entryDate < s.account_open_date) {
                return "Account " + (s.account_number || "?") + " not yet open (opens " + s.account_open_date + ")";
            }
            if (s.account_close_date && entryDate > s.account_close_date) {
                return "Account " + (s.account_number || "?") + " closed (closed " + s.account_close_date + ")";
            }
        }
        return null;
    }

    // --- Loading overlay ---
    var _apiCount = 0;
    var _overlay = null;

    function showLoading() {
        _apiCount++;
        if (_overlay) return;
        _overlay = document.createElement("div");
        _overlay.className = "loading-overlay";
        var spinner = document.createElement("div");
        spinner.className = "loading-spinner";
        _overlay.appendChild(spinner);
        document.body.appendChild(_overlay);
    }

    function hideLoading() {
        _apiCount = Math.max(0, _apiCount - 1);
        if (_apiCount === 0 && _overlay) {
            _overlay.remove();
            _overlay = null;
        }
    }

    function api(method, path, body) {
        var opts = { method: method, headers: {} };
        if (body !== undefined) {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(body);
        }
        showLoading();
        return fetch(path, opts)
            .then(function (r) { return r.json(); })
            .then(function (data) { hideLoading(); return data; },
                  function (err) { hideLoading(); throw err; });
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

    function loadLinkTypes() {
        return api("GET", "/api/link-types").then(function (data) {
            linkTypes = data;
        });
    }

    function linkTypeAbbrev(title) {
        if (title.length <= 6) return title;
        var words = title.split(/\s+/);
        if (words.length >= 2) {
            return words.map(function (w) { return w[0].toUpperCase(); }).join("");
        }
        return title.slice(0, 4);
    }

    // --- Search filter ---
    function matchesSearch(entry, lower) {
        if (!lower) return true;
        if ((entry.description || "").toLowerCase().indexOf(lower) >= 0) return true;
        if ((entry.notes || "").toLowerCase().indexOf(lower) >= 0) return true;
        var adoItems = entry.ado_items || [];
        for (var ai = 0; ai < adoItems.length; ai++) {
            if ((adoItems[ai].value || "").toLowerCase().indexOf(lower) >= 0) return true;
        }
        return false;
    }

    // --- Find (jump-to-match) ---
    var findTerm = "";
    var findMatches = []; // ordered entry IDs
    var findIdx = -1;

    function openFindBar() {
        document.getElementById("find-bar").classList.remove("hidden");
        var input = document.getElementById("find-input");
        input.focus();
        input.select();
    }

    function closeFindBar() {
        document.getElementById("find-bar").classList.add("hidden");
        document.getElementById("find-input").value = "";
        findTerm = "";
        findMatches = [];
        findIdx = -1;
        clearFindHighlights();
    }

    function clearFindHighlights() {
        var rows = document.querySelectorAll("tr.find-match, tr.find-match-current");
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.remove("find-match", "find-match-current");
        }
    }

    function applyFindHighlights() {
        clearFindHighlights();
        if (!findTerm || findMatches.length === 0) return;
        for (var i = 0; i < findMatches.length; i++) {
            var tr = document.querySelector("tr[data-id='" + findMatches[i] + "']");
            if (tr) tr.classList.add(i === findIdx ? "find-match-current" : "find-match");
        }
    }

    function updateFindCounter() {
        var counter = document.getElementById("find-counter");
        if (!findTerm) {
            counter.textContent = "";
        } else if (findMatches.length === 0) {
            counter.textContent = "0/0";
        } else {
            counter.textContent = (findIdx + 1) + "/" + findMatches.length;
        }
        var input = document.getElementById("find-input");
        if (findTerm && findMatches.length === 0) {
            input.classList.add("no-results");
        } else {
            input.classList.remove("no-results");
        }
    }

    function scrollToCurrentMatch() {
        if (findIdx < 0 || findIdx >= findMatches.length) return;
        var tr = document.querySelector("tr[data-id='" + findMatches[findIdx] + "']");
        if (tr) tr.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function updateFind() {
        findTerm = document.getElementById("find-input").value;
        var lower = findTerm.toLowerCase();
        findMatches = [];
        findIdx = -1;
        if (lower) {
            for (var i = 0; i < entries.length; i++) {
                if (matchesSearch(entries[i], lower)) findMatches.push(entries[i].id);
            }
            if (findMatches.length > 0) findIdx = 0;
        }
        applyFindHighlights();
        updateFindCounter();
        scrollToCurrentMatch();
    }

    function findNext() {
        if (findMatches.length === 0) return;
        findIdx = (findIdx + 1) % findMatches.length;
        applyFindHighlights();
        updateFindCounter();
        scrollToCurrentMatch();
    }

    function findPrev() {
        if (findMatches.length === 0) return;
        findIdx = (findIdx - 1 + findMatches.length) % findMatches.length;
        applyFindHighlights();
        updateFindCounter();
        scrollToCurrentMatch();
    }

    // --- Group entries by date ---
    function groupByDate(arr) {
        arr = arr || entries;
        var groups = [];
        var map = {};
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
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
        var lower = filterTerm.toLowerCase();
        var filtered = lower ? entries.filter(function (e) { return matchesSearch(e, lower); }) : entries;
        var groups = groupByDate(filtered);
        var grandTotal = 0;

        var todayStr = fmtDate(new Date());
        var hasTodayGroup = false;
        for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            if (group.date === todayStr) hasTodayGroup = true;
            var dayTotal = 0;
            for (var i = 0; i < group.entries.length; i++) {
                dayTotal += group.entries[i].duration || 0;
            }
            grandTotal += dayTotal;
            container.appendChild(makeDayGroup(group, dayTotal));
        }

        // Empty placeholder for today if no entries exist (skip when filtering)
        if (!hasTodayGroup && !lower) {
            container.insertBefore(makeTodayPlaceholder(todayStr), container.firstChild);
        }

        document.getElementById("total-label").textContent = "Total: " + fmtDuration(grandTotal);
        applyFindHighlights();
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
        if (group.date === fmtDate(new Date())) {
            var todayLabel = document.createElement("span");
            todayLabel.className = "day-today-label";
            todayLabel.textContent = "(today)";
            dateSpan.appendChild(todayLabel);
        }
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
            ["col-ado", "ADO Items"],
            ["col-imp", "Imputation"],
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
        tbody.addEventListener("dragleave", function (ev) {
            if (!tbody.contains(ev.relatedTarget)) {
                removeDropIndicator();
            }
        });
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
            var beforeId = dropBeforeId;
            removeDropIndicator();
            var raw = ev.dataTransfer.getData("text/plain");
            if (!raw) return;
            var parts = raw.split(":");
            var entryId = parseInt(parts[0]);
            var sourceDate = parts[1] || "";
            var sameDay = sourceDate === group.date;
            showDropMenu(ev.clientX, ev.clientY, entryId, group.date, sameDay, beforeId);
        });

        return div;
    }

    function makeTodayPlaceholder(todayStr) {
        var div = document.createElement("div");
        div.className = "day-group empty-placeholder";
        div.dataset.date = todayStr;

        var hdr = document.createElement("div");
        hdr.className = "day-header";
        var dateSpan = document.createElement("span");
        dateSpan.className = "day-date";
        dateSpan.textContent = dateDisplay(todayStr);
        var todayLabel = document.createElement("span");
        todayLabel.className = "day-today-label";
        todayLabel.textContent = "(today)";
        dateSpan.appendChild(todayLabel);
        var rightSpan = document.createElement("span");
        rightSpan.className = "day-right";
        var addDayBtn = document.createElement("button");
        addDayBtn.className = "btn-add-day";
        addDayBtn.textContent = "+";
        addDayBtn.title = "Add entry for today";
        addDayBtn.onclick = function () {
            api("POST", "/api/entries", { date: todayStr, duration: 0 }).then(loadEntries);
        };
        rightSpan.appendChild(addDayBtn);
        hdr.appendChild(dateSpan);
        hdr.appendChild(rightSpan);
        div.appendChild(hdr);

        var hint = document.createElement("div");
        hint.className = "today-hint";
        hint.textContent = "No entries — drop here or click + to add";
        div.appendChild(hint);

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
            var beforeId = dropBeforeId;
            removeDropIndicator();
            var raw = ev.dataTransfer.getData("text/plain");
            if (!raw) return;
            var parts = raw.split(":");
            var entryId = parseInt(parts[0]);
            var sourceDate = parts[1] || "";
            var sameDay = sourceDate === todayStr;
            showDropMenu(ev.clientX, ev.clientY, entryId, todayStr, sameDay, beforeId);
        });

        return div;
    }

    // --- Drop context menu ---
    function showDropMenu(x, y, entryId, targetDate, sameDay, beforeId) {
        closeDropMenu();

        var menu = document.createElement("div");
        menu.className = "drop-menu";
        menu.style.left = x + "px";
        menu.style.top = y + "px";

        var moveBtn = document.createElement("button");
        moveBtn.textContent = sameDay ? "Reorder here" : "Move here";
        moveBtn.onclick = function () {
            if (sameDay) {
                api("POST", "/api/entries/" + entryId + "/reorder", { before_id: beforeId }).then(loadEntries);
            } else {
                api("POST", "/api/entries/" + entryId, { date: targetDate })
                    .then(function () {
                        return api("POST", "/api/entries/" + entryId + "/reorder", { before_id: beforeId });
                    })
                    .then(loadEntries);
            }
            closeDropMenu();
        };
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

    // --- Drag-drop indicator ---
    function getDropIndicator() {
        if (!dropIndicatorEl) {
            dropIndicatorEl = document.createElement("tr");
            dropIndicatorEl.className = "drop-indicator";
            var td = document.createElement("td");
            td.colSpan = COL_COUNT;
            var line = document.createElement("div");
            line.className = "drop-line";
            td.appendChild(line);
            dropIndicatorEl.appendChild(td);
            // Prevent "forbidden" cursor when hovering over the thin indicator row
            dropIndicatorEl.addEventListener("dragover", function (ev) {
                ev.preventDefault();
            });
        }
        return dropIndicatorEl;
    }

    function removeDropIndicator() {
        if (dropIndicatorEl && dropIndicatorEl.parentNode) {
            dropIndicatorEl.parentNode.removeChild(dropIndicatorEl);
        }
        dropBeforeId = null;
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
            removeDropIndicator();
            var groups = document.querySelectorAll(".day-group.drag-over");
            for (var i = 0; i < groups.length; i++) groups[i].classList.remove("drag-over");
        });
        tr.addEventListener("dragover", function (ev) {
            if (tr.classList.contains("dragging")) return;
            ev.preventDefault();
            var rect = tr.getBoundingClientRect();
            var midY = rect.top + rect.height / 2;
            var indicator = getDropIndicator();
            var tbody = tr.parentNode;
            if (!tbody) return;
            if (ev.clientY < midY) {
                tbody.insertBefore(indicator, tr);
                indicator.className = "drop-indicator drop-indicator-above";
                dropBeforeId = entry.id;
            } else {
                var next = tr.nextElementSibling;
                while (next && next.classList.contains("drop-indicator")) {
                    next = next.nextElementSibling;
                }
                tbody.insertBefore(indicator, next);
                indicator.className = "drop-indicator drop-indicator-below";
                dropBeforeId = next ? parseInt(next.dataset.id) : null;
            }
        });

        // Duration (warning icon for 0:00)
        var durDisplay = fmtDuration(entry.duration);
        if (!entry.duration) durDisplay = "\u26A0 0:00";
        addCell(tr, entry, "duration", durDisplay, "duration-select", !entry.duration ? "zero-warn" : null);
        // Description
        addCell(tr, entry, "description", entry.description || "", "text");
        // ADO Items (inline chips)
        var adoTd = document.createElement("td");
        var adoWrap = document.createElement("div");
        adoWrap.className = "ado-items-cell";
        renderAdoItemsChips(adoWrap, entry);
        adoTd.appendChild(adoWrap);
        tr.appendChild(adoTd);
        // Imputation splits (inline chips)
        var impTd = document.createElement("td");
        var impWrap = document.createElement("div");
        impWrap.className = "splits-cell";
        renderSplitsChips(impWrap, entry);
        impTd.appendChild(impWrap);
        tr.appendChild(impTd);
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

    // --- Splits (inline chips) ---
    function saveSplits(entry, splits) {
        return api("POST", "/api/entries/" + entry.id, { splits: splits }).then(loadEntries);
    }

    function renderSplitsChips(td, entry) {
        td.innerHTML = "";
        var splits = entry.splits || [];
        var warn = checkSplitsDateWarning(splits, entry.date);

        for (var i = 0; i < splits.length; i++) {
            (function (idx) {
                var s = splits[idx];
                var chip = document.createElement("span");
                chip.className = "split-chip";
                chip.title = warn || acctLabel(s);
                var label = (s.account_number || "?") + ": " + fmtDuration(s.duration);
                chip.appendChild(document.createTextNode(label));
                chip.onclick = function (ev) {
                    ev.stopPropagation();
                    openSplitAdder(td, entry, idx);
                };
                td.appendChild(chip);
            })(i);
        }

        var addBtn = document.createElement("span");
        addBtn.className = "split-add";
        addBtn.textContent = "+";
        addBtn.title = "Add imputation split";
        addBtn.onclick = function (ev) {
            ev.stopPropagation();
            openSplitAdder(td, entry, null);
        };
        td.appendChild(addBtn);
    }

    function openSplitAdder(td, entry, editIdx) {
        // editIdx: null = add new, number = edit existing split at that index
        var existing = document.querySelector(".split-adder");
        if (existing) existing.remove();

        var splits = entry.splits || [];
        var editing = editIdx != null ? splits[editIdx] : null;

        // Account IDs already used (exclude the one being edited)
        var usedIds = {};
        for (var u = 0; u < splits.length; u++) {
            if (u !== editIdx) usedIds[splits[u].account_id] = true;
        }

        var adder = document.createElement("div");
        adder.className = "split-adder";

        var acctSel = document.createElement("select");
        var emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = "-- account --";
        acctSel.appendChild(emptyOpt);
        for (var j = 0; j < accounts.length; j++) {
            if (usedIds[accounts[j].id]) continue;
            var opt = document.createElement("option");
            opt.value = accounts[j].id;
            opt.textContent = acctLabel(accounts[j]);
            acctSel.appendChild(opt);
        }
        adder.appendChild(acctSel);

        var durSel = document.createElement("select");
        var emptyDur = document.createElement("option");
        emptyDur.value = "";
        emptyDur.textContent = "--:--";
        durSel.appendChild(emptyDur);
        var opts = durationOptions();
        for (var k = 0; k < opts.length; k++) {
            var dopt = document.createElement("option");
            dopt.value = opts[k].value;
            dopt.textContent = opts[k].label;
            durSel.appendChild(dopt);
        }
        adder.appendChild(durSel);

        var rmBtn = document.createElement("button");
        rmBtn.className = "adder-rm";
        rmBtn.title = "Delete";
        rmBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5.3 4V2.7a1.3 1.3 0 011.3-1.3h2.8a1.3 1.3 0 011.3 1.3V4M13 4v9.3a1.3 1.3 0 01-1.3 1.3H4.3A1.3 1.3 0 013 13.3V4"/></svg>';
        rmBtn.onclick = function (ev) {
            ev.stopPropagation();
            var updated = splits.filter(function (_, j) { return j !== editIdx; })
                .map(function (s) { return { account_id: s.account_id, duration: s.duration }; });
            adder.remove();
            document.removeEventListener("mousedown", closeAdderOutside);
            saveSplits(entry, updated);
        };
        adder.appendChild(rmBtn);

        if (editing) {
            acctSel.value = String(editing.account_id);
            durSel.value = String(editing.duration);
        } else {
            durSel.style.display = "none";
            rmBtn.style.display = "none";
        }

        function commitIfReady() {
            if (!acctSel.value || !durSel.value) return;
            var current = splits.map(function (s) {
                return { account_id: s.account_id, duration: s.duration };
            });
            var newSplit = { account_id: parseInt(acctSel.value), duration: parseInt(durSel.value) };
            if (editing) {
                current[editIdx] = newSplit;
            } else {
                current.push(newSplit);
            }
            adder.remove();
            document.removeEventListener("mousedown", closeAdderOutside);
            saveSplits(entry, current);
        }

        acctSel.onchange = function () {
            if (acctSel.value) {
                durSel.style.display = "";
                // Re-clamp after duration select appears
                var ar = adder.getBoundingClientRect();
                if (ar.right > window.innerWidth) {
                    adder.style.left = Math.max(0, window.innerWidth - ar.width - 4) + "px";
                }
                if (!editing) durSel.focus();
                else commitIfReady();
            }
        };

        durSel.onchange = function () {
            commitIfReady();
        };

        // Position below the cell, clamped to viewport
        var rect = td.getBoundingClientRect();
        adder.style.left = rect.left + "px";
        adder.style.top = (rect.bottom + 2) + "px";
        document.body.appendChild(adder);
        // Clamp so the adder doesn't overflow the right/bottom edge
        var ar = adder.getBoundingClientRect();
        if (ar.right > window.innerWidth) {
            adder.style.left = Math.max(0, window.innerWidth - ar.width - 4) + "px";
        }
        if (ar.bottom > window.innerHeight) {
            adder.style.top = Math.max(0, rect.top - ar.height - 2) + "px";
        }
        acctSel.focus();

        // Close on outside click
        setTimeout(function () {
            document.addEventListener("mousedown", closeAdderOutside);
        }, 0);

        function closeAdderOutside(ev) {
            if (!adder.contains(ev.target)) {
                adder.remove();
                document.removeEventListener("mousedown", closeAdderOutside);
            }
        }
    }

    // --- ADO Items (inline chips) ---
    function saveAdoItems(entry, items) {
        return api("POST", "/api/entries/" + entry.id, { ado_items: items }).then(loadEntries);
    }

    function renderAdoItemsChips(td, entry) {
        td.innerHTML = "";
        var items = entry.ado_items || [];

        for (var i = 0; i < items.length; i++) {
            (function (idx) {
                var a = items[idx];
                var chip = document.createElement("span");
                chip.className = "ado-chip";
                var abbrev = linkTypeAbbrev(a.link_type_title || "?");
                var label = abbrev + ": " + a.value;
                chip.title = (a.link_type_title || "?") + ": " + a.value;
                if (a.link_type_url_template) {
                    chip.title += "\nCtrl+click to open link";
                }
                chip.appendChild(document.createTextNode(label));
                chip.onclick = function (ev) {
                    ev.stopPropagation();
                    if ((ev.ctrlKey || ev.metaKey) && a.link_type_url_template) {
                        var url = a.link_type_url_template.replace("{value}", encodeURIComponent(a.value));
                        window.open(url, "_blank");
                        return;
                    }
                    openAdoItemAdder(td, entry, idx);
                };
                td.appendChild(chip);
            })(i);
        }

        var addBtn = document.createElement("span");
        addBtn.className = "ado-add";
        addBtn.textContent = "+";
        addBtn.title = "Add ADO item";
        addBtn.onclick = function (ev) {
            ev.stopPropagation();
            openAdoItemAdder(td, entry, null);
        };
        td.appendChild(addBtn);
    }

    function openAdoItemAdder(td, entry, editIdx) {
        var existing = document.querySelector(".ado-item-adder");
        if (existing) existing.remove();

        var items = entry.ado_items || [];
        var editing = editIdx != null ? items[editIdx] : null;

        var adder = document.createElement("div");
        adder.className = "ado-item-adder";

        // Link type select
        var typeSel = document.createElement("select");
        var emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = "-- type --";
        typeSel.appendChild(emptyOpt);
        for (var j = 0; j < linkTypes.length; j++) {
            var opt = document.createElement("option");
            opt.value = linkTypes[j].id;
            opt.textContent = linkTypes[j].title;
            typeSel.appendChild(opt);
        }
        adder.appendChild(typeSel);

        // Value input
        var valInput = document.createElement("input");
        valInput.type = "text";
        valInput.placeholder = "value";
        adder.appendChild(valInput);

        var rmBtn = document.createElement("button");
        rmBtn.className = "adder-rm";
        rmBtn.title = "Delete";
        rmBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5.3 4V2.7a1.3 1.3 0 011.3-1.3h2.8a1.3 1.3 0 011.3 1.3V4M13 4v9.3a1.3 1.3 0 01-1.3 1.3H4.3A1.3 1.3 0 013 13.3V4"/></svg>';
        rmBtn.onclick = function (ev) {
            ev.stopPropagation();
            var updated = items.filter(function (_, j) { return j !== editIdx; })
                .map(function (a) { return { link_type_id: a.link_type_id, value: a.value }; });
            adder.remove();
            document.removeEventListener("mousedown", closeAdderOutside);
            saveAdoItems(entry, updated);
        };
        adder.appendChild(rmBtn);

        if (editing) {
            typeSel.value = String(editing.link_type_id);
            valInput.value = editing.value;
        } else {
            valInput.style.display = "none";
            rmBtn.style.display = "none";
        }

        function commitIfReady() {
            if (!typeSel.value || !valInput.value.trim()) return;
            var current = items.map(function (a) {
                return { link_type_id: a.link_type_id, value: a.value };
            });
            var newItem = { link_type_id: parseInt(typeSel.value), value: valInput.value.trim() };
            if (editing) {
                current[editIdx] = newItem;
            } else {
                current.push(newItem);
            }
            adder.remove();
            document.removeEventListener("mousedown", closeAdderOutside);
            saveAdoItems(entry, current);
        }

        typeSel.onchange = function () {
            if (typeSel.value) {
                valInput.style.display = "";
                // Re-clamp after input appears
                var ar = adder.getBoundingClientRect();
                if (ar.right > window.innerWidth) {
                    adder.style.left = Math.max(0, window.innerWidth - ar.width - 4) + "px";
                }
                valInput.focus();
                if (editing) valInput.select();
            }
        };

        valInput.onkeydown = function (ev) {
            if (ev.key === "Enter") {
                ev.preventDefault();
                commitIfReady();
            } else if (ev.key === "Escape") {
                adder.remove();
                document.removeEventListener("mousedown", closeAdderOutside);
            }
        };

        valInput.onblur = function () {
            setTimeout(function () {
                if (adder.parentNode && !adder.contains(document.activeElement)) {
                    commitIfReady();
                    adder.remove();
                    document.removeEventListener("mousedown", closeAdderOutside);
                }
            }, 100);
        };

        // Position below the cell, clamped to viewport
        var rect = td.getBoundingClientRect();
        adder.style.left = rect.left + "px";
        adder.style.top = (rect.bottom + 2) + "px";
        document.body.appendChild(adder);
        var ar = adder.getBoundingClientRect();
        if (ar.right > window.innerWidth) {
            adder.style.left = Math.max(0, window.innerWidth - ar.width - 4) + "px";
        }
        if (ar.bottom > window.innerHeight) {
            adder.style.top = Math.max(0, rect.top - ar.height - 2) + "px";
        }
        if (editing) {
            valInput.focus();
            valInput.select();
        } else {
            typeSel.focus();
        }

        // Close on outside click
        setTimeout(function () {
            document.addEventListener("mousedown", closeAdderOutside);
        }, 0);

        function closeAdderOutside(ev) {
            if (!adder.contains(ev.target)) {
                adder.remove();
                document.removeEventListener("mousedown", closeAdderOutside);
            }
        }
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

    // --- View switching ---
    function switchView(view) {
        if (view !== "entries") {
            filterTerm = "";
            document.getElementById("filter-entries").value = "";
            closeFindBar();
        }
        document.getElementById("view-entries").classList.toggle("hidden", view !== "entries");
        document.getElementById("view-accounts").classList.toggle("hidden", view !== "accounts");
        document.getElementById("view-imputations").classList.toggle("hidden", view !== "imputations");
        document.getElementById("view-ado-links").classList.toggle("hidden", view !== "ado-links");
        document.getElementById("toolbar-entries").classList.toggle("hidden", view !== "entries");
        document.getElementById("toolbar-accounts").classList.toggle("hidden", view !== "accounts");
        document.getElementById("toolbar-imputations").classList.toggle("hidden", view !== "imputations");
        document.getElementById("toolbar-ado-links").classList.toggle("hidden", view !== "ado-links");
        document.getElementById("view-select").value = view;
        if (view === "accounts") renderAccounts();
        if (view === "entries") loadEntries();
        if (view === "imputations") renderImputationReport();
        if (view === "ado-links") renderLinkTypes();
    }

    function renderAccounts() {
        loadAccounts().then(function () {
            var table = document.getElementById("accounts-table");
            table.style.tableLayout = "fixed";
            table.style.width = totalAcctColWidth() + "px";

            // Rebuild colgroup
            var oldCg = table.querySelector("colgroup");
            if (oldCg) oldCg.remove();
            var colgroup = document.createElement("colgroup");
            for (var ci = 0; ci < ACCT_COL_COUNT; ci++) {
                var col = document.createElement("col");
                col.style.width = acctColWidths[ci] + "px";
                colgroup.appendChild(col);
            }
            table.insertBefore(colgroup, table.firstChild);

            // Rebuild thead with resize handles
            var oldThead = table.querySelector("thead");
            if (oldThead) oldThead.remove();
            var thead = document.createElement("thead");
            var headerRow = document.createElement("tr");
            var acctCols = ["Number", "Description", "Project", "Open", "Close", ""];
            for (var c = 0; c < acctCols.length; c++) {
                var th = document.createElement("th");
                th.textContent = acctCols[c];
                if (c < acctCols.length - 1) {
                    var handle = document.createElement("div");
                    handle.className = "col-resize";
                    handle.dataset.colIndex = c;
                    th.appendChild(handle);
                }
                headerRow.appendChild(th);
            }
            thead.appendChild(headerRow);
            table.insertBefore(thead, table.querySelector("tbody"));

            var tbody = document.getElementById("accounts-body");
            tbody.innerHTML = "";
            for (var i = 0; i < accounts.length; i++) {
                tbody.appendChild(makeAccountRow(accounts[i]));
            }

            applyAcctColWidths();
        });
    }

    function applyAcctColWidths() {
        var table = document.getElementById("accounts-table");
        if (!table) return;
        var w = totalAcctColWidth();
        table.style.width = w + "px";
        var cols = table.querySelectorAll("colgroup col");
        for (var i = 0; i < cols.length; i++) {
            cols[i].style.width = acctColWidths[i] + "px";
        }
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

    // --- Account table column resize ---
    (function () {
        var resizing = false, startX = 0, colIdx = 0, startW = 0;

        document.getElementById("accounts-table").addEventListener("mousedown", function (ev) {
            if (!ev.target.classList.contains("col-resize")) return;
            ev.preventDefault();
            resizing = true;
            colIdx = parseInt(ev.target.dataset.colIndex);
            startX = ev.clientX;
            startW = acctColWidths[colIdx];
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        });

        document.addEventListener("mousemove", function (ev) {
            if (!resizing) return;
            var delta = ev.clientX - startX;
            acctColWidths[colIdx] = Math.max(30, startW + delta);
            applyAcctColWidths();
        });

        document.addEventListener("mouseup", function () {
            if (!resizing) return;
            resizing = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            saveAcctColWidths();
        });

        document.getElementById("accounts-table").addEventListener("dblclick", function (ev) {
            if (!ev.target.classList.contains("col-resize")) return;
            ev.preventDefault();
            var ci = parseInt(ev.target.dataset.colIndex);
            var available = document.documentElement.clientWidth
                - parseFloat(getComputedStyle(document.querySelector("main")).paddingLeft) * 2;
            var tw = totalAcctColWidth();
            if (tw < available) {
                acctColWidths[ci] = acctColWidths[ci] + (available - tw);
                applyAcctColWidths();
                saveAcctColWidths();
            }
        });
    })();

    // --- ADO Links table column resize ---
    (function () {
        var resizing = false, startX = 0, colIdx = 0, startW = 0;

        document.getElementById("ado-links-table").addEventListener("mousedown", function (ev) {
            if (!ev.target.classList.contains("col-resize")) return;
            ev.preventDefault();
            resizing = true;
            colIdx = parseInt(ev.target.dataset.colIndex);
            startX = ev.clientX;
            startW = ltColWidths[colIdx];
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        });

        document.addEventListener("mousemove", function (ev) {
            if (!resizing) return;
            var delta = ev.clientX - startX;
            ltColWidths[colIdx] = Math.max(30, startW + delta);
            applyLtColWidths();
        });

        document.addEventListener("mouseup", function () {
            if (!resizing) return;
            resizing = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            saveLtColWidths();
        });

        document.getElementById("ado-links-table").addEventListener("dblclick", function (ev) {
            if (!ev.target.classList.contains("col-resize")) return;
            ev.preventDefault();
            var ci = parseInt(ev.target.dataset.colIndex);
            var available = document.documentElement.clientWidth
                - parseFloat(getComputedStyle(document.querySelector("main")).paddingLeft) * 2;
            var tw = totalLtColWidth();
            if (tw < available) {
                ltColWidths[ci] = ltColWidths[ci] + (available - tw);
                applyLtColWidths();
                saveLtColWidths();
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
            if ((e.description || "").toLowerCase().indexOf(lower) >= 0) return true;
            if ((e.date || "").indexOf(lower) >= 0) return true;
            var adoItems = e.ado_items || [];
            for (var ai = 0; ai < adoItems.length; ai++) {
                if ((adoItems[ai].value || "").toLowerCase().indexOf(lower) >= 0) return true;
            }
            return false;
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

            var adoItems = e.ado_items || [];
            for (var ai = 0; ai < adoItems.length; ai++) {
                var adoSpan = document.createElement("span");
                adoSpan.className = "s-ado";
                adoSpan.textContent = linkTypeAbbrev(adoItems[ai].link_type_title || "?") + ":" + adoItems[ai].value;
                item.appendChild(adoSpan);
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
        description: "Description"
    };

    function showConflictResolution(target) {
        var section = document.getElementById("conflict-section");
        var fieldsDiv = document.getElementById("conflict-fields");
        fieldsDiv.innerHTML = "";
        var hasDiffs = false;

        var sharedFields = ["description"];
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

    // --- Imputation report ---
    var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
    var MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var reportMonth = (function () {
        var d = new Date();
        return { year: d.getFullYear(), month: d.getMonth() };
    })();

    function reportMonthLabel() {
        return MONTH_NAMES[reportMonth.month] + " " + reportMonth.year;
    }

    function reportMonthRange() {
        var y = reportMonth.year, m = reportMonth.month;
        var first = new Date(y, m, 1);
        var last = new Date(y, m + 1, 0);
        return { from: fmtDate(first), to: fmtDate(last) };
    }

    function renderImputationReport() {
        var range = reportMonthRange();
        document.getElementById("imp-month-label").textContent = reportMonthLabel();
        api("GET", "/api/entries?from=" + range.from + "&to=" + range.to).then(function (data) {
            // Aggregate: { date -> { account_id -> { duration, number, label } } }
            var dayMap = {};
            for (var i = 0; i < data.length; i++) {
                var e = data[i];
                var splits = e.splits || [];
                for (var j = 0; j < splits.length; j++) {
                    var s = splits[j];
                    if (!dayMap[e.date]) dayMap[e.date] = {};
                    var key = s.account_id;
                    if (!dayMap[e.date][key]) {
                        dayMap[e.date][key] = {
                            duration: 0,
                            number: s.account_number || "?",
                            label: acctLabel(s)
                        };
                    }
                    dayMap[e.date][key].duration += s.duration;
                }
            }

            // Sort dates ascending
            var dates = Object.keys(dayMap).sort();

            // Build table
            var thead = document.getElementById("imp-report-head");
            var tbody = document.getElementById("imp-report-body");
            var tfoot = document.getElementById("imp-report-foot");
            thead.innerHTML = "";
            tbody.innerHTML = "";
            tfoot.innerHTML = "";

            // Header
            var hr = document.createElement("tr");
            var cols = ["Date", "Account", "Duration"];
            for (var c = 0; c < cols.length; c++) {
                var th = document.createElement("th");
                th.textContent = cols[c];
                hr.appendChild(th);
            }
            thead.appendChild(hr);

            var grandTotal = 0;

            for (var d = 0; d < dates.length; d++) {
                var dt = dates[d];
                var accts = dayMap[dt];
                // Sort accounts by number
                var acctIds = Object.keys(accts).sort(function (a, b) {
                    return accts[a].number.localeCompare(accts[b].number);
                });

                // Compute day total first
                var dayTotal = 0;
                for (var a = 0; a < acctIds.length; a++) {
                    dayTotal += accts[acctIds[a]].duration;
                }
                grandTotal += dayTotal;

                // Day header row: date label + day total
                var dayTr = document.createElement("tr");
                dayTr.className = "imp-day-header";
                if (d > 0) dayTr.classList.add("imp-day-gap");
                var dayDateTd = document.createElement("td");
                dayDateTd.textContent = dateDisplay(dt);
                dayDateTd.className = "imp-date";
                dayTr.appendChild(dayDateTd);
                dayTr.appendChild(document.createElement("td"));
                var dayDurTd = document.createElement("td");
                dayDurTd.textContent = fmtDuration(dayTotal);
                dayDurTd.className = "imp-dur";
                dayTr.appendChild(dayDurTd);
                tbody.appendChild(dayTr);

                // Account entry rows under the day header
                for (var a = 0; a < acctIds.length; a++) {
                    var aid = acctIds[a];
                    var info = accts[aid];

                    var tr = document.createElement("tr");
                    tr.className = "imp-entry";
                    // First cell: copy button (left of row)
                    var firstTd = document.createElement("td");
                    firstTd.className = "imp-copy-cell";
                    (function(number, td) {
                        var copyBtn = document.createElement("button");
                        copyBtn.className = "imp-copy-btn";
                        copyBtn.title = "Copy account number: " + number;
                        copyBtn.textContent = "\u29c9"; // ⧉
                        copyBtn.addEventListener("click", function(e) {
                            e.stopPropagation();
                            navigator.clipboard.writeText(number);
                            var bubble = document.createElement("span");
                            bubble.className = "imp-copy-bubble";
                            bubble.textContent = "Copied";
                            td.appendChild(bubble);
                            setTimeout(function() { bubble.remove(); }, 1000);
                        });
                        td.appendChild(copyBtn);
                    }(info.number, firstTd));
                    tr.appendChild(firstTd);
                    // Account
                    var acctTd = document.createElement("td");
                    acctTd.textContent = info.label;
                    tr.appendChild(acctTd);
                    // Duration
                    var durTd = document.createElement("td");
                    durTd.textContent = fmtDuration(info.duration);
                    durTd.className = "imp-dur";
                    tr.appendChild(durTd);

                    tbody.appendChild(tr);
                }
            }

            // Grand total
            var footTr = document.createElement("tr");
            footTr.className = "imp-grand-total";
            var footDateTd = document.createElement("td");
            footDateTd.textContent = "Month total";
            footTr.appendChild(footDateTd);
            footTr.appendChild(document.createElement("td"));
            var footDurTd = document.createElement("td");
            footDurTd.textContent = fmtDuration(grandTotal);
            footDurTd.className = "imp-dur";
            footTr.appendChild(footDurTd);
            tfoot.appendChild(footTr);

            if (dates.length === 0) {
                var emptyTr = document.createElement("tr");
                var emptyTd = document.createElement("td");
                emptyTd.colSpan = 3;
                emptyTd.textContent = "No imputation data for this month.";
                emptyTd.className = "imp-empty";
                emptyTr.appendChild(emptyTd);
                tbody.appendChild(emptyTr);
            }
        });
    }

    function impPrevMonth() {
        reportMonth.month--;
        if (reportMonth.month < 0) { reportMonth.month = 11; reportMonth.year--; }
        renderImputationReport();
    }

    function impNextMonth() {
        reportMonth.month++;
        if (reportMonth.month > 11) { reportMonth.month = 0; reportMonth.year++; }
        renderImputationReport();
    }

    function openMonthPicker() {
        var existing = document.querySelector(".month-picker");
        if (existing) { existing.remove(); return; }

        var pickerYear = reportMonth.year;
        var picker = document.createElement("div");
        picker.className = "month-picker";

        function render() {
            picker.innerHTML = "";
            var header = document.createElement("div");
            header.className = "mp-header";
            var prevBtn = document.createElement("button");
            prevBtn.textContent = "\u25C0";
            prevBtn.onclick = function () { pickerYear--; render(); };
            var yearLabel = document.createElement("span");
            yearLabel.textContent = pickerYear;
            var nextBtn = document.createElement("button");
            nextBtn.textContent = "\u25B6";
            nextBtn.onclick = function () { pickerYear++; render(); };
            header.appendChild(prevBtn);
            header.appendChild(yearLabel);
            header.appendChild(nextBtn);
            picker.appendChild(header);

            var grid = document.createElement("div");
            grid.className = "mp-grid";
            for (var m = 0; m < 12; m++) {
                var btn = document.createElement("button");
                btn.textContent = MONTH_SHORT[m];
                if (pickerYear === reportMonth.year && m === reportMonth.month) {
                    btn.className = "mp-current";
                }
                (function (month) {
                    btn.onclick = function () {
                        reportMonth.year = pickerYear;
                        reportMonth.month = month;
                        picker.remove();
                        document.removeEventListener("mousedown", closePickerOutside);
                        renderImputationReport();
                    };
                })(m);
                grid.appendChild(btn);
            }
            picker.appendChild(grid);
        }

        render();

        var label = document.getElementById("imp-month-label");
        var rect = label.getBoundingClientRect();
        picker.style.left = rect.left + "px";
        picker.style.top = (rect.bottom + 4) + "px";
        document.body.appendChild(picker);

        function closePickerOutside(ev) {
            if (!picker.contains(ev.target) && ev.target !== label) {
                picker.remove();
                document.removeEventListener("mousedown", closePickerOutside);
            }
        }
        setTimeout(function () {
            document.addEventListener("mousedown", closePickerOutside);
        }, 0);
    }

    // --- ADO Links view ---
    function applyLtColWidths() {
        var table = document.getElementById("ado-links-table");
        if (!table) return;
        table.style.width = totalLtColWidth() + "px";
        var cols = table.querySelectorAll("colgroup col");
        for (var i = 0; i < cols.length; i++) {
            cols[i].style.width = ltColWidths[i] + "px";
        }
    }

    function renderLinkTypes() {
        loadLinkTypes().then(function () {
            var table = document.getElementById("ado-links-table");
            table.style.tableLayout = "fixed";
            table.style.width = totalLtColWidth() + "px";

            // Rebuild colgroup
            var oldCg = table.querySelector("colgroup");
            if (oldCg) oldCg.remove();
            var colgroup = document.createElement("colgroup");
            for (var ci = 0; ci < LT_COL_COUNT; ci++) {
                var col = document.createElement("col");
                col.style.width = ltColWidths[ci] + "px";
                colgroup.appendChild(col);
            }
            table.insertBefore(colgroup, table.firstChild);

            // Rebuild thead with resize handles
            var oldThead = table.querySelector("thead");
            if (oldThead) oldThead.remove();
            var thead = document.createElement("thead");
            var headerRow = document.createElement("tr");
            var ltCols = ["Title", "URL Template", ""];
            for (var c = 0; c < ltCols.length; c++) {
                var th = document.createElement("th");
                th.textContent = ltCols[c];
                if (c < ltCols.length - 1) {
                    var handle = document.createElement("div");
                    handle.className = "col-resize";
                    handle.dataset.colIndex = c;
                    th.appendChild(handle);
                }
                headerRow.appendChild(th);
            }
            thead.appendChild(headerRow);
            table.insertBefore(thead, table.querySelector("tbody"));

            var tbody = document.getElementById("ado-links-body");
            tbody.innerHTML = "";
            for (var i = 0; i < linkTypes.length; i++) {
                tbody.appendChild(makeLinkTypeRow(linkTypes[i]));
            }
        });
    }

    function makeLinkTypeRow(lt) {
        var tr = document.createElement("tr");

        function makeField(field, placeholder) {
            var td = document.createElement("td");
            var inp = document.createElement("input");
            inp.value = lt[field] || "";
            if (placeholder) inp.placeholder = placeholder;
            inp.onblur = function () {
                if (inp.value !== (lt[field] || "")) {
                    var data = {};
                    data[field] = inp.value;
                    api("POST", "/api/link-types/" + lt.id, data).then(function () {
                        loadLinkTypes();
                    });
                }
            };
            inp.onkeydown = function (ev) { if (ev.key === "Enter") inp.blur(); };
            td.appendChild(inp);
            tr.appendChild(td);
        }

        makeField("title", "Title");
        makeField("url_template", "e.g. https://dev.azure.com/.../{value}");

        var tdAct = document.createElement("td");
        var btn = document.createElement("button");
        btn.className = "btn-row btn-delete";
        btn.textContent = "\u00d7";
        btn.title = "Delete link type";
        btn.onclick = function () {
            if (confirm("Delete link type \"" + lt.title + "\"? This will remove all ADO items using this type.")) {
                api("POST", "/api/link-types/" + lt.id + "/delete").then(renderLinkTypes);
            }
        };
        tdAct.appendChild(btn);
        tr.appendChild(tdAct);

        return tr;
    }

    function addLinkType() {
        api("POST", "/api/link-types", { title: "New type" }).then(renderLinkTypes);
    }

    // --- Event listeners ---
    document.getElementById("btn-undo").onclick = doUndo;
    document.getElementById("btn-redo").onclick = doRedo;
    document.getElementById("btn-today").onclick = scrollToToday;
    document.getElementById("btn-add").onclick = addEntryToday;
    document.getElementById("btn-add-date").onclick = addEntryForDate;
    document.getElementById("btn-add-account").onclick = addAccount;
    document.getElementById("btn-add-link-type").onclick = addLinkType;
    document.getElementById("btn-imp-prev").onclick = impPrevMonth;
    document.getElementById("btn-imp-next").onclick = impNextMonth;
    document.getElementById("imp-month-label").onclick = openMonthPicker;
    document.getElementById("view-select").onchange = function () { switchView(this.value); };
    document.getElementById("btn-close-grouping").onclick = closeGroupingModal;
    document.getElementById("btn-cancel-link").onclick = closeGroupingModal;
    document.getElementById("btn-apply-link").onclick = applyGroupingLink;
    document.getElementById("grouping-filter").oninput = function () {
        renderGroupingSuggestions(this.value);
    };
    document.getElementById("filter-entries").oninput = function () {
        filterTerm = this.value;
        renderDays();
    };
    document.getElementById("filter-entries").onkeydown = function (ev) {
        if (ev.key === "Escape") { this.value = ""; filterTerm = ""; renderDays(); this.blur(); }
    };
    document.getElementById("find-input").oninput = function () { updateFind(); };
    document.getElementById("find-input").onkeydown = function (ev) {
        if (ev.key === "Enter") {
            ev.preventDefault();
            if (ev.shiftKey) findPrev(); else findNext();
        } else if (ev.key === "Escape") {
            closeFindBar();
        }
    };
    document.getElementById("find-next").onclick = findNext;
    document.getElementById("find-prev").onclick = findPrev;
    document.getElementById("find-close").onclick = closeFindBar;

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
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "f") {
            var currentView = document.getElementById("view-select").value;
            if (currentView === "entries") {
                ev.preventDefault();
                openFindBar();
                return;
            }
        }
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
    Promise.all([loadAccounts(), loadLinkTypes()]).then(function () {
        loadEntries();
    });

})();
