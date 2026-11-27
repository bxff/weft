import { expect, test } from "bun:test";
import { type AccountRetentionFacts, planAccountRetention } from "../src/account-retention";

const at = (value: string) => Date.parse(value);
const tracked: AccountRetentionFacts = {
  observedSince: at("2025-08-31T15:30:00Z"),
  lastActivityAt: null,
  held: false,
  notice: null,
};
const sixMonths = at("2026-02-28T15:30:00Z");
const lateNotice = at("2026-03-04T15:30:00Z");
const graceEnd = at("2026-04-03T15:30:00Z");
const notified = { ...tracked, notice: { inactivitySince: tracked.observedSince!, deliveredAt: lateNotice } };

test("six calendar months are clamped at month end without rounding down", () => {
  expect(planAccountRetention(tracked, sixMonths - 1)).toEqual({
    action: "wait", reason: "active", until: sixMonths,
  });
  expect(planAccountRetention(tracked, sixMonths)).toEqual({
    action: "notice", inactivitySince: tracked.observedSince,
  });
});

test("candidate requires a notice for this idle spell and thirty days of grace after delivery", () => {
  expect(planAccountRetention(tracked, graceEnd).action).toBe("notice");
  expect(planAccountRetention(notified, graceEnd - 1)).toEqual({
    action: "wait", reason: "grace", until: graceEnd,
  });
  expect(planAccountRetention(notified, graceEnd)).toEqual({
    action: "candidate", inactivitySince: tracked.observedSince, notBefore: graceEnd,
  });
  const staleNotice = { ...notified, notice: { inactivitySince: 0, deliveredAt: lateNotice } };
  expect(planAccountRetention(staleNotice, graceEnd).action).toBe("notice");
});

test("successful tablet sync and holds prevent a previously warned account from becoming eligible", () => {
  expect(planAccountRetention({
    ...notified, lastActivityAt: at("2026-04-01T15:30:00Z"),
  }, graceEnd)).toEqual({
    action: "wait", reason: "active", until: at("2026-10-01T15:30:00Z"),
  });
  expect(planAccountRetention({ ...notified, held: true }, graceEnd)).toEqual({
    action: "wait", reason: "hold",
  });
});

test("unknown tracking never guesses age; known legacy activity does not backdate new tracking", () => {
  expect(planAccountRetention({ ...notified, observedSince: null }, graceEnd)).toEqual({
    action: "wait", reason: "unknown",
  });
  expect(planAccountRetention({
    ...tracked, observedSince: sixMonths, lastActivityAt: 0,
  }, graceEnd)).toEqual({
    action: "wait", reason: "active", until: at("2026-08-28T15:30:00Z"),
  });
  expect(planAccountRetention({
    ...notified, lastActivityAt: graceEnd + 1,
  }, graceEnd)).toEqual({ action: "wait", reason: "unknown" });
});

test("missing or malformed hold clearance cannot mark an account eligible", () => {
  for (const held of [undefined, null, 0]) {
    const unverified = { ...notified, held } as unknown as AccountRetentionFacts;
    expect(planAccountRetention(unverified, graceEnd)).toEqual({
      action: "wait", reason: "hold",
    });
  }
});

test("a premature, future, or unconfirmed notice cannot start the grace period", () => {
  for (const deliveredAt of [sixMonths - 1, graceEnd + 1, null]) {
    const notice = { inactivitySince: tracked.observedSince!, deliveredAt };
    const facts = { ...tracked, notice } as AccountRetentionFacts;
    expect(planAccountRetention(facts, graceEnd)).toEqual({
      action: "notice", inactivitySince: tracked.observedSince,
    });
  }
});
