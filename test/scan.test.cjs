/* Tests for the scan matching logic. Run: node --test */
const test = require("node:test");
const assert = require("node:assert");
const Scan = require("../scan.js");

test("parseLength: digit count builds an all-wildcard pattern", () => {
  const p = Scan.parseLength("6");
  assert.equal(p.ok, true);
  assert.equal(p.digits, 6);
  assert.equal(p.pattern, "xxxxxx");

  const spaced = Scan.parseLength(" 6 ");
  assert.equal(spaced.ok, true);
  assert.equal(spaced.digits, 6);

  const zero6 = Scan.parseLength("06");
  assert.equal(zero6.ok, true);
  assert.equal(zero6.digits, 6);
});

test("parseLength: rejects bad input with reasons", () => {
  assert.equal(Scan.parseLength("").reason, "empty");
  assert.equal(Scan.parseLength("   ").reason, "empty");
  assert.equal(Scan.parseLength("six").reason, "chars");
  assert.equal(Scan.parseLength("6x").reason, "chars");
  assert.equal(Scan.parseLength("2").reason, "too-short");
  assert.equal(Scan.parseLength("13").reason, "too-long");
  assert.equal(Scan.parseLength("3").ok, true);
  assert.equal(Scan.parseLength("12").ok, true);
});

test("patternForDigits: n wildcards", () => {
  assert.equal(Scan.patternForDigits(6), "xxxxxx");
  assert.equal(Scan.patternForDigits(3), "xxx");
});

test("extractNumbers: picks up any number of the given length", () => {
  // any 6-digit ticket: 161642, 131314, whatever
  assert.deepEqual(
    Scan.extractNumbers("Barikoi 8th Anniversary Raffle #161642", "xxxxxx"),
    ["161642"]
  );
  assert.deepEqual(
    Scan.extractNumbers("#131314 and #151515 on the next ticket", "xxxxxx"),
    ["131314", "151515"]
  );
  assert.deepEqual(Scan.extractNumbers("15155", "xxxxxx"), []); // wrong length
  assert.deepEqual(
    Scan.extractNumbers("016104", "xxxxxx"), // leading zeros count too
    ["016104"]
  );
});

test("extractNumbers: OCR noise is filtered by length", () => {
  assert.deepEqual(
    Scan.extractNumbers(
      "8th Anniversary Price BDT 20 Taka EMPLOYEE COPY 1ST PRIZE",
      "xxxxxx"
    ),
    []
  );
});

test("extractNumbers: fused runs are split by the sliding window", () => {
  assert.deepEqual(
    Scan.extractNumbers("161642161644", "xxxxxx"),
    ["161642", "161644"]
  );
  // greedy non-overlap: three tickets back to back, only the first fits
  assert.deepEqual(Scan.extractNumbers("161161161", "xxxxxx"), ["161161"]);
  // with no fixed digits, any 6-digit run matches — fused noise included.
  // The review step (removable chips) is what guards these.
  assert.deepEqual(Scan.extractNumbers("999888777666", "xxxxxx"), ["999888", "777666"]);
});

test("extractNumbers: no fuzzy matches, deduped, order kept", () => {
  assert.deepEqual(Scan.extractNumbers("161642 161642", "xxxxxx"), ["161642"]);
  assert.deepEqual(Scan.extractNumbers("61642", "xxxxxx"), []); // too short
  assert.deepEqual(
    Scan.extractNumbers("#161503 then #161505 then #161503", "xxxxxx"),
    ["161503", "161505"]
  );
});

test("extractNumbers still honors per-position fixed patterns", () => {
  assert.deepEqual(Scan.extractNumbers("111222 555", "1x12xx"), ["111222"]);
  assert.deepEqual(Scan.extractNumbers("016104", "161xxx"), []); // starts with 0, not 1
  // a misread "#" glues extra digits in front — the prefix anchors the window
  assert.deepEqual(Scan.extractNumbers("4161642", "161xxx"), ["161642"]);
  assert.deepEqual(Scan.extractNumbers("161642 161503", "161xxx"), ["161642", "161503"]);
  // position 3 of 1x10xx must be 0
  assert.deepEqual(Scan.extractNumbers("101104", "1x10xx"), []);
});

test("matchesPattern: same length, per-position fixed digits", () => {
  assert.equal(Scan.matchesPattern("161642", "161xxx"), true);
  assert.equal(Scan.matchesPattern("961642", "161xxx"), false);
  assert.equal(Scan.matchesPattern("16164", "161xxx"), false);
  assert.equal(Scan.matchesPattern("1616420", "161xxx"), false);
  assert.equal(Scan.matchesPattern("111222", "1x12xx"), true);
  assert.equal(Scan.matchesPattern("161222", "1x12xx"), true); // x accepts any digit
  assert.equal(Scan.matchesPattern("101104", "1x10xx"), false); // position 3 must be 0
  assert.equal(Scan.matchesPattern("131314", "xxxxxx"), true);
});

test("classifyFound: splits valid from already-owned, including in-batch dups", () => {
  const res = Scan.classifyFound(
    ["161642", "161648", "161642", "161650"],
    new Set(["161648"])
  );
  assert.deepEqual(res.valid, ["161642", "161650"]);
  assert.deepEqual(res.duplicates, ["161648", "161642"]);
});
