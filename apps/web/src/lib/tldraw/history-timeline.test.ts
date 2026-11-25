/** History-panel timeline shaping: raw op traffic -> human rows. */
import { test, expect } from "bun:test";
import { groupTimeline, ago, authorLabel, RUN_GAP_MS, type HistoryPoint } from "./history-timeline";

const op = (seq: number, ts: number, author = "a"): HistoryPoint => ({
  seq,
  ts,
  kind: "op",
  author,
});

test("consecutive same-author ops within the gap collapse into one row", () => {
  const rows = groupTimeline([op(1, 1000), op(2, 2000), op(3, 3000)]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "edits", count: 3, seq: 3, ts: 3000 });
});

test("a gap >= RUN_GAP_MS starts a new row; output is newest-first", () => {
  const rows = groupTimeline([op(1, 0), op(2, 1000), op(3, 1000 + RUN_GAP_MS)]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ seq: 3, count: 1 }); // newest first
  expect(rows[1]).toMatchObject({ seq: 2, count: 2 });
});

test("an author change breaks the run", () => {
  const rows = groupTimeline([op(1, 0, "a"), op(2, 1000, "b"), op(3, 2000, "b")]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ count: 2, seq: 3 });
  expect(rows[1]).toMatchObject({ count: 1, seq: 1 });
});

test("reverts and checkpoints stand alone and break runs", () => {
  const rows = groupTimeline([
    op(1, 0),
    op(2, 500),
    { seq: 3, ts: 600, kind: "revert", author: null },
    { seq: 3, ts: 700, kind: "snapshot", author: null },
    op(4, 800),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["edits", "checkpoint", "revert", "edits"]);
  // the post-revert edit did NOT merge into the pre-revert run
  expect(rows[0]).toMatchObject({ count: 1, seq: 4 });
  expect(rows[3]).toMatchObject({ count: 2, seq: 2 });
});

test("empty input -> empty timeline", () => {
  expect(groupTimeline([])).toEqual([]);
});

test("ago renders compact relative times", () => {
  const now = 1_000_000_000;
  expect(ago(now - 5_000, now)).toBe("5s ago");
  expect(ago(now - 120_000, now)).toBe("2m ago");
  expect(ago(now - 7_200_000, now)).toBe("2h ago");
  expect(ago(now - 172_800_000, now)).toBe("2d ago");
  expect(ago(now + 5_000, now)).toBe("0s ago"); // clock skew clamps to 0
});

test("authorLabel: web/null/legacy-UUID -> browser, daemon -> tablet, apps as-is", () => {
  expect(authorLabel("web")).toBe("browser");
  expect(authorLabel(null)).toBe("browser");
  expect(authorLabel(undefined)).toBe("browser");
  // legacy web installs pushed the engine author UUID before historyAuthor
  expect(authorLabel("980fc3f7-cf36-4178-ae48-2bee0179507d")).toBe("browser");
  expect(authorLabel("rmsyncd")).toBe("tablet");
  expect(authorLabel("tablet")).toBe("tablet");
  expect(authorLabel("obsidian-plugin")).toBe("obsidian-plugin");
  // not-quite-UUIDs are app names, not identities
  expect(authorLabel("980fc3f7-cf36")).toBe("980fc3f7-cf36");
});

test("a restore's marker + revert snapshot merge into ONE row carrying the restore handle", () => {
  const rows = groupTimeline([
    op(1, 100),
    op(2, 200),
    { seq: 3, ts: 300, kind: "revert", author: "r" },
    { seq: 3, ts: 301, kind: "snapshot", author: null, snapSeq: 7, revertSnap: true },
  ]);
  // merged, not four rows: [restore, edits]
  expect(rows.map((r) => r.kind)).toEqual(["revert", "edits"]);
  expect(rows[0]).toMatchObject({ kind: "revert", snapSeq: 7 });
});

test("faithful (non-revert) snapshots do NOT merge into a preceding restore row", () => {
  const rows = groupTimeline([
    { seq: 1, ts: 100, kind: "revert", author: "r" },
    { seq: 1, ts: 200, kind: "snapshot", author: null, snapSeq: 4 }, // plain checkpoint
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["checkpoint", "revert"]);
});

test("two restores in a row each keep their own snapshot handle", () => {
  const rows = groupTimeline([
    { seq: 1, ts: 100, kind: "revert", author: "r" },
    { seq: 1, ts: 101, kind: "snapshot", author: null, snapSeq: 5, revertSnap: true },
    { seq: 2, ts: 200, kind: "revert", author: "r" },
    { seq: 2, ts: 201, kind: "snapshot", author: null, snapSeq: 6, revertSnap: true },
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["revert", "revert"]);
  expect(rows[0]!.snapSeq).toBe(6); // newest first
  expect(rows[1]!.snapSeq).toBe(5);
});
