/* Photo scan — OCR pipeline and ticket-number matching.
   Pure logic (format parsing, number extraction) is exported for tests;
   everything DOM/Tesseract lives in browser-only functions that never run
   at load time. Storage stays in app.js: results leave via onAdd(). */
(function (root, factory) {
  var api = factory();
  root.Scan = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var Lottery = typeof self !== "undefined" && self.Lottery
    ? self.Lottery
    : (typeof require === "function" ? require("./lottery.js") : null);

  var MIN_LEN = (Lottery && Lottery.MIN_LEN) || 3;
  var MAX_LEN = (Lottery && Lottery.MAX_LEN) || 12;

  var TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  /* Printed ticket digits must stay ~40px tall after scaling or OCR recall
     collapses — cap the long side high (3200) rather than shrinking photos. */
  var SCAN_MAX_SIDE = 3200;
  var THUMB_MAX_SIDE = 144;   // preview tile inside the overlay
  var CHIP_CAP = 60;          // same preview cap as bulk paste

  /* ============================================================
     Pure core — no DOM, covered by test/scan.test.cjs
     ============================================================ */

  /* The ticket format is just the digit count: "6" matches every 6-digit
     number — 161642, 131314, anything. Internally that is an all-wildcard
     pattern, where each "x" accepts any digit. */
  function parseLength(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return { ok: false, reason: "empty" };
    if (!/^\d{1,2}$/.test(s)) return { ok: false, reason: "chars" };
    var n = parseInt(s, 10);
    if (n < MIN_LEN) return { ok: false, reason: "too-short" };
    if (n > MAX_LEN) return { ok: false, reason: "too-long" };
    return { ok: true, digits: n, pattern: patternForDigits(n) };
  }

  function patternForDigits(n) {
    var pattern = "";
    for (var i = 0; i < n; i++) pattern += "x";
    return pattern;
  }

  function matchesPattern(run, pattern) {
    if (!run || !pattern || run.length !== pattern.length) return false;
    for (var i = 0; i < pattern.length; i++) {
      if (pattern.charAt(i) !== "x" && pattern.charAt(i) !== run.charAt(i)) {
        return false;
      }
    }
    return true;
  }

  /* Every digit run in OCR text that matches the pattern exactly.
     Runs longer than the pattern (two ticket numbers fused together by a
     missing separator) are swept with a greedy non-overlapping window.
     No fuzzy matching on purpose: a misread number is dropped, never guessed. */
  function extractNumbers(text, pattern) {
    var found = [];
    var seen = {};
    if (!pattern) return found;
    String(text == null ? "" : text).replace(/[0-9]+/g, function (run) {
      if (run.length === pattern.length) {
        if (matchesPattern(run, pattern) && !seen[run]) {
          seen[run] = true;
          found.push(run);
        }
      } else if (run.length > pattern.length) {
        for (var i = 0; i + pattern.length <= run.length;) {
          var win = run.slice(i, i + pattern.length);
          if (matchesPattern(win, pattern)) {
            if (!seen[win]) {
              seen[win] = true;
              found.push(win);
            }
            i += pattern.length;
          } else {
            i += 1;
          }
        }
      }
      return run;
    });
    return found;
  }

  /* Split found numbers against what the user already has. Pattern matches
     are numeric and length-valid by construction, so no invalid bucket. */
  function classifyFound(nums, existingNums) {
    var seen = existingNums instanceof Set ? new Set(existingNums) : new Set(existingNums || []);
    var valid = [];
    var duplicates = [];
    (nums || []).forEach(function (n) {
      if (seen.has(n)) duplicates.push(n);
      else {
        valid.push(n);
        seen.add(n);
      }
    });
    return { valid: valid, duplicates: duplicates };
  }

  /* ============================================================
     Browser-only scan session
     ============================================================ */

  var el = {};
  var uiBound = false;
  var session = null;        // active session (null when the overlay is closed)
  var sessionSeq = 0;        // never repeats, so stale chains can't alias a new session
  var tesseractPromise = null;
  var sharedCanvas = null;   // reused for every photo, one at a time

  function bindUi() {
    if (uiBound) return;
    uiBound = true;

    el.overlay = document.getElementById("scan-overlay");
    el.scrim = el.overlay.querySelector("[data-close-scan]");
    el.close = document.getElementById("btn-scan-close");
    el.stepFormat = document.getElementById("scan-step-format");
    el.stepPhotos = document.getElementById("scan-step-photos");
    el.stepReview = document.getElementById("scan-step-review");
    el.format = document.getElementById("scan-format");
    el.formatError = document.getElementById("scan-format-error");
    el.choosePhotos = document.getElementById("btn-scan-choose");
    el.camera = document.getElementById("btn-scan-camera");
    el.fileInput = document.getElementById("scan-file-input");
    el.cameraInput = document.getElementById("scan-camera-input");
    el.patternLabel = document.getElementById("scan-pattern-label");
    el.thumbs = document.getElementById("scan-thumbs");
    el.run = document.getElementById("btn-scan-run");
    el.addMore = document.getElementById("btn-scan-add-more");
    el.editFormat = document.getElementById("btn-scan-edit-format");
    el.progress = document.getElementById("scan-progress");
    el.barFill = document.getElementById("scan-bar-fill");
    el.progressText = document.getElementById("scan-progress-text");
    el.summary = document.getElementById("scan-summary");
    el.preview = document.getElementById("scan-preview");
    el.add = document.getElementById("btn-scan-add");
    el.back = document.getElementById("btn-scan-back");

    el.format.addEventListener("input", updateFormatUi);
    el.choosePhotos.addEventListener("click", function () { el.fileInput.click(); });
    el.camera.addEventListener("click", function () { el.cameraInput.click(); });
    el.fileInput.addEventListener("change", onFilesPicked);
    el.cameraInput.addEventListener("change", onFilesPicked);
    el.run.addEventListener("click", runScan);
    el.addMore.addEventListener("click", function () { el.fileInput.click(); });
    el.editFormat.addEventListener("click", function () { showStep("format"); });
    el.add.addEventListener("click", addFound);
    el.back.addEventListener("click", function () { showStep("photos"); });
    el.close.addEventListener("click", function () { if (session) session.onClose(); });
    el.scrim.addEventListener("click", function () { if (session) session.onClose(); });
  }

  /* Entry point from app.js — the overlay is already visible. */
  function open(opts) {
    opts = opts || {};
    bindUi();
    session = {
      token: ++sessionSeq,
      existing: opts.existing instanceof Set ? opts.existing : new Set(opts.existing || []),
      onAdd: typeof opts.onAdd === "function" ? opts.onAdd : function () {},
      onClose: typeof opts.onClose === "function" ? opts.onClose : function () {},
      toast: typeof opts.toast === "function" ? opts.toast : function () {},
      digits: 0,
      pattern: "",
      files: [],       // { file, thumb, failed, scanned, found }
      fileKeys: {},    // name:size:mtime of picked files, to skip re-picks
      prepping: 0,     // thumbnails still decoding
      running: false,
      doneCount: 0,
      worker: null,
      results: null
    };
    el.format.value = String(opts.initialFormat || "");
    updateFormatUi();
    showStep("format");
    /* Warm the CDN download while the user types the format and picks photos. */
    ensureTesseract().catch(function () { /* surfaced when scanning starts */ });
  }

  /* Abort anything in flight and free the worker. Overlay visibility and
     focus stay with app.js. Safe to call twice. */
  function close() {
    if (!session) return;
    session.token += 1; // in-flight chains check this and bail
    session.running = false;
    releaseWorker();
    session = null;
    if (sharedCanvas) {
      sharedCanvas.width = 0;
      sharedCanvas.height = 0;
    }
  }

  function releaseWorker() {
    if (!session || !session.worker) return;
    var w = session.worker;
    session.worker = null;
    try { w.terminate(); } catch (e) { /* already gone */ }
  }

  /* ---------- Steps and small UI helpers ---------- */

  function showStep(name) {
    el.stepFormat.hidden = name !== "format";
    el.stepPhotos.hidden = name !== "photos";
    el.stepReview.hidden = name !== "review";
    if (name === "photos") {
      el.patternLabel.textContent = session && session.digits
        ? "every " + session.digits + "-digit number"
        : "";
      renderThumbs();
      updateRunButton();
    }
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  var FORMAT_ERRORS = {
    "empty": "Type how many digits one ticket number has, e.g. 6.",
    "chars": "Digits only — how many digits is one ticket number?",
    "too-short": function () { return "Ticket numbers have at least " + MIN_LEN + " digits."; },
    "too-long": function () { return "Ticket numbers have at most " + MAX_LEN + " digits."; }
  };

  function updateFormatUi() {
    if (!session) return;
    var parsed = parseLength(el.format.value);

    if (parsed.ok) {
      session.digits = parsed.digits;
      session.pattern = parsed.pattern;
      el.formatError.hidden = true;
    } else if (parsed.reason === "empty") {
      el.formatError.hidden = true; // pristine input, nothing to say yet
    } else {
      el.formatError.hidden = false;
      var msg = FORMAT_ERRORS[parsed.reason];
      el.formatError.textContent = typeof msg === "function" ? msg() : msg;
    }

    el.choosePhotos.disabled = !parsed.ok;
    el.camera.disabled = !parsed.ok;
  }

  function updateRunButton() {
    el.run.disabled = !session || !session.files.length || session.running || session.prepping > 0;
    el.run.textContent = session && session.files.length
      ? "Scan " + plural(session.files.length, "photo")
      : "Scan Photos";
    el.addMore.disabled = session && session.prepping > 0;
  }

  function setStatus(text) {
    el.progressText.textContent = text;
  }

  function setOverall(fraction) {
    var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    el.barFill.style.width = pct + "%";
  }

  /* ---------- Photo picking ---------- */

  function fileKey(f) {
    return f.name + ":" + f.size + ":" + f.lastModified;
  }

  function onFilesPicked(e) {
    var input = e.target;
    var files = Array.prototype.slice.call(input.files || []);
    input.value = ""; // lets the user re-pick the same file later
    if (!session || !files.length) return;
    var fresh = files.filter(function (f) {
      return !f.type || /^image\//.test(f.type);
    }).filter(function (f) {
      if (session.fileKeys[fileKey(f)]) return false;
      session.fileKeys[fileKey(f)] = true;
      return true;
    });
    if (fresh.length) {
      /* Photos are picked from the format step too — land on the photos
         step so the thumbnails are actually visible. */
      showStep("photos");
      addFiles(fresh);
    }
  }

  function addFiles(files) {
    var myToken = session.token;
    session.prepping += files.length;
    updateRunButton();

    var i = 0;
    (function next() {
      if (!session || session.token !== myToken) return;
      if (i >= files.length) {
        session.prepping -= files.length;
        if (session.prepping < 0) session.prepping = 0;
        updateRunButton();
        renderThumbs();
        return;
      }
      var file = files[i++];
      makeThumb(file).then(function (thumb) {
        if (!session || session.token !== myToken) return;
        session.files.push({ file: file, thumb: thumb, failed: false, scanned: false, found: 0 });
      }).catch(function () {
        if (!session || session.token !== myToken) return;
        session.files.push({ file: file, thumb: "", failed: true, scanned: false, found: 0 });
      }).then(function () {
        renderThumbs();
        next();
      });
    })();
  }

  function makeThumb(file) {
    return decodeImage(file).then(function (img) {
      var c = document.createElement("canvas");
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      var scale = Math.min(1, THUMB_MAX_SIDE / Math.max(w, h, 1));
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.7);
    });
  }

  function renderThumbs() {
    if (!session) return;
    el.thumbs.textContent = "";
    session.files.forEach(function (entry, index) {
      var li = document.createElement("li");
      li.className = "scan-thumb" + (entry.failed ? " failed" : "");
      if (entry.thumb) {
        var img = document.createElement("img");
        img.src = entry.thumb;
        img.alt = "";
        li.appendChild(img);
      }
      if (entry.scanned) {
        var badge = document.createElement("span");
        badge.className = "scan-thumb-count" + (entry.found ? "" : " none");
        badge.textContent = entry.found ? "+" + entry.found : "0";
        li.appendChild(badge);
      }
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "scan-thumb-remove";
      rm.setAttribute("aria-label", "Remove photo " + (index + 1));
      rm.textContent = "✕";
      rm.addEventListener("click", function () {
        if (!session || session.running || session.prepping > 0) return;
        var at = session.files.indexOf(entry);
        if (at !== -1) session.files.splice(at, 1);
        renderThumbs();
        updateRunButton();
      });
      li.appendChild(rm);
      el.thumbs.appendChild(li);
    });
    if (!session.files.length) {
      var empty = document.createElement("li");
      empty.className = "scan-thumbs-empty";
      empty.textContent = "No photos yet — add the ones showing your tickets.";
      el.thumbs.appendChild(empty);
    }
  }

  /* ---------- OCR run ---------- */

  function runScan() {
    if (!session || session.running || !session.files.length || session.prepping > 0) return;
    var myToken = ++sessionSeq;
    session.token = myToken;
    session.running = true;
    session.doneCount = 0;
    showStep("review");
    el.progress.hidden = false;
    el.summary.hidden = true;
    el.preview.hidden = true;
    el.add.disabled = true;
    el.back.disabled = true;
    setOverall(0);
    setStatus("Loading scanner…");

    ensureTesseract()
      .then(function () { return ensureWorker(myToken); })
      .then(function (worker) { return runPhotos(myToken, worker); })
      .then(function (found) {
        if (!session || session.token !== myToken) return;
        finishReview(found);
      })
      .catch(function (err) {
        if (!session || session.token !== myToken) return;
        session.running = false;
        releaseWorker();
        el.progress.hidden = true;
        showStep("photos");
        var offline = err && (err.message === "scanner-load-failed" || err.message === "aborted");
        session.toast(
          offline
            ? "Couldn't load the scanner — check your connection and try again"
            : "Scan failed — try again, or add the tickets by hand",
          { variant: "error" }
        );
      });
  }

  /* Inject the Tesseract CDN build on first use, once. A stalled connection
     must not leave the user on "Loading scanner…" forever — time out and let
     the caller show the offline message. */
  function ensureTesseract() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return Promise.reject(new Error("no-dom"));
    }
    if (window.Tesseract) return Promise.resolve();
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      var timer = setTimeout(function () {
        tesseractPromise = null;
        s.remove();
        reject(new Error("scanner-load-failed"));
      }, 45000);
      s.src = TESSERACT_URL;
      s.async = true;
      s.onload = function () {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = function () {
        clearTimeout(timer);
        tesseractPromise = null; // allow a retry on the next scan attempt
        s.remove();
        reject(new Error("scanner-load-failed"));
      };
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  /* One worker per session; recognize calls reuse it across photos. */
  function ensureWorker(token) {
    if (typeof window === "undefined" || typeof window.Tesseract === "undefined") {
      return Promise.reject(new Error("scanner-load-failed"));
    }
    var Tesseract = window.Tesseract;
    return Tesseract.createWorker("eng", 1, {
      logger: function (m) {
        if (!session || session.token !== token || !session.running || !m) return;
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          setOverall((session.doneCount + m.progress) / Math.max(1, session.files.length));
        }
      }
    }).then(function (worker) {
      if (!session || session.token !== token) {
        try { worker.terminate(); } catch (e) { /* never started */ }
        throw new Error("aborted");
      }
      session.worker = worker;
      /* No parameters here — each recognize pass sets its own PSM. */
      return worker;
    });
  }

  function runPhotos(token, worker) {
    var pattern = session.pattern;
    var foundAll = [];
    var index = 0;

    function next() {
      if (!session || session.token !== token) throw new Error("aborted");
      if (index >= session.files.length) return foundAll;
      var i = index++;
      var entry = session.files[i];
      setStatus("Scanning photo " + (i + 1) + " of " + session.files.length + "…");
      setOverall(i / session.files.length);
      return recognizeEntry(worker, entry.file, pattern).then(
        function (nums) {
          entry.scanned = true;
          entry.found = nums.length;
          pushAll(foundAll, nums);
        },
        function () {
          entry.scanned = true;
          entry.found = 0;
          entry.failed = true;
        }
      ).then(function () {
        if (!session || session.token !== token) throw new Error("aborted");
        session.doneCount = i + 1;
        setOverall(session.doneCount / session.files.length);
        return next();
      });
    }
    return Promise.resolve().then(next);
  }

  function pushAll(target, nums) {
    nums.forEach(function (n) { target.push(n); });
  }

  /* Two recognize passes per photo, merged: white-on-green print reads best
     inverted at the default block segmentation, while tickets on white paper
     only show up un-inverted under sparse segmentation. Measured union on the
     demo photo: 9 of 10 tickets, vs 5-7 for either pass alone. */
  function recognizeEntry(worker, file, pattern) {
    return decodeImage(file).then(function (img) {
      var canvas = drawScaled(img);
      var lumas = grayscaleLumas(canvas);
      paintGrayscale(canvas, lumas, true); // white-on-green print -> dark on light
      return recognizeText(worker, canvas, psmValue("SINGLE_BLOCK", "6")).then(function (text) {
        var found = extractNumbers(text, pattern);
        paintGrayscale(canvas, lumas, false); // plain grayscale: paper-backed tickets
        return recognizeText(worker, canvas, psmValue("SPARSE_TEXT", "11")).then(function (plainText) {
          return mergeNumbers(found, extractNumbers(plainText, pattern));
        });
      });
    });
  }

  function psmValue(name, fallback) {
    try {
      return (window.Tesseract.PSM && window.Tesseract.PSM[name]) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function mergeNumbers(a, b) {
    var seen = {};
    var merged = [];
    a.concat(b).forEach(function (n) {
      if (!seen[n]) {
        seen[n] = true;
        merged.push(n);
      }
    });
    return merged;
  }

  function decodeImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("decode-failed"));
      };
      img.src = url;
    });
  }

  function getCanvas() {
    if (!sharedCanvas) sharedCanvas = document.createElement("canvas");
    return sharedCanvas;
  }

  /* Draw the photo into the shared canvas, capped at SCAN_MAX_SIDE. */
  function drawScaled(img) {
    var canvas = getCanvas();
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(1, SCAN_MAX_SIDE / Math.max(w, h, 1));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /* Luma grayscale + contrast stretch, computed from the raw pixels once.
     Polarity is applied at paint time: white-on-color print should be
     inverted to the dark-on-light Tesseract prefers. No binarization:
     Tesseract thresholds internally and a global cut fights shadows and
     highlighter marks. */
  function grayscaleLumas(canvas) {
    var px = canvas
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height)
      .data;
    var count = px.length / 4;
    var lumas = new Uint8ClampedArray(count);
    var min = 255;
    var max = 0;
    var i;
    for (i = 0; i < count; i++) {
      var l = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
      lumas[i] = l;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    var range = (max - min) || 1;
    for (i = 0; i < count; i++) {
      lumas[i] = (lumas[i] - min) * 255 / range;
    }
    return lumas;
  }

  function paintGrayscale(canvas, lumas, invert) {
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var img = ctx.createImageData(canvas.width, canvas.height);
    var px = img.data;
    for (var i = 0; i < lumas.length; i++) {
      var v = invert ? 255 - lumas[i] : lumas[i];
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
      px[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function recognizeText(worker, canvas, psm) {
    /* PSM is set per pass: block mode for the inverted pass, sparse for the
       plain one. setParameters is cheap; explicit beats hidden state. */
    return worker.setParameters({ tessedit_pageseg_mode: psm })
      .catch(function () { /* keep the engine default if it rejects */ })
      .then(function () { return worker.recognize(canvas); })
      .then(function (res) {
        return (res && res.data && res.data.text) || "";
      });
  }

  /* ---------- Review and add ---------- */

  function finishReview(found) {
    session.running = false;
    releaseWorker();
    el.progress.hidden = true;
    session.results = classifyFound(found, session.existing);
    renderReview(session.results);
    renderThumbs();
    el.summary.hidden = false;
    el.preview.hidden = false;
    el.back.disabled = false;
  }

  function renderReview(res) {
    el.summary.textContent = "";
    el.preview.textContent = "";

    var unread = session ? session.files.filter(function (f) { return f.failed; }).length : 0;
    var total = res.valid.length + res.duplicates.length;
    if (!total) {
      summaryLine("bad", "No matching numbers found — check the format or try clearer photos");
    } else {
      if (res.valid.length) summaryLine("ok", "✓ " + plural(res.valid.length, "ticket") + " ready");
      if (res.duplicates.length) summaryLine("warn", "⚠ " + plural(res.duplicates.length, "duplicate") + " already on your list");
    }
    if (unread) summaryLine("bad", "⚠ " + plural(unread, "photo") + " couldn't be read");

    el.add.disabled = !res.valid.length;
    el.add.textContent = res.valid.length
      ? "Add " + plural(res.valid.length, "ticket")
      : "Add Tickets";

    var chips = 0;
    res.valid.forEach(function (n) {
      if (chips++ >= CHIP_CAP) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip ok";
      b.textContent = "✓ " + n;
      b.setAttribute("aria-label", "Remove " + n + " from the scan results");
      b.addEventListener("click", function () {
        if (!session || !session.results) return;
        var at = session.results.valid.indexOf(n);
        if (at !== -1) session.results.valid.splice(at, 1);
        renderReview(session.results);
      });
      el.preview.appendChild(b);
    });
    res.duplicates.forEach(function (n) {
      if (chips++ >= CHIP_CAP) return;
      var s = document.createElement("span");
      s.className = "chip dup";
      s.textContent = "⚠ " + n;
      s.title = "Already on your list";
      el.preview.appendChild(s);
    });
    if (total > CHIP_CAP) {
      var more = document.createElement("span");
      more.className = "chip";
      more.textContent = "+" + (total - CHIP_CAP) + " more";
      el.preview.appendChild(more);
    }
  }

  function summaryLine(cls, text) {
    var s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    el.summary.appendChild(s);
  }

  function addFound() {
    if (!session || !session.results || !session.results.valid.length) return;
    var nums = session.results.valid.slice();
    var digits = session.digits;
    nums.forEach(function (n) { session.existing.add(n); });
    session.results = null;
    session.onAdd(nums, digits);
    /* Back to the photos step: more piles can be scanned right away. */
    session.files.forEach(function (entry) {
      entry.scanned = false;
      entry.found = 0;
    });
    showStep("photos");
  }

  return {
    parseLength: parseLength,
    patternForDigits: patternForDigits,
    matchesPattern: matchesPattern,
    extractNumbers: extractNumbers,
    classifyFound: classifyFound,
    open: open,
    close: close
  };
});
