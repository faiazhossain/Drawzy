/* Tests for the lottery rules module. Run: node --test test/ */
const test = require("node:test");
const assert = require("node:assert");
const Lottery = require("../lottery.js");

test("spec scenario: 161648 wins after 1,6,1,4,8", () => {
  const ticket = { num: "161648" };
  const called = ["1", "6", "1", "4", "8"];
  const st = Lottery.calculateTicketState(ticket, called);
  assert.equal(st.status, "winner");
  assert.equal(st.remaining, 0);
  assert.equal(st.matchedCount, 6);
});

test("partial matches and status tiers (set-based)", () => {
  const ticket = { num: "161648" };
  const s0 = Lottery.calculateTicketState(ticket, []);
  assert.equal(s0.status, "active");
  assert.equal(s0.matchedCount, 0);

  // {1} called -> positions 0,2 match
  const s1 = Lottery.calculateTicketState(ticket, ["1"]);
  assert.equal(s1.matchedCount, 2);
  assert.equal(s1.status, "active");

  // {1,4} called -> 3 matched, 3 remaining
  const s3 = Lottery.calculateTicketState(ticket, ["1", "4"]);
  assert.equal(s3.matchedCount, 3);
  assert.equal(s3.status, "close");

  // {1,6} called -> 4 matched, 2 remaining
  const s4 = Lottery.calculateTicketState(ticket, ["1", "6"]);
  assert.equal(s4.status, "very-close");

  // {1,6,4} -> 5 matched
  const s5 = Lottery.calculateTicketState(ticket, ["1", "6", "4"]);
  assert.equal(s5.status, "one-left");
  assert.equal(s5.remaining, 1);
});

test("digit position does not matter, duplicates in calls are fine", () => {
  const st = Lottery.calculateTicketState({ num: "999111" }, ["9", "9", "1"]);
  assert.equal(st.matchedCount, 6);
  assert.equal(st.status, "winner");
});

test("summarize levels follow alive-ticket counts", () => {
  // Shared prefix 12345 + one unique key digit each: a ticket completes
  // exactly when its key digit is called.
  const tickets = ["123456", "123457", "123458", "123459", "123450", "678901"]
    .map((num) => ({ num }));
  const S = ["1", "2", "3", "4", "5"];

  assert.equal(Lottery.summarize(tickets, []).level, "neutral"); // draw not started
  const sMid = Lottery.summarize(tickets, S);
  assert.equal(sMid.level, "interesting"); // 6 alive once calls begin
  assert.equal(sMid.alive, 6);

  const s5 = Lottery.summarize(tickets, [...S, "6"]);
  assert.equal(s5.level, "won"); // any winner takes priority in the banner
  assert.equal(s5.alive, 5);
  assert.equal(s5.winners, 1);

  assert.equal(Lottery.summarize(tickets, [...S, "6", "7"]).winners, 2);
  assert.equal(Lottery.summarize(tickets, [...S, "6", "7", "8", "9"]).winners, 4);

  // "close" / "one-ticket" levels fire with zero winners — e.g. after the
  // user deletes losing tickets mid-draw.
  const trio = ["678901", "678902", "678903"].map((num) => ({ num }));
  const keys = ["6", "7", "8", "9", "0"];
  assert.equal(Lottery.summarize(trio, keys).level, "close"); // 3 alive, none complete
  assert.equal(Lottery.summarize(trio.slice(0, 1), keys).level, "one-ticket"); // 1 alive

  // all keys called -> every ticket wins
  const won = Lottery.summarize(tickets, [...S, "6", "7", "8", "9", "0"]);
  assert.equal(won.level, "won");
  assert.equal(won.winners, 6);
  assert.equal(won.alive, 0);
});

test("undo equivalence: state after undo equals state before the call", () => {
  const tickets = [{ num: "161648" }, { num: "927315" }];
  const before = Lottery.summarize(tickets, ["1", "6", "4"]);
  const during = Lottery.summarize(tickets, ["1", "6", "4", "2"]);
  const after = Lottery.summarize(tickets, ["1", "6", "4"]);
  assert.deepEqual(
    before.states.map((s) => [s.matchedCount, s.status]),
    after.states.map((s) => [s.matchedCount, s.status])
  );
  assert.notEqual(during.states[1].matchedCount, before.states[1].matchedCount);
});

test("bulk parsing: newlines, commas, spaces, duplicates, invalid", () => {
  const res = Lottery.parseBulkInput(
    "161648\n927315, 481623;837291 123456\n\n161648,abc,12",
    []
  );
  assert.deepEqual(res.valid, ["161648", "927315", "481623", "837291", "123456"]);
  assert.deepEqual(res.duplicates, ["161648"]);
  assert.deepEqual(res.invalid.map((i) => i.raw), ["abc", "12"]);
  assert.equal(res.invalid[0].reason, "not-numeric");
  assert.equal(res.invalid[1].reason, "too-short");
});

test("bulk parsing respects existing tickets", () => {
  const res = Lottery.parseBulkInput("111222\n333444", new Set(["111222"]));
  assert.deepEqual(res.valid, ["333444"]);
  assert.deepEqual(res.duplicates, ["111222"]);
});

test("dashes inside a number are stripped; spaces separate tickets", () => {
  const res = Lottery.parseBulkInput("161-648\n927 315");
  assert.deepEqual(res.valid, ["161648", "927", "315"]);
});

test("single validateNumber cases", () => {
  assert.equal(Lottery.validateNumber("161648", new Set()).ok, true);
  assert.equal(Lottery.validateNumber("", new Set()).reason, "empty");
  assert.equal(Lottery.validateNumber("16a4", new Set()).reason, "not-numeric");
  assert.equal(Lottery.validateNumber("16", new Set()).reason, "too-short");
  assert.equal(Lottery.validateNumber("161648", new Set(["161648"])).reason, "duplicate");
  assert.equal(Lottery.validateNumber("012345", new Set()).ok, true); // leading zeros kept
});
