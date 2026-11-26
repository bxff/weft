// Eligibility planner only. Nothing imports this on the running relay; it
// neither sends mail nor deletes an account. An executor needs an authenticated
// activity ledger, confirmed notice delivery, and the full deletion/restore workflow.

const NOTICE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccountRetentionFacts {
  /** Beginning of continuous tracking for this account. Null if unverified. */
  observedSince: number | null;
  /** Latest successful sign-in or authenticated use, including a tablet
   * notebook sync that actually transferred changes, but not a heartbeat.
   * Null means no such activity observed since observedSince. */
  lastActivityAt: number | null;
  /** True unless an authoritative hold check positively clears the account. */
  held: boolean;
  /** Records a prior confirmed delivered notice, bound to this idle spell.
   * A queued/bounced/unknown notice is not a valid notice. */
  notice: { inactivitySince: number; deliveredAt: number } | null;
}

export type AccountRetentionDecision =
  | { action: "wait"; reason: "hold" | "unknown" | "active" | "grace"; until?: number }
  | { action: "notice"; inactivitySince: number }
  | { action: "candidate"; inactivitySince: number; notBefore: number };

/** Six calendar months in UTC, clamping month-end dates (e.g. August 31
 * becomes February 28 or 29). This is not 180 days. */
function sixMonthsAfter(timestamp: number): number {
  const date = new Date(timestamp);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 6);
  const lastDay = new Date(date);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return date.getTime();
}

export function planAccountRetention(
  facts: AccountRetentionFacts,
  now: number,
): AccountRetentionDecision {
  if (facts.held) return { action: "wait", reason: "hold" };
  const known = (value: number | null): value is number =>
    value !== null && Number.isSafeInteger(value) && value >= 0 && value <= now;
  if (!Number.isSafeInteger(now) || !known(facts.observedSince) ||
      (facts.lastActivityAt !== null && !known(facts.lastActivityAt))) {
    return { action: "wait", reason: "unknown" };
  }
  // Existing accounts accrue time only from reliable tracking onward, even
  // if a historical signal says they were last used years earlier.
  const inactivitySince = Math.max(facts.observedSince, facts.lastActivityAt ?? 0);
  const threshold = sixMonthsAfter(inactivitySince);
  if (!Number.isFinite(threshold)) return { action: "wait", reason: "unknown" };
  if (now < threshold) return { action: "wait", reason: "active", until: threshold };
  const { notice } = facts;
  if (!notice || notice.inactivitySince !== inactivitySince ||
      !known(notice.deliveredAt) || notice.deliveredAt < threshold) {
    return { action: "notice", inactivitySince };
  }
  const notBefore = notice.deliveredAt + NOTICE_GRACE_MS;
  if (now < notBefore) return { action: "wait", reason: "grace", until: notBefore };
  // A candidate is not authorization. Re-read authoritative activity, holds,
  // delivery status and identity under the admission fence immediately before
  // any future irreversible operation.
  return { action: "candidate", inactivitySince, notBefore };
}
