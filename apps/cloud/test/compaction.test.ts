/**
 * F3 (D3 §6): log-size compaction. compact() folds ops <= H into a fresh
 * checkpoint pinned at H. The launch stance is KEEP-EVERYTHING
 * (RETENTION_KEEP_ALL=true): create the checkpoint, delete NO page_ops, so F2
 * history/time-travel/revert still reaches the oldest state, at EVERY seq.
 *
 * The invariant under test (keep-all): reconstruct(latest snapshot +
 * opsSince(op_seq)) is byte-identical BEFORE and AFTER compaction, on both the
 * live device path and time-travel at every seq.
 *
 * The retention window (keepAll=false) is OPT-IN and SAFE (#52): compact pins a
 * boundary checkpoint at the truncation floor and persists the floor, so every
 * target at/above the floor stays byte-identical while targets below it are
 * REFUSED (BelowFloorError / HTTP 410) — never answered with a wrong
 * reconstruct. Both behaviors are pinned by tests below (and in
 * truncation.test.ts) so the contract is explicit, not implied.
 */

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BelowFloorError,
  CloudStore,
  RETENTION_KEEP_ALL,
  COMPACT_EVERY_N_OPS,
} from "../src/store";
import { RmDocument } from "@weft/rm-format";
import { polylineToPoints, type Xy } from "@weft/rm-ink/pure";
import {
  applyOps,
  encodeOp,
  encodeSnapshot,
  decodeSnapshot,
  type Op,
  type OverlayDocument,
} from "@weft/sync-engine";

const U = "u";
const D = "doc1";
const P = "page1";
const WEB_AUTHOR = "aaaaaaaa-0000-4000-a000-000000000001";

function freshStore(): CloudStore {
  return new CloudStore(
    join(mkdtempSync(join(tmpdir(), "weft-compact-")), "t.db"),
  );
}

function liveLines(rm: Uint8Array): number {
  return (
    RmDocument.parse(rm).blocks as unknown as {
      type: string;
      deletedLength: number;
    }[]
  ).filter((b) => b.type === "sceneLineItem" && b.deletedLength === 0).length;
}

/** One web stroke's ops against the evolving (doc, overlay) — the real path. */
function webStroke(
  doc: RmDocument,
  overlay: OverlayDocument,
  shapeId: string,
  line: Xy[],
): Op[] {
  const { deltas } = applyOps(
    doc,
    overlay,
    [
      {
        type: "upsert-shape",
        shape: {
          shapeId,
          kind: "draw-native",
          props: {},
          x: 0,
          y: 0,
          rotation: 0,
          renderRevision: shapeId,
          version: { ts: 1, actor: "test" },
        },
        parts: [
          {
            partKey: "p0",
            strokes: [
              { points: polylineToPoints(line, { width: 40 }), color: "black" },
            ],
          },
        ],
      },
    ],
    { authorUuid: WEB_AUTHOR },
  );
  return deltas;
}

/** Shared evolving CRDT state so successive edits mint DISTINCT ids. Returns an
 *  editor that appends one stroke per call and yields the batch head seq. */
function editor(s: CloudStore, user = U, doc_ = D, page = P) {
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  let n = 0;
  return {
    edit(): number {
      const i = n++;
      const ops = webStroke(doc, overlay, `shape:${i}`, [
        { x: 10 + i, y: 10 + i },
        { x: 90 - i, y: 90 - i },
      ]);
      return s.appendOps(user, doc_, page, ops.map(encodeOp), "web").lastSeq;
    },
  };
}

function appendEdits(s: CloudStore, count: number): number[] {
  const e = editor(s);
  return Array.from({ length: count }, () => e.edit());
}

test("keep-all is the default retention stance", () => {
  expect(RETENTION_KEEP_ALL).toBe(true);
});

test("compact() on an empty page is a no-op (nothing to fold)", () => {
  const s = freshStore();
  const r = s.compact(U, D, P);
  expect(r.snapshotSeq).toBeNull();
  expect(r.head).toBe(0);
  expect(r.opsTruncated).toBe(0);
  expect(s.latestSnapshot(U, D, P)).toBeNull();
});

test("compact() creates a snapshot PINNED at the current op head", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 5);
  const head = s.latestOpSeq(U, D, P);
  expect(head).toBe(seqs[seqs.length - 1]);

  const r = s.compact(U, D, P);
  expect(r.snapshotSeq).not.toBeNull();
  expect(r.head).toBe(head);

  const snap = s.latestSnapshot(U, D, P)!;
  // the checkpoint folds in exactly the current head
  expect(snap.opSeq).toBe(head);
  // and its bytes materialize the whole page (all 5 strokes)
  expect(liveLines(decodeSnapshot(snap.bytes).rm)).toBe(5);
});

test("INVARIANT: reconstruct is byte-identical before and after compaction (live + time-travel)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 8);
  const head = s.latestOpSeq(U, D, P);

  // capture live + a spread of time-travel states BEFORE compaction
  const liveBefore = s.reconstructDevicePage(U, D, P).bytes;
  const atBefore = seqs.map((seq) => s.stateAt(U, D, P, seq).rm);

  s.compact(U, D, P);

  // live reconstruct unchanged, byte-for-byte
  const liveAfter = s.reconstructDevicePage(U, D, P).bytes;
  expect([...liveAfter]).toEqual([...liveBefore]);
  // every time-travel point unchanged, byte-for-byte
  seqs.forEach((seq, i) => {
    expect([...s.stateAt(U, D, P, seq).rm]).toEqual([...atBefore[i]!]);
  });
  // stateAt(head) still equals live
  expect([...s.stateAt(U, D, P, head).rm]).toEqual([...liveAfter]);
});

test("keep-all: compaction retains EVERY page_ops row; F2 still reaches the oldest state", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 6);
  const opsBefore = s.opsSince(U, D, P, 0).map((o) => o.seq);

  const r = s.compact(U, D, P); // keep-all default
  expect(r.opsTruncated).toBe(0);

  // not one op removed
  const opsAfter = s.opsSince(U, D, P, 0).map((o) => o.seq);
  expect(opsAfter).toEqual(opsBefore);

  // history still lists every op, and time-travel reaches the oldest state
  const opPts = s.historyPoints(U, D, P).filter((p) => p.kind === "op");
  for (const seq of seqs) expect(opPts.some((p) => p.seq === seq)).toBe(true);
  // the very first edit is still reconstructable (1 stroke at seqs[0])
  expect(liveLines(s.stateAt(U, D, P, seqs[0]!).rm)).toBe(1);
  // and seq=0 is still the empty base
  expect(liveLines(s.stateAt(U, D, P, 0).rm)).toBe(0);
});

test("keep-all compaction does not break revert (F2 revert still restores an old state)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 5);
  s.compact(U, D, P);
  // revert to 2 strokes, still works because every op was retained
  s.revertTo(U, D, P, seqs[1]!);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2);
  // revert the revert -> all 5 back
  s.revertTo(U, D, P, seqs[4]!);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(5);
});

test("retention window: truncates ONLY ops strictly older than the window, keeps the recent tail", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 20);
  const head = s.latestOpSeq(U, D, P);

  // window = keep the most-recent 5 ops. compact folds a checkpoint at head,
  // whose op_seq == head, so the snapshot bound (never delete >= newest
  // snapshot op_seq) does not restrict truncation here; the window does.
  const keepRecentOps = 5;
  const r = s.compact(U, D, P, { keepAll: false, keepRecentOps });
  expect(r.head).toBe(head);
  expect(r.opsTruncated).toBeGreaterThan(0);

  // cutoff = head - keepRecentOps: ops with seq < cutoff are gone, >= cutoff kept
  const cutoff = head - keepRecentOps;
  const remaining = s.opsSince(U, D, P, 0).map((o) => o.seq);
  expect(Math.min(...remaining)).toBeGreaterThanOrEqual(cutoff);
  expect(remaining.some((sq) => sq < cutoff)).toBe(false);
  // and none of the recent-window ops were removed
  for (const seq of seqs.filter((sq) => sq >= cutoff))
    expect(remaining.includes(seq)).toBe(true);
});

test("retention window preserves the LIVE/tail path: live + time-travel(>=H) byte-identical after truncation", () => {
  const s = freshStore();
  appendEdits(s, 20);
  const head = s.latestOpSeq(U, D, P);
  const liveBefore = s.reconstructDevicePage(U, D, P).bytes;
  const atHeadBefore = s.stateAt(U, D, P, head).rm;

  s.compact(U, D, P, { keepAll: false, keepRecentOps: 5 });

  const liveAfter = s.reconstructDevicePage(U, D, P).bytes;
  expect([...liveAfter]).toEqual([...liveBefore]);
  expect([...s.stateAt(U, D, P, head).rm]).toEqual([...atHeadBefore]);
  expect(liveLines(liveAfter)).toBe(20);
});

test("retention window CONTRACT: below the floor is REFUSED (typed), at/above the floor stays byte-identical", () => {
  // Enabling truncation (RETENTION_KEEP_ALL=false) never answers a WRONG
  // reconstruct (#52): targets whose replay ops were deleted sit below the
  // persisted floor and refuse with BelowFloorError (HTTP 410 at the routes);
  // every target at/above the floor keeps a fully-retained base (the boundary
  // checkpoint compact pins at the floor) and reconstructs to the exact
  // pre-truncation bytes — mid-window targets included, which previously
  // silently broke when their older base lost its replay range. The keep-all
  // default (asserted elsewhere) refuses nothing.
  const s = freshStore();
  const seqs = appendEdits(s, 20);
  const head = s.latestOpSeq(U, D, P);
  const keepRecentOps = 5;

  // capture every edit's state BEFORE truncation
  const before = new Map(seqs.map((sq) => [sq, s.stateAt(U, D, P, sq).rm]));

  const r = s.compact(U, D, P, { keepAll: false, keepRecentOps });
  expect(r.opsTruncated).toBeGreaterThan(0);
  const floor = s.truncationFloor(U, D, P);
  expect(floor).toBeGreaterThan(0);
  // targets on both sides of the floor exist, so both branches are exercised
  expect(seqs.some((sq) => sq < floor)).toBe(true);
  expect(seqs.some((sq) => sq >= floor)).toBe(true);

  for (const sq of seqs) {
    if (sq < floor) {
      expect(() => s.stateAt(U, D, P, sq)).toThrow(BelowFloorError);
    } else {
      expect([...s.stateAt(U, D, P, sq).rm]).toEqual([...before.get(sq)!]);
    }
  }

  // The live/tail path is exact too.
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(20);
  expect([...s.stateAt(U, D, P, head).rm]).toEqual([
    ...s.reconstructDevicePage(U, D, P).bytes,
  ]);
});

test("retention window snapshot-bound clamp: window wider than the log truncates nothing (live/tail never starved)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 10);
  // Put an EARLY faithful checkpoint, then compact with a huge window. The
  // snapshot bound clamps the cutoff to the NEWEST snapshot's op_seq; compact
  // writes a new checkpoint at head first, so newest snapshot op_seq == head and
  // the cutoff clamps to (head - hugeWindow) < 0 => NOTHING is truncated. This
  // is a defensive clamp for the LIVE/tail path (never delete an op the latest
  // snapshot + kept tail replays); it is NOT a time-travel guarantee.
  const early = s.stateAt(U, D, P, seqs[2]!);
  s.putSnapshot(U, D, P, encodeSnapshot(early.rm, early.overlay));
  const before = s.opsSince(U, D, P, 0).map((o) => o.seq);

  // keepRecentOps larger than the log -> window bound alone would keep all;
  // this asserts the window never deletes into the tail a reconstruct needs.
  const r = s.compact(U, D, P, { keepAll: false, keepRecentOps: 10_000 });
  expect(r.opsTruncated).toBe(0);
  expect(s.opsSince(U, D, P, 0).map((o) => o.seq)).toEqual(before);
});

test("auto-trigger: crossing a COMPACT_EVERY_N_OPS boundary creates a checkpoint", () => {
  // Drive appendOps past one COMPACT_EVERY_N_OPS boundary. This test is about
  // the TRIGGER firing, so use valid-JSON ops with an UNKNOWN op type: they
  // decode cleanly (stateAt won't throw) and both materializers ignore them
  // (same contract as the revert marker), so the folded checkpoint is cheap.
  if (COMPACT_EVERY_N_OPS <= 0) return;
  const s = freshStore();
  expect(s.latestSnapshot(U, D, P)).toBeNull();

  const opaque = (i: number) =>
    new TextEncoder().encode(JSON.stringify({ type: "x-noop", i }));
  // just below the boundary: no compaction yet
  for (let i = 0; i < COMPACT_EVERY_N_OPS - 1; i++)
    s.appendOps(U, D, P, [opaque(i)], "web");
  expect(s.latestSnapshot(U, D, P)).toBeNull();

  // the op that crosses the boundary fires auto-compaction
  s.appendOps(U, D, P, [opaque(COMPACT_EVERY_N_OPS - 1)], "web");
  const snap = s.latestSnapshot(U, D, P);
  expect(snap).not.toBeNull();
  expect(snap!.opSeq).toBe(COMPACT_EVERY_N_OPS); // pinned at the boundary head
  // keep-all: every op retained despite the auto-compaction.
  expect(s.opsSince(U, D, P, 0).length).toBe(COMPACT_EVERY_N_OPS);
});

test("auto-trigger is a PER-PAGE op count, not the global op-log seq", () => {
  // The trigger counts a page's OWN un-compacted ops (seq > its snapshot op_seq),
  // NOT the store-wide page_ops autoincrement. So one page advancing the global
  // seq near a boundary must NOT cause another page with few ops to compact.
  if (COMPACT_EVERY_N_OPS <= 0) return;
  const s = freshStore();
  const PA = "pageA";
  const PB = "pageB";
  const opaque = (i: number) =>
    new TextEncoder().encode(JSON.stringify({ type: "x-noop", i }));

  // Push page A right up to (but not over) its own per-page threshold, so the
  // GLOBAL seq is now COMPACT_EVERY_N_OPS - 1. Neither page has compacted.
  for (let i = 0; i < COMPACT_EVERY_N_OPS - 1; i++)
    s.appendOps(U, D, PA, [opaque(i)], WEB_AUTHOR);
  expect(s.latestSnapshot(U, D, PA)).toBeNull();
  expect(s.latestSnapshot(U, D, PB)).toBeNull();

  // ONE op to page B lands at global seq == COMPACT_EVERY_N_OPS. Under the fixed
  // per-page trigger, page B has only 1 of its OWN ops, so it must NOT compact —
  // even though the global seq just crossed a multiple.
  s.appendOps(U, D, PB, [opaque(0)], WEB_AUTHOR);
  expect(s.latestSnapshot(U, D, PB)).toBeNull(); // 1 own op -> no compaction

  // One more op to page A takes A to COMPACT_EVERY_N_OPS of its OWN ops -> A
  // compacts (pinned at A's real head), B still hasn't.
  s.appendOps(U, D, PA, [opaque(COMPACT_EVERY_N_OPS)], WEB_AUTHOR);
  const snapA = s.latestSnapshot(U, D, PA);
  expect(snapA).not.toBeNull();
  expect(snapA!.opSeq).toBe(s.latestOpSeq(U, D, PA)); // pinned at A's real head
  expect(s.latestSnapshot(U, D, PB)).toBeNull();
  // keep-all retains every op on both pages
  expect(s.opsSince(U, D, PB, 0).length).toBe(1);
  expect(s.opsSince(U, D, PA, 0).length).toBe(COMPACT_EVERY_N_OPS);
});

test("compaction is isolated per user and per page", () => {
  const s = freshStore();
  appendEdits(s, 4); // (U, D, P)
  // another user's identical coordinates: compacting theirs is a no-op and
  // does not touch U's snapshot/log.
  const r = s.compact("other", D, P);
  expect(r.snapshotSeq).toBeNull();
  expect(s.latestSnapshot("other", D, P)).toBeNull();
  // U compacts -> only U gets a snapshot
  s.compact(U, D, P);
  expect(s.latestSnapshot(U, D, P)).not.toBeNull();
  expect(s.latestSnapshot("other", D, P)).toBeNull();
});
