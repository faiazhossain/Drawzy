/* Lottery rules — pure logic, no DOM.
   Every matching rule lives here so the rules can evolve in one place. */
(function (root, factory) {
  var api = factory();
  root.Lottery = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var MIN_LEN = 3;
  var MAX_LEN = 12;

  /* Status tiers by number of unmatched digits left on a ticket.
     "eliminated" is reserved for rule sets where a ticket can no longer win. */
  function statusFor(remaining) {
    if (remaining <= 0) return "winner";
    if (remaining === 1) return "one-left";
    if (remaining === 2) return "very-close";
    if (remaining === 3) return "close";
    return "active";
  }

  /* Core rule: the announced digits spell out the winning number, one digit
     at a time. A ticket is the winner only while it equals the ENTIRE called
     sequence — same length, digit for digit. The first mismatch marks it
     eliminated ("missed"), and so does the draw continuing past its length:
     a 123 ticket is not the winner when the number announced is 1234.
     matched[] flags fill the correct prefix; missedAt is the position where
     it went out (-1 while alive and not yet fully matched). */
  function calculateTicketState(ticket, calledDigits) {
    var called = calledDigits || [];
    var digits = String(ticket.num).split("");
    var matchedCount = 0;
    var missedAt = -1;
    for (var i = 0; i < called.length; i++) {
      if (i >= digits.length) {
        missedAt = i; // the draw continued past this number — not the winner
        break;
      }
      if (String(called[i]) === digits[i]) {
        matchedCount++;
      } else {
        missedAt = i;
        break;
      }
    }
    var eliminated = missedAt !== -1;
    var remaining = digits.length - matchedCount;
    var matched = digits.map(function (d, i) { return i < matchedCount; });
    return {
      digits: digits,
      matched: matched,
      matchedCount: matchedCount,
      remaining: remaining,
      missedAt: missedAt,
      /* Nothing matched yet -> always Active, so a short ticket doesn't
         look "close" before the draw has even started. */
      status: eliminated ? "eliminated" : (matchedCount === 0 ? "active" : statusFor(remaining)),
      eliminated: eliminated
    };
  }

  /* Excitement level for the banner, driven by how many tickets are still
     alive (alive = still matching the sequence, not yet won or missed).
     Before the first number is called the draw is always neutral. */
  function summarize(tickets, calledDigits) {
    var states = (tickets || []).map(function (t) {
      return calculateTicketState(t, calledDigits);
    });
    var winners = states.filter(function (s) { return s.status === "winner"; }).length;
    var eliminated = states.filter(function (s) { return s.status === "eliminated"; }).length;
    var alive = states.length - winners - eliminated;
    var drawStarted = (calledDigits || []).length > 0;
    var level = "neutral";
    if (states.length && winners > 0) level = "won";
    else if (drawStarted && alive === 1) level = "one-ticket";
    else if (drawStarted && alive >= 2 && alive <= 4) level = "close";
    else if (drawStarted && alive >= 5 && alive <= 9) level = "interesting";
    return {
      total: states.length,
      winners: winners,
      eliminated: eliminated,
      alive: alive,
      level: level,
      states: states
    };
  }

  function normalizeNumber(raw) {
    return String(raw == null ? "" : raw).replace(/[\s–—-]/g, "");
  }

  function validateNumber(raw, existingNums) {
    var num = normalizeNumber(raw);
    if (!num) return { ok: false, num: num, reason: "empty" };
    if (!/^\d+$/.test(num)) return { ok: false, num: num, reason: "not-numeric" };
    if (num.length < MIN_LEN) return { ok: false, num: num, reason: "too-short" };
    if (num.length > MAX_LEN) return { ok: false, num: num, reason: "too-long" };
    if (existingNums && existingNums.has(num)) return { ok: false, num: num, reason: "duplicate" };
    return { ok: true, num: num };
  }

  /* Bulk parser: accepts newline, comma, semicolon or space separated input. */
  function parseBulkInput(text, existingNums) {
    var existing = existingNums instanceof Set ? existingNums : new Set(existingNums || []);
    var seen = new Set(existing);
    var valid = [];
    var duplicates = [];
    var invalid = [];
    String(text || "").split(/[\n\r,;]+/).forEach(function (line) {
      line.split(/\s+/).forEach(function (token) {
        if (!token) return;
        var res = validateNumber(token, seen);
        if (res.ok) {
          valid.push(res.num);
          seen.add(res.num);
        } else if (res.reason === "duplicate") {
          duplicates.push(res.num);
        } else {
          invalid.push({ raw: token, reason: res.reason });
        }
      });
    });
    return { valid: valid, duplicates: duplicates, invalid: invalid };
  }

  return {
    calculateTicketState: calculateTicketState,
    summarize: summarize,
    parseBulkInput: parseBulkInput,
    validateNumber: validateNumber,
    normalizeNumber: normalizeNumber,
    statusFor: statusFor,
    MIN_LEN: MIN_LEN,
    MAX_LEN: MAX_LEN
  };
});
