/* Tests for the lottery rules module. Run: node --test test/ */
const test = require("node:test");
const assert = require("node:assert");
const Lottery = require("../lottery.js");

test("user scenario: tickets 123 and 122 miss on 1,2,4 — extra calls never win", () => {
  const calls = ["1", "2", "4"];
  const t123 = Lottery.calculateTicketState({ num: "123" }, calls);
  assert.equal(t123.status, "eliminated");
  assert.equal(t123.missedAt, 2);
  assert.equal(t123.matchedCount, 2);

  const t122 = Lottery.calculateTicketState({ num: "122" }, calls);
  assert.equal(t122.status, "eliminated");
  assert.equal(t122.missedAt, 2);

  // continuing 1,2,4,5,3 must NOT win — the ticket already missed
  const later = Lottery.calculateTicketState({ num: "123" }, ["1", "2", "4", "5", "3"]);
  assert.equal(later.status, "eliminated");

  // the exact sequence wins
  assert.equal(Lottery.calculateTicketState({ num: "123" }, ["1", "2", "3"]).status, "winner");
});

test("131313: alive while the sequence matches in order", () => {
  const t = { num: "131313" };
  const two = Lottery.calculateTicketState(t, ["1", "3"]);
  assert.equal(two.status, "active");
  assert.equal(two.matchedCount, 2);

  assert.equal(Lottery.calculateTicketState(t, ["1", "3", "1"]).status, "close");
  assert.equal(Lottery.calculateTicketState(t, ["1", "3", "1", "3"]).status, "very-close");
  assert.equal(Lottery.calculateTicketState(t, ["1", "3", "1", "3", "1"]).status, "one-left");
  assert.equal(Lottery.calculateTicketState(t, ["1", "3", "1", "3", "1", "3"]).status, "winner");

  // a wrong second digit misses immediately
  assert.equal(Lottery.calculateTicketState(t, ["1", "1"]).status, "eliminated");
});

test("short tickets look Active before the draw starts, not Close", () => {
  // remaining 3 of 3 with nothing called is not "Getting Close"
  assert.equal(Lottery.calculateTicketState({ num: "123" }, []).status, "active");
  assert.equal(Lottery.calculateTicketState({ num: "123456" }, []).status, "active");
  // but once matching begins the tiers kick in
  assert.equal(Lottery.calculateTicketState({ num: "123" }, ["1"]).status, "very-close");
});

test("161648 wins only on the exact sequence", () => {
  const win = Lottery.calculateTicketState({ num: "161648" }, ["1", "6", "1", "6", "4", "8"]);
  assert.equal(win.status, "winner");
  assert.equal(win.remaining, 0);

  const off = Lottery.calculateTicketState({ num: "161648" }, ["1", "6", "1", "4", "8"]);
  assert.equal(off.status, "eliminated");
  assert.equal(off.missedAt, 3);
});

test("a ticket stops winning once the draw continues past it", () => {
  // 123 announced -> 123 is the winner
  const atThree = Lottery.calculateTicketState({ num: "123" }, ["1", "2", "3"]);
  assert.equal(atThree.status, "winner");

  // the draw continues to 1234 -> 123 is NOT the winning number
  const pastIt = Lottery.calculateTicketState({ num: "123" }, ["1", "2", "3", "4"]);
  assert.equal(pastIt.status, "eliminated");

  // 1234 itself wins on the four calls
  assert.equal(
    Lottery.calculateTicketState({ num: "1234" }, ["1", "2", "3", "4"]).status,
    "winner"
  );
});

test("summarize: alive counts only tickets still matching the sequence", () => {
  const tickets = ["123456", "123457", "123458", "123459", "123450", "678901"]
    .map((num) => ({ num }));

  assert.equal(Lottery.summarize(tickets, []).level, "neutral"); // draw not started

  // "1" keeps the five 12345x tickets alive, 678901 missed
  const s1 = Lottery.summarize(tickets, ["1"]);
  assert.equal(s1.alive, 5);
  assert.equal(s1.eliminated, 1);
  assert.equal(s1.winners, 0);
  assert.equal(s1.level, "interesting");

  const s5 = Lottery.summarize(tickets, ["1", "2", "3", "4", "5"]);
  assert.equal(s5.alive, 5);
  assert.equal(s5.level, "interesting");

  // 6 spells 123456: one winner, the other 12345x tickets missed at digit 6
  const won = Lottery.summarize(tickets, ["1", "2", "3", "4", "5", "6"]);
  assert.equal(won.level, "won");
  assert.equal(won.winners, 1);
  assert.equal(won.eliminated, 5);
  assert.equal(won.alive, 0);
});

test("summarize: close and one-ticket levels with survivors", () => {
  const trio = ["123456", "123457", "123458"].map((num) => ({ num }));
  assert.equal(Lottery.summarize(trio, ["1", "2", "3", "4"]).level, "close"); // 3 alive
  assert.equal(Lottery.summarize(trio.slice(0, 1), ["1", "2", "3", "4", "5"]).level, "one-ticket");

  // everything missed and nothing won
  const allMissed = Lottery.summarize(trio, ["9"]);
  assert.equal(allMissed.alive, 0);
  assert.equal(allMissed.eliminated, 3);
  assert.equal(allMissed.level, "neutral"); // banner copy handles this case
});

test("undo equivalence: state after undo equals state before the call", () => {
  const tickets = [{ num: "131313" }];
  const before = Lottery.summarize(tickets, ["1", "3", "1"]);
  const during = Lottery.summarize(tickets, ["1", "3", "1", "3"]);
  const after = Lottery.summarize(tickets, ["1", "3", "1"]);
  assert.deepEqual(
    before.states.map((s) => [s.matchedCount, s.status]),
    after.states.map((s) => [s.matchedCount, s.status])
  );
  assert.notEqual(during.states[0].matchedCount, before.states[0].matchedCount);
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
