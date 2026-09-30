/* Event Lottery — app shell, state, rendering. Rules live in lottery.js. */
(function () {
  "use strict";

  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  var STORE_KEY = "event-lottery-v1";
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  var TABS = ["draw", "tickets", "history", "more"];

  var STATUS_META = {
    "active": { label: "Active", emoji: "🎟" },
    "close": { label: "Getting Close", emoji: "🔥" },
    "very-close": { label: "Very Close", emoji: "🚨" },
    "one-left": { label: "ONE LEFT", emoji: "👀" },
    "winner": { label: "Winner", emoji: "🏆" },
    "eliminated": { label: "Missed", emoji: "✕" }
  };

  var BANNER_META = {
    neutral: { emoji: "🎟" },
    interesting: { emoji: "👀" },
    close: { emoji: "🔥" },
    "one-ticket": { emoji: "🚨" },
    won: { emoji: "🎉" }
  };

  /* Draw-screen order: closest to winning first, missed ones last. */
  var CLOSENESS_RANK = {
    "winner": 0,
    "one-left": 1,
    "very-close": 2,
    "close": 3,
    "active": 4,
    "eliminated": 5
  };

  /* ---------- Storage ---------- */

  var storage = (function () {
    try {
      var k = "__el_test__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) { return null; }
  })();

  function freshState() {
    return {
      version: 1,
      tickets: [],
      called: [],
      settings: { sound: true, vibration: true },
      savedAt: 0,
      welcomeSeen: false,
      tab: "tickets",
      savedNoteShown: false,
      scanFormat: ""
    };
  }

  function loadState() {
    var fresh = freshState();
    if (!storage) return fresh;
    try {
      var raw = storage.getItem(STORE_KEY);
      if (!raw) return fresh;
      var data = JSON.parse(raw);
      return {
        version: 1,
        tickets: Array.isArray(data.tickets)
          ? data.tickets.filter(function (t) { return t && t.id && typeof t.num === "string" && /^\d{1,12}$/.test(t.num); })
              .map(function (t) { return { id: String(t.id), num: t.num }; })
          : [],
        called: Array.isArray(data.called)
          ? data.called.filter(function (d) { return typeof d === "string" && /^[0-9]$/.test(d); })
          : [],
        settings: {
          sound: !(data.settings && data.settings.sound === false),
          vibration: !(data.settings && data.settings.vibration === false)
        },
        savedAt: typeof data.savedAt === "number" ? data.savedAt : 0,
        welcomeSeen: !!data.welcomeSeen,
        tab: TABS.indexOf(data.tab) !== -1 ? data.tab : "tickets",
        savedNoteShown: !!data.savedNoteShown,
        scanFormat: typeof data.scanFormat === "string" && /^\d{1,2}$/.test(data.scanFormat)
          ? data.scanFormat
          : ""
      };
    } catch (e) { return fresh; }
  }

  var quotaWarned = false;

  function saveState() {
    state.savedAt = Date.now();
    if (demoMode) return;
    if (!storage) {
      if (!quotaWarned) {
        quotaWarned = true;
        toast("Storage unavailable — data won't survive a refresh", { variant: "warn" });
      }
      return;
    }
    try {
      storage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      if (!quotaWarned) {
        quotaWarned = true;
        toast("Couldn't save — device storage is full", { variant: "error" });
      }
    }
  }

  /* ---------- State ---------- */

  var state = loadState();
  var demoMode = false;
  var demoVariant = null;
  var editingId = null;
  var pendingBulk = null;
  var prevMatched = new Map(); // ticket id -> matched[] from previous call render

  /* ---------- Elements ---------- */

  var welcome = $("#screen-welcome");
  var screenDraw = $("#screen-draw");
  var nav = $("#bottom-nav");
  var navBtns = $$(".nav-btn", nav);

  var ticketInput = $("#ticket-input");
  var fieldError = $("#field-error");
  var ticketList = $("#ticket-list");
  var ticketsEmpty = $("#tickets-empty");
  var ticketCountChip = $("#ticket-count-chip");
  var bulkPanel = $("#bulk-panel");
  var bulkInput = $("#bulk-input");
  var bulkSummary = $("#bulk-summary");
  var bulkPreview = $("#bulk-preview");
  var bulkAddBtn = $("#btn-bulk-add");
  var btnStartDraw = $("#btn-start-draw");

  var ball = $("#ball");
  var ballDigit = $("#ball-digit");
  var ballCaption = $("#ball-caption");
  var ballRing = $("#ball-ring");
  var banner = $("#banner");
  var bannerEmoji = $("#banner-emoji");
  var bannerTitle = $("#banner-title");
  var bannerSub = $("#banner-sub");
  var strip = $("#strip");
  var miniList = $("#mini-list");
  var miniEmpty = $("#mini-empty");
  var keypad = $("#keypad");
  var btnUndo = $("#btn-undo");
  var btnNewDraw = $("#btn-new-draw");
  var btnUndoHistory = $("#btn-undo-history");
  var btnSoundQuick = $("#btn-sound-quick");
  var demoChip = $("#demo-chip");

  var historyGrid = $("#history-grid");
  var historyEmpty = $("#history-empty");
  var historyCountChip = $("#history-count-chip");

  var swSound = $("#sw-sound");
  var swVibration = $("#sw-vibration");

  var winnerOverlay = $("#winner-overlay");
  var expiryOverlay = $("#expiry-overlay");
  var scanOverlay = $("#scan-overlay");
  var winnerTickets = $("#winner-tickets");
  var winnerSub = $("#winner-sub");
  var toastRegion = $("#toast-region");

  /* ---------- Helpers ---------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function buzz(pattern) {
    if (state.settings.vibration) FX.buzz(pattern);
  }

  function existingNums() {
    return new Set(state.tickets.map(function (t) { return t.num; }));
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function relTime(ts) {
    if (!ts) return "—";
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "Just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  /* ---------- Toasts ---------- */

  function toast(msg, opts) {
    opts = opts || {};
    while (toastRegion.children.length >= 2) toastRegion.firstChild.remove();
    var t = document.createElement("div");
    t.className = "toast " + (opts.variant || "ok");
    var msgEl = document.createElement("span");
    msgEl.textContent = msg;
    t.appendChild(msgEl);
    var dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      t.classList.add("out");
      setTimeout(function () { t.remove(); }, 260);
    }
    if (opts.action) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "toast-action";
      b.textContent = opts.action;
      b.addEventListener("click", function () {
        dismiss();
        if (opts.onAction) opts.onAction();
      });
      t.appendChild(b);
    }
    toastRegion.appendChild(t);
    setTimeout(dismiss, opts.action ? 4500 : 2600);
  }

  /* ---------- Two-tap destructive confirm ---------- */

  function bindTwoTap(btn, fn) {
    var timer = 0;
    btn.addEventListener("click", function () {
      if (!btn.classList.contains("armed")) {
        btn.dataset.label = btn.textContent;
        btn.textContent = "Sure?";
        btn.classList.add("armed");
        clearTimeout(timer);
        timer = setTimeout(reset, 2400);
      } else {
        reset();
        fn();
      }
    });
    function reset() {
      clearTimeout(timer);
      btn.classList.remove("armed");
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  /* ---------- Overlays ---------- */

  var lastFocus = null;

  function openOverlay(ov) {
    lastFocus = document.activeElement;
    ov.hidden = false;
    var target = $("[data-autofocus]", ov) || $("button", ov);
    if (target) target.focus();
  }

  function closeOverlay(ov) {
    if (ov.hidden) return;
    ov.hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  document.addEventListener("keydown", function (e) {
    var open = [winnerOverlay, expiryOverlay, scanOverlay].filter(function (o) { return !o.hidden; })[0];
    if (!open) return;
    /* Escape closes these two; the expiry prompt needs an explicit choice. */
    if (e.key === "Escape" && open !== expiryOverlay) {
      if (open === scanOverlay) closeScan();
      else closeOverlay(winnerOverlay);
      return;
    }
    if (e.key === "Tab") {
      var focusables = $$("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])", open)
        .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Rendering: tickets screen ---------- */

  function ticketStatus(ticket) {
    return Lottery.calculateTicketState(ticket, state.called);
  }

  function badgeText(status) {
    var meta = STATUS_META[status] || STATUS_META.active;
    return (meta.emoji ? meta.emoji + " " : "") + meta.label;
  }

  function buildDigits(num, matched, missedAt) {
    var wrap = document.createElement("span");
    wrap.className = "ticket-digits";
    wrap.setAttribute("aria-hidden", "true");
    String(num).split("").forEach(function (d, i) {
      var tile = document.createElement("span");
      tile.className = "td" + (matched[i] ? " hit" : i === missedAt ? " miss" : "");
      tile.textContent = d;
      wrap.appendChild(tile);
    });
    return wrap;
  }

  function ariaFor(ticket, st) {
    if (st.status === "eliminated") {
      return "Ticket " + ticket.num + ": missed after " + st.matchedCount +
        " digits, out of the draw";
    }
    return "Ticket " + ticket.num + ": " + st.matchedCount + " of " +
      st.digits.length + " matched, " + (STATUS_META[st.status] || STATUS_META.active).label;
  }

  function renderTicketsScreen() {
    editingId = null;
    ticketCountChip.textContent = String(state.tickets.length);
    ticketsEmpty.hidden = state.tickets.length > 0;
    btnStartDraw.disabled = state.tickets.length === 0;
    ticketList.textContent = "";

    // Winners on top, then live tickets, missed ones at the bottom —
    // each group keeps its original order.
    function groupRank(t) {
      var s = ticketStatus(t).status;
      if (s === "winner") return 0;
      if (s === "eliminated") return 2;
      return 1;
    }
    var ordered = state.tickets.slice().sort(function (a, b) {
      return groupRank(a) - groupRank(b);
    });

    ordered.forEach(function (t) {
      var st = ticketStatus(t);
      var li = document.createElement("li");
      li.className = "ticket-card status-" + st.status;
      li.dataset.id = t.id;
      li.setAttribute("aria-label", ariaFor(t, st));

      var main = document.createElement("div");
      main.className = "ticket-main";
      main.appendChild(buildDigits(t.num, st.matched, st.missedAt));

      var meta = document.createElement("div");
      meta.className = "ticket-meta";
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = badgeText(st.status);
      var progress = document.createElement("span");
      progress.className = "progress";
      progress.textContent = st.matchedCount + "/" + st.digits.length;
      meta.appendChild(badge);
      meta.appendChild(progress);
      main.appendChild(meta);
      li.appendChild(main);

      var actions = document.createElement("div");
      actions.className = "ticket-actions";

      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "icon-btn";
      editBtn.setAttribute("aria-label", "Edit ticket " + t.num);
      editBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4L8 20l-4.6 1L4.5 16.4z"/></svg>';
      editBtn.addEventListener("click", function () { startEdit(t.id); });

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "icon-btn";
      delBtn.setAttribute("aria-label", "Delete ticket " + t.num);
      delBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2m-7 0 1 13h6l1-13"/></svg>';
      delBtn.addEventListener("click", function () { deleteTicket(t.id, li); });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      li.appendChild(actions);
      ticketList.appendChild(li);
    });
    prevMatched.clear();
  }

  function startEdit(id) {
    editingId = id;
    var li = ticketList.querySelector('[data-id="' + id + '"]');
    if (!li) return;
    var ticket = state.tickets.filter(function (t) { return t.id === id; })[0];
    if (!ticket) return;

    li.textContent = "";
    var row = document.createElement("div");
    row.className = "edit-row";

    var input = document.createElement("input");
    input.type = "text";
    input.className = "field";
    input.inputMode = "numeric";
    input.maxLength = Lottery.MAX_LEN;
    input.value = ticket.num;
    input.setAttribute("aria-label", "Edit ticket number");

    var err = document.createElement("span");
    err.className = "field-error";
    err.hidden = true;
    err.style.margin = "0";

    var save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-gold";
    save.textContent = "Save";

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function () { renderTicketsScreen(); });

    function commit() {
      var others = new Set(state.tickets.filter(function (t) { return t.id !== id; }).map(function (t) { return t.num; }));
      var res = Lottery.validateNumber(input.value, others);
      if (!res.ok) {
        err.textContent = editErrorMessage(res.reason);
        err.hidden = false;
        FX.audio.error();
        return;
      }
      ticket.num = res.num;
      saveState();
      renderTicketsScreen();
      renderMiniList(false);
      toast("Ticket updated");
    }
    save.addEventListener("click", commit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") renderTicketsScreen();
    });

    row.appendChild(input);
    row.appendChild(save);
    row.appendChild(cancel);
    li.appendChild(row);
    li.appendChild(err);
    input.focus();
    input.select();
  }

  function deleteTicket(id, li) {
    var idx = -1;
    for (var i = 0; i < state.tickets.length; i++) {
      if (state.tickets[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;

    function remove() {
      var removed = state.tickets.splice(idx, 1)[0];
      saveState();
      renderTicketsScreen();
      renderMiniList(false);
      renderMoreStats();
      toast("Ticket " + removed.num + " deleted", {
        variant: "warn",
        action: "Undo",
        onAction: function () {
          var at = Math.min(idx, state.tickets.length);
          state.tickets.splice(at, 0, removed);
          saveState();
          renderTicketsScreen();
          renderMiniList(false);
          renderMoreStats();
        }
      });
    }

    if (li) {
      li.classList.add("removing");
      setTimeout(remove, 200);
    } else {
      remove();
    }
  }

  function editErrorMessage(reason) {
    switch (reason) {
      case "empty": return "Type a ticket number first.";
      case "not-numeric": return "Numbers only, e.g. 161648";
      case "too-short": return "Too short — at least " + Lottery.MIN_LEN + " digits.";
      case "too-long": return "Too long — up to " + Lottery.MAX_LEN + " digits.";
      case "duplicate": return "That number is already on your list.";
      default: return "That number doesn't look right.";
    }
  }

  function addSingleTicket() {
    fieldError.hidden = true;
    var res = Lottery.validateNumber(ticketInput.value, existingNums());
    if (!res.ok) {
      fieldError.textContent = editErrorMessage(res.reason);
      fieldError.hidden = false;
      FX.audio.error();
      return;
    }
    state.tickets.push({ id: uid(), num: res.num });
    ticketInput.value = "";
    saveState();
    renderTicketsScreen();
    renderMiniList(false);
    renderMoreStats();
    FX.audio.close();
    toast("Ticket " + res.num + " added");
    if (!state.savedNoteShown) {
      state.savedNoteShown = true;
      saveState();
      setTimeout(function () {
        toast("Your tickets are saved on this device");
      }, 700);
    }
  }

  /* ---------- Bulk entry ---------- */

  function refreshBulk() {
    pendingBulk = Lottery.parseBulkInput(bulkInput.value, existingNums());
    var res = pendingBulk;

    bulkSummary.textContent = "";
    bulkPreview.textContent = "";
    var hasContent = res.valid.length + res.duplicates.length + res.invalid.length > 0;
    bulkSummary.hidden = !hasContent;
    bulkPreview.hidden = !hasContent;
    bulkAddBtn.disabled = res.valid.length === 0;
    if (!hasContent) return;

    function line(cls, text) {
      var s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      bulkSummary.appendChild(s);
    }
    if (res.valid.length) line("ok", "✓ " + plural(res.valid.length, "ticket") + " ready");
    if (res.duplicates.length) line("warn", "⚠ " + plural(res.duplicates.length, "duplicate"));
    if (res.invalid.length) line("bad", "⚠ " + plural(res.invalid.length, "invalid number"));

    var REASON = {
      "not-numeric": "not a number",
      "too-short": "too short",
      "too-long": "too long"
    };
    var chips = [];
    res.valid.forEach(function (n) { chips.push(["ok", "✓ " + n, ""]); });
    res.duplicates.forEach(function (n) { chips.push(["dup", "⚠ " + n, "already on your list"]); });
    res.invalid.forEach(function (v) { chips.push(["bad", "✗ " + v.raw, REASON[v.reason] || "invalid"]); });
    chips.slice(0, 60).forEach(function (c) {
      var chip = document.createElement("span");
      chip.className = "chip " + c[0];
      chip.textContent = c[1];
      if (c[2]) chip.title = c[2];
      bulkPreview.appendChild(chip);
    });
    if (chips.length > 60) {
      var more = document.createElement("span");
      more.className = "chip";
      more.textContent = "+" + (chips.length - 60) + " more";
      bulkPreview.appendChild(more);
    }
  }

  function addBulkTickets() {
    if (!pendingBulk || !pendingBulk.valid.length) return;
    pendingBulk.valid.forEach(function (num) {
      state.tickets.push({ id: uid(), num: num });
    });
    var note = [];
    if (pendingBulk.duplicates.length) note.push(plural(pendingBulk.duplicates.length, "duplicate") + " skipped");
    if (pendingBulk.invalid.length) note.push(plural(pendingBulk.invalid.length, "invalid") + " ignored");
    saveState();
    bulkInput.value = "";
    refreshBulk();
    bulkPanel.hidden = true;
    $("#btn-toggle-bulk").setAttribute("aria-expanded", "false");
    renderTicketsScreen();
    renderMiniList(false);
    renderMoreStats();
    FX.audio.close();
    toast("Added " + plural(pendingBulk.valid.length, "ticket") + (note.length ? " · " + note.join(", ") : ""));
  }

  /* ---------- Scan entry (OCR in scan.js) ---------- */

  function openScan() {
    openOverlay(scanOverlay);
    Scan.open({
      existing: existingNums(),
      initialFormat: state.scanFormat,
      onAdd: addScannedTickets,
      onClose: closeScan,
      toast: toast
    });
  }

  function closeScan() {
    Scan.close();
    closeOverlay(scanOverlay);
  }

  function addScannedTickets(nums, format) {
    if (!nums.length) return;
    nums.forEach(function (num) {
      state.tickets.push({ id: uid(), num: num });
    });
    if (format) {
      state.scanFormat = format;
    }
    saveState();
    renderTicketsScreen();
    renderMiniList(false);
    renderMoreStats();
    FX.audio.close();
    toast("Added " + plural(nums.length, "ticket"));
  }

  /* ---------- Rendering: draw screen ---------- */

  function renderBanner() {
    var sum = Lottery.summarize(state.tickets, state.called);
    var meta = BANNER_META[sum.level] || BANNER_META.neutral;
    bannerEmoji.textContent = meta.emoji;

    var last = state.called.length ? state.called[state.called.length - 1] : null;

    if (!state.tickets.length) {
      bannerTitle.textContent = state.called.length
        ? plural(state.called.length, "number") + " called"
        : "Ready to play";
      bannerSub.textContent = state.called.length
        ? "Add tickets to track the draw"
        : "Tap numbers below as you hear them";
    } else if (sum.level === "won") {
      bannerTitle.textContent = "YOU WON!";
      bannerSub.textContent = plural(sum.winners, "winning ticket") + " · " +
        plural(sum.alive, "ticket") + " still alive";
    } else if (sum.alive === 0 && sum.eliminated > 0) {
      bannerEmoji.textContent = "💔";
      bannerTitle.textContent = "All tickets missed";
      bannerSub.textContent = "The draw went another way — undo a number if it was mis-entered";
    } else if (sum.level === "one-ticket") {
      bannerTitle.textContent = "ONE TICKET LEFT!";
      bannerSub.textContent = "One ticket still matches the draw";
    } else if (sum.level === "close") {
      bannerTitle.textContent = "YOU'RE GETTING CLOSE!";
      bannerSub.textContent = plural(sum.alive, "ticket") + " still alive";
    } else if (sum.level === "interesting") {
      bannerTitle.textContent = "It's getting interesting...";
      bannerSub.textContent = plural(sum.alive, "ticket") + " still alive";
    } else {
      bannerTitle.textContent = plural(sum.alive, "ticket") + " alive";
      bannerSub.textContent = last
        ? "Last number: " + last + " · " + plural(state.called.length, "call") + " so far"
        : "Waiting for the first number";
    }

    banner.className = "banner lv-" + sum.level;

    // Every ticket has missed and nothing is left to play for — light up
    // "New draw" as the next move. Undoing the missing digit clears it.
    btnNewDraw.classList.toggle(
      "cta",
      state.called.length > 0 &&
      sum.total > 0 &&
      sum.eliminated === sum.total
    );
  }

  function renderStrip() {
    strip.textContent = "";
    if (!state.called.length) {
      var ph = document.createElement("li");
      ph.className = "strip-placeholder";
      ph.textContent = "Called numbers will appear here";
      strip.appendChild(ph);
      return;
    }
    // Call order, left to right — the strip spells out the number like the
    // announcement. Latest call sits at the end, highlighted; keep it in view.
    state.called.slice(-16).forEach(function (d) {
      var li = document.createElement("li");
      li.className = "strip-item";
      li.setAttribute("aria-hidden", "true");
      li.textContent = d;
      strip.appendChild(li);
    });
    strip.scrollLeft = strip.scrollWidth;
  }

  function renderMiniList(popNew) {
    miniList.textContent = "";
    miniEmpty.hidden = state.tickets.length > 0;
    var next = new Map();

    // Sorted by closeness so the most interesting ticket is always the
    // first row, even when only a row or two fits above the keypad.
    // Ties keep the original order (Array.sort is stable).
    var ordered = state.tickets.slice().sort(function (a, b) {
      return CLOSENESS_RANK[ticketStatus(a).status] - CLOSENESS_RANK[ticketStatus(b).status];
    });

    ordered.forEach(function (t) {
      var st = ticketStatus(t);
      next.set(t.id, st.matched.slice());

      var li = document.createElement("li");
      li.className = "mini status-" + st.status;
      li.setAttribute("aria-label", ariaFor(t, st));

      var digits = document.createElement("span");
      digits.className = "mini-digits";
      digits.setAttribute("aria-hidden", "true");
      st.digits.forEach(function (d, i) {
        var tile = document.createElement("span");
        tile.className = "td" + (st.matched[i] ? " hit" : i === st.missedAt ? " miss" : "");
        tile.textContent = d;
        if (popNew && st.matched[i]) {
          var before = prevMatched.get(t.id);
          if (!before || !before[i]) tile.classList.add("pop");
        }
        digits.appendChild(tile);
      });
      li.appendChild(digits);

      var badge = document.createElement("span");
      badge.className = "mini-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = (STATUS_META[st.status] || STATUS_META.active).label;
      li.appendChild(badge);

      miniList.appendChild(li);
    });

    prevMatched = next;
  }

  function renderDrawScreen(popNew) {
    var hasCalls = state.called.length > 0;
    screenDraw.classList.toggle("has-calls", hasCalls);
    ball.classList.toggle("idle", !hasCalls);
    ballDigit.textContent = hasCalls ? state.called[state.called.length - 1] : "–";
    ballCaption.textContent = hasCalls ? "Called now" : "Tap each number as it is announced";
    renderBanner();
    renderStrip();
    renderMiniList(!!popNew);
    btnUndo.disabled = !hasCalls;
    btnNewDraw.disabled = !hasCalls;
  }

  /* Clear the called numbers so the next draw can start. Undoable. */
  function clearDraw() {
    if (!state.called.length) return;
    var previous = state.called.slice();
    state.called = [];
    saveState();
    closeOverlay(winnerOverlay);
    renderDrawScreen(false);
    if (!$("#screen-history").hidden) renderHistoryScreen();
    renderMoreStats();
    FX.audio.clear();
    buzz(15);
    toast("Numbers cleared — ready for the next draw", {
      variant: "warn",
      action: "Undo",
      onAction: function () {
        // True undo of the clear: the previous round replaces whatever
        // was entered after it.
        state.called = previous;
        saveState();
        renderDrawScreen(false);
        if (!$("#screen-history").hidden) renderHistoryScreen();
        renderMoreStats();
      }
    });
  }

  function animateBall(d) {
    if (FX.prefersReducedMotion() || !ball.animate) return;
    if (ball.getAnimations) ball.getAnimations().forEach(function (a) { a.cancel(); });
    ball.animate([
      { transform: "scale(0.55)" },
      { transform: "scale(1.14)", offset: 0.6 },
      { transform: "scale(1)" }
    ], { duration: 300, easing: "cubic-bezier(0.2, 1.4, 0.35, 1)" });
    ballRing.animate([
      { opacity: 0.9, transform: "scale(1)" },
      { opacity: 0, transform: "scale(1.8)" }
    ], { duration: 550, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" });
  }

  /* ---------- Draw actions ---------- */

  /* Winners right now, as a comparable signature of ticket ids. */
  function winnerSignature() {
    return state.tickets
      .filter(function (t) {
        return Lottery.calculateTicketState(t, state.called).status === "winner";
      })
      .map(function (t) { return t.id; })
      .sort()
      .join(",");
  }

  function callDigit(d) {
    FX.audio.unlock();
    var beforeWinners = winnerSignature();
    var before = Lottery.summarize(state.tickets, state.called);
    state.called.push(d);
    var after = Lottery.summarize(state.tickets, state.called);
    saveState();

    FX.audio.call(Number(d));
    buzz(12);
    animateBall(d);
    renderDrawScreen(true);
    // Hidden screens re-render on tab switch anyway — skip them per call.
    if (!$("#screen-history").hidden) renderHistoryScreen();
    renderMoreStats();

    if (after.eliminated > before.eliminated) {
      // Tickets just dropped out — one soft note regardless of how many.
      FX.audio.miss();
      buzz(18);
    } else if (after.level !== before.level && after.level === "close") {
      FX.audio.close();
      buzz([30, 40, 30]);
    } else if (after.level !== before.level && after.level === "one-ticket") {
      FX.audio.oneLeft();
      buzz([40, 60, 40, 60, 90]);
    }
    // Celebrate whenever the winning ticket changes — including a new
    // ticket taking over from one the draw continued past.
    if (winnerSignature() !== beforeWinners) celebrate();
  }

  function undoCall() {
    if (!state.called.length) return;
    var d = state.called.pop();
    saveState();
    closeOverlay(winnerOverlay);
    renderDrawScreen(false);
    if (!$("#screen-history").hidden) renderHistoryScreen();
    renderMoreStats();
    buzz(8);
    toast("Removed " + d + " — draw restored", { variant: "warn" });
  }

  /* ---------- Winner ---------- */

  function celebrate() {
    var winners = state.tickets.filter(function (t) {
      return Lottery.calculateTicketState(t, state.called).status === "winner";
    });
    winnerTickets.textContent = "";
    winners.forEach(function (t) {
      var card = document.createElement("div");
      card.className = "win-ticket";
      var label = document.createElement("span");
      label.className = "win-ticket-label";
      label.textContent = "🏆 Winning ticket";
      card.appendChild(label);
      var allMatched = t.num.split("").map(function () { return true; });
      card.appendChild(buildDigits(t.num, allMatched, -1));
      winnerTickets.appendChild(card);
    });
    winnerSub.textContent = winners.length === 1
      ? "Every digit has been called. Legendary."
      : plural(winners.length, "ticket") + " hit every called digit.";
    openOverlay(winnerOverlay);
    FX.audio.win();
    buzz([80, 60, 80, 60, 240]);
    FX.confetti.burst(160);
  }

  /* ---------- Rendering: history ---------- */

  function renderHistoryScreen() {
    historyCountChip.textContent = String(state.called.length);
    historyGrid.textContent = "";
    historyEmpty.hidden = state.called.length > 0;
    btnUndoHistory.disabled = !state.called.length;
    for (var i = state.called.length - 1; i >= 0; i--) {
      var li = document.createElement("li");
      li.className = "hist-item";
      var n = document.createElement("span");
      n.className = "hist-n";
      n.textContent = "#" + (i + 1);
      var d = document.createElement("span");
      d.className = "hist-digit";
      d.textContent = state.called[i];
      li.appendChild(n);
      li.appendChild(d);
      historyGrid.appendChild(li);
    }
  }

  /* ---------- Rendering: more ---------- */

  function renderMoreStats() {
    $("#more-tickets-count").textContent = String(state.tickets.length);
    $("#more-calls-count").textContent = String(state.called.length);
    $("#more-saved").textContent = relTime(state.savedAt);
  }

  function renderMoreScreen() {
    swSound.setAttribute("aria-checked", String(state.settings.sound));
    swVibration.setAttribute("aria-checked", String(state.settings.vibration));
    $("#more-storage-note").textContent = storage
      ? "Everything is stored only on this device and expires 7 days after your last visit."
      : "This browser blocks local storage, so data will only last for this visit.";
    renderMoreStats();
  }

  function syncSoundControls() {
    btnSoundQuick.setAttribute("aria-pressed", String(state.settings.sound));
    btnSoundQuick.setAttribute("aria-label", state.settings.sound ? "Sound is on" : "Sound is off");
    swSound.setAttribute("aria-checked", String(state.settings.sound));
  }

  /* ---------- Routing ---------- */

  function show(tab) {
    if (TABS.indexOf(tab) === -1) tab = "tickets";
    state.tab = tab;
    saveState();
    TABS.forEach(function (t) {
      $("#screen-" + t).hidden = t !== tab;
    });
    navBtns.forEach(function (b) {
      if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (tab === "draw") FX.wakeLock.acquire();
    else FX.wakeLock.release();
    if (tab === "tickets") renderTicketsScreen();
    if (tab === "draw") renderDrawScreen(false);
    if (tab === "history") renderHistoryScreen();
    if (tab === "more") renderMoreScreen();
  }

  function showWelcome() {
    welcome.hidden = false;
    nav.hidden = true;
    TABS.forEach(function (t) { $("#screen-" + t).hidden = true; });
  }

  function enterApp() {
    welcome.hidden = true;
    nav.hidden = false;
    show(state.tab || "tickets");
  }

  /* ---------- Expiry ---------- */

  function isExpired() {
    return !!state.savedAt &&
      Date.now() - state.savedAt > WEEK_MS &&
      (state.tickets.length > 0 || state.called.length > 0);
  }

  function wipeEventData() {
    state.tickets = [];
    state.called = [];
    state.welcomeSeen = false;
    state.tab = "tickets";
    saveState();
    closeOverlay(winnerOverlay);
    showWelcome();
  }

  /* ---------- Demo mode (for previews and support) ---------- */

  function applyDemo() {
    var params = new URLSearchParams(window.location.search);
    var v = params.get("demo");
    if (v === null) return;
    demoMode = true;
    demoVariant = v === "win" ? "win" : "play";
    demoChip.hidden = false;
    state = freshState();
    state.welcomeSeen = true;
    var tab = params.get("tab");
    if (TABS.indexOf(tab) !== -1) state.tab = tab;
    state.tickets = ["161648", "927315", "481623", "837291", "123456", "654321"].map(function (num) {
      return { id: uid(), num: num };
    });
    if (v === "fresh") state.called = [];
    else if (v === "win") state.called = ["1", "6", "1", "6", "4", "8"]; // spells 161648
    else state.called = ["1", "6", "1"]; // 161648 still alive, the rest missed
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    $("#btn-welcome-start").addEventListener("click", function () {
      state.welcomeSeen = true;
      saveState();
      enterApp();
    });

    nav.addEventListener("click", function (e) {
      var btn = e.target.closest(".nav-btn");
      if (btn) show(btn.dataset.tab);
    });

    // Tickets: single add
    $("#btn-add-ticket").addEventListener("click", addSingleTicket);
    ticketInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addSingleTicket(); }
    });
    ticketInput.addEventListener("input", function () { fieldError.hidden = true; });

    // Tickets: bulk
    $("#btn-toggle-bulk").addEventListener("click", function () {
      var open = bulkPanel.hidden;
      bulkPanel.hidden = !open;
      this.setAttribute("aria-expanded", String(open));
      if (open) bulkInput.focus();
    });
    bulkInput.addEventListener("input", refreshBulk);
    bulkAddBtn.addEventListener("click", addBulkTickets);
    $("#btn-bulk-cancel").addEventListener("click", function () {
      bulkInput.value = "";
      refreshBulk();
      bulkPanel.hidden = true;
      $("#btn-toggle-bulk").setAttribute("aria-expanded", "false");
    });

    // Tickets: photo scan (OCR)
    $("#btn-open-scan").addEventListener("click", openScan);

    bindTwoTap($("#btn-clear-all"), function () {
      state.tickets = [];
      saveState();
      renderTicketsScreen();
      renderMiniList(false);
      renderMoreStats();
      toast("All tickets cleared", { variant: "warn" });
    });

    btnStartDraw.addEventListener("click", function () { show("draw"); });
    $("#btn-mini-add").addEventListener("click", function () { show("tickets"); });

    // Draw
    keypad.addEventListener("click", function (e) {
      var key = e.target.closest(".key");
      if (key) callDigit(key.dataset.digit);
    });
    keypad.addEventListener("pointerdown", function (e) {
      var key = e.target.closest(".key");
      if (key) {
        key.classList.add("pressed");
        FX.audio.unlock();
      }
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      keypad.addEventListener(ev, function (e) {
        var key = e.target.closest(".key");
        if (key) key.classList.remove("pressed");
      });
    });
    btnUndo.addEventListener("click", undoCall);
    btnNewDraw.addEventListener("click", clearDraw);
    btnUndoHistory.addEventListener("click", undoCall);
    btnSoundQuick.addEventListener("click", function () {
      setSound(!state.settings.sound);
    });

    // History
    $("#btn-history-goto-draw").addEventListener("click", function () { show("draw"); });

    // More
    swSound.addEventListener("click", function () { setSound(!state.settings.sound); });
    swVibration.addEventListener("click", function () {
      state.settings.vibration = !state.settings.vibration;
      saveState();
      swVibration.setAttribute("aria-checked", String(state.settings.vibration));
      if (state.settings.vibration) buzz(30);
    });
    bindTwoTap($("#btn-reset-draw"), function () {
      clearDraw();
    });
    bindTwoTap($("#btn-delete-all"), wipeEventData);

    // Winner overlay
    $("#btn-winner-continue").addEventListener("click", function () { closeOverlay(winnerOverlay); });
    $("#btn-winner-tickets").addEventListener("click", function () {
      closeOverlay(winnerOverlay);
      show("tickets");
    });
    $("[data-close]", winnerOverlay).addEventListener("click", function () { closeOverlay(winnerOverlay); });

    // Expiry overlay
    $("#btn-expiry-fresh").addEventListener("click", function () {
      wipeEventData();
      toast("Ready for a fresh event");
    });
    $("#btn-expiry-keep").addEventListener("click", function () {
      saveState(); // refreshes savedAt so the timer restarts
      closeOverlay(expiryOverlay);
      if (state.welcomeSeen) enterApp();
    });

    // Unlock audio on the first interaction (autoplay policies)
    document.addEventListener("pointerdown", function () { FX.audio.unlock(); }, { once: true, capture: true });
  }

  function setSound(on) {
    state.settings.sound = !!on;
    FX.audio.setEnabled(state.settings.sound);
    saveState();
    syncSoundControls();
  }

  function renderAll() {
    syncSoundControls();
    renderTicketsScreen();
    renderDrawScreen(false);
    renderHistoryScreen();
    renderMoreScreen();
  }

  /* ---------- Init ---------- */

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () { /* offline is a bonus */ });
    });
  }

  function init() {
    bindEvents();
    applyDemo();
    FX.audio.setEnabled(state.settings.sound);

    if (isExpired() && !demoMode) {
      showWelcome();
      openOverlay(expiryOverlay);
    } else if (state.welcomeSeen) {
      enterApp();
      if (demoMode && demoVariant === "win") celebrate();
    } else {
      showWelcome();
    }

    renderAll();
    registerSW();
  }

  init();
})();
