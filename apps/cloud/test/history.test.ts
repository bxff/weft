/**
 * #51 (F2, D3): history + time-travel + revert on the op log + snapshots.
 *
 * Reconstruct at op seq T = latest snapshot with op_seq <= T + replay ops in
 * (snapshot.op_seq, T] (reuses reconstructRm/applyRemoteOps). ONE snapshot rule
 * for both live and time-travel (newest snapshot by seq, revert or not), so
 * stateAt(head) == the live reconstruct even after a revert. A revert appends a
 * no-op marker op (advancing the head) then pins a checkpoint of the past state
 * at that new head: the reverted-away ops are RETAINED strictly below the marker,
 * so the revert is itself revertible (raw-replay restores the future).
 *
 * Store-level tests build ops via the real client path (applyOps -> deltas), so
 * the reconstructed .rm is byte-for-byte what a peer replaying the log gets.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudStore, SNAPSHOT_KEEP } from "../src/store";
import { startCloud, type CloudServer } from "../src/server";
import { RmDocument } from "@weft/rm-format";
import { polylineToPoints, type Xy } from "@weft/rm-ink/pure";
import {
  applyOps,
  encodeOp,
  decodeOp,
  encodeSnapshot,
  decodeSnapshot,
  reconstructRm,
  foldOverlayOps,
  type Op,
  type OverlayDocument,
} from "@weft/sync-engine";

// the store seeds an empty reconstructed doc under this author (DEVICE_BRIDGE_AUTHOR)
const RECON_AUTHOR = "c10d0000-0000-4000-a000-000000000001";

const U = "u";
const D = "doc1";
const P = "page1";
const WEB_AUTHOR = "aaaaaaaa-0000-4000-a000-000000000001";

function freshStore(): CloudStore {
  return new CloudStore(
    join(mkdtempSync(join(tmpdir(), "weft-history-")), "t.db"),
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

/** One web stroke's ops against the evolving (doc, overlay) — the real capture path. */
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

/**
 * Shared evolving CRDT state so successive edits mint DISTINCT ids (a fresh
 * empty doc per call would restart the author clock and collide). Each call to
 * `edit()` appends one stroke as its own op-batch and returns its head seq.
 */
function editor(s: CloudStore, user = U, doc_ = D, page = P) {
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  let n = 0;
  return {
    /** Append one stroke edit; returns the batch's head op seq. */
    edit(): number {
      return this.editShape(`shape:${n}`);
    },
    /** Append one stroke edit under an explicit shapeId (for overlay asserts);
     *  returns the batch's head op seq. */
    editShape(shapeId: string): number {
      const i = n++;
      const ops = webStroke(doc, overlay, shapeId, [
        { x: 10 + i, y: 10 + i },
        { x: 90 - i, y: 90 - i },
      ]);
      return s.appendOps(user, doc_, page, ops.map(encodeOp), "web").lastSeq;
    },
  };
}

/** Append K stroke edits (shared state); return the head seq after each. */
function appendEdits(s: CloudStore, count: number): number[] {
  const e = editor(s);
  return Array.from({ length: count }, () => e.edit());
}

test("historyPoints lists every op in chronological order", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 4); // 4 edits -> N ops (each edit is >1 op)
  const points = s.historyPoints(U, D, P);
  const opPoints = points.filter((p) => p.kind === "op");
  // one point per stored op, and every op seq present exactly once
  expect(opPoints.length).toBe(s.opsSince(U, D, P, 0).length);
  // strictly ascending by seq (chronological)
  expect(opPoints.map((p) => p.seq)).toEqual(
    [...opPoints.map((p) => p.seq)].sort((a, b) => a - b),
  );
  // each edit's batch-head seq is present in the timeline
  for (const seq of seqs)
    expect(opPoints.some((p) => p.seq === seq)).toBe(true);
  expect(opPoints.every((p) => p.author === "web")).toBe(true);
});

test("historyPoints interleaves snapshots at their folded-in op head", () => {
  const s = freshStore();
  appendEdits(s, 2);
  const headBeforeSnap = s.latestOpSeq(U, D, P);
  s.putSnapshot(U, D, P, new Uint8Array([1, 2, 3]));
  appendEdits(s, 1);

  const points = s.historyPoints(U, D, P);
  const snap = points.find((p) => p.kind === "snapshot");
  expect(snap).toBeTruthy();
  // the snapshot marks the op head it folded in
  expect(snap!.seq).toBe(headBeforeSnap);
});

test("stateAt(seq=K) equals replaying exactly K ops (byte-identical)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 4);

  // Independently replay the first K batches from the raw op log into a doc,
  // and compare bytes with stateAt at that same op seq.
  for (let k = 1; k <= seqs.length; k++) {
    const targetSeq = seqs[k - 1]!;
    const allOps = s.opsSince(U, D, P, 0).filter((o) => o.seq <= targetSeq);
    const expected = reconstructRm(
      null,
      allOps.map((o) => decodeOp(o.op)),
      RECON_AUTHOR,
    );
    const at = s.stateAt(U, D, P, targetSeq);
    expect([...at.rm]).toEqual([...expected]);
    // and it has exactly k live strokes
    expect(liveLines(at.rm)).toBe(k);
  }
});

test("stateAt with an intermediate snapshot matches full replay", () => {
  const s = freshStore();
  const e = editor(s); // shared state -> 4 distinct strokes across the batches
  e.edit();
  const seq2 = e.edit();
  // checkpoint the current state (a faithful, non-revert snapshot), then two more edits
  const past = s.stateAt(U, D, P, seq2);
  s.putSnapshot(U, D, P, encodeSnapshot(past.rm, past.overlay));
  e.edit();
  const target = e.edit();

  // stateAt(target) uses the snapshot + replay; must equal pure full replay
  const at = s.stateAt(U, D, P, target);
  const allOps = s.opsSince(U, D, P, 0).filter((o) => o.seq <= target);
  const expected = reconstructRm(
    null,
    allOps.map((o) => decodeOp(o.op)),
    RECON_AUTHOR,
  );
  expect([...at.rm]).toEqual([...expected]);
  expect(liveLines(at.rm)).toBe(4);
});

test("revertTo makes the live reconstruct equal a past state AND keeps the full log", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 4); // 4 strokes
  const headBefore = s.latestOpSeq(U, D, P);
  const opCountBefore = s.opsSince(U, D, P, 0).length;
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(4);

  // revert to after the 2nd stroke -> live state should show exactly 2
  const target = seqs[1]!;
  const pastState = s.stateAt(U, D, P, target);
  const res = s.revertTo(U, D, P, target);
  expect(res.opHead).toBe(headBefore); // the head the revert was taken AT

  // live reconstruct now equals the past state (2 strokes), byte-identical
  const live = s.reconstructDevicePage(U, D, P).bytes;
  expect(liveLines(live)).toBe(2);
  expect([...live]).toEqual([...pastState.rm]);

  // Nothing DELETED on revert: every pre-revert op seq is still present. The
  // head advances by exactly one — the no-op revert MARKER op — which is how the
  // reverted-away ops (now strictly below the marker) stay recoverable. The
  // original edit ops are untouched.
  const seqsAfter = s.opsSince(U, D, P, 0).map((o) => o.seq);
  for (const seq of seqs) expect(seqsAfter.includes(seq)).toBe(true);
  expect(seqsAfter.length).toBe(opCountBefore + 1); // +1 marker, none removed
  expect(s.latestOpSeq(U, D, P)).toBe(headBefore + 1);
  // the added op is the revert marker (surfaced as a distinct 'revert' point)
  const revertPts = s.historyPoints(U, D, P).filter((p) => p.kind === "revert");
  expect(revertPts.length).toBe(1);
  expect(revertPts[0]!.seq).toBe(headBefore + 1);
});

test("the revert is itself revertible (revert the revert restores the future)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 4);
  const head = s.latestOpSeq(U, D, P);

  // 1) revert back to 2 strokes
  s.revertTo(U, D, P, seqs[1]!);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2);

  // 2) revert the revert: go to the original head (all 4 strokes) — the ops
  //    were retained, so stateAt(head) still reconstructs all 4.
  s.revertTo(U, D, P, head);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(4);
});

// ----- the core time-travel<->live coherence the feature hinges on (F2 review) -----

test("stateAt(head) equals the live reconstruct AFTER a revert (single rule)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 4);

  // revert to 2 strokes, then assert the time-travel head and the LIVE device
  // reconstruct agree byte-for-byte — the divergence the review proved must be gone.
  s.revertTo(U, D, P, seqs[1]!);
  const head = s.latestOpSeq(U, D, P);
  const at = s.stateAt(U, D, P, head);
  const live = s.reconstructDevicePage(U, D, P).bytes;
  expect([...at.rm]).toEqual([...live]);
  expect(liveLines(at.rm)).toBe(2);
  expect(liveLines(live)).toBe(2);
});

test("a post-revert edit is reflected in BOTH stateAt(head) and the live reconstruct", () => {
  const s = freshStore();
  const e = editor(s);
  e.edit();
  const seq2 = e.edit();
  e.edit();
  e.edit(); // 4 strokes on the log

  // revert to 2, THEN draw a NEW stroke (the exact edge case the review flagged).
  s.revertTo(U, D, P, seq2);
  e.edit(); // a 5th stroke, appended after the revert

  const head = s.latestOpSeq(U, D, P);
  const at = s.stateAt(U, D, P, head);
  const live = s.reconstructDevicePage(U, D, P).bytes;
  // reverted-away strokes stay gone; the kept 2 + the 1 new = 3, on BOTH paths.
  expect(liveLines(live)).toBe(3);
  expect(liveLines(at.rm)).toBe(3);
  expect([...at.rm]).toEqual([...live]);
  // and there is a seq (head) whose stateAt equals 'now' — the review's (c).
});

test("stateAt for a seq BEFORE a revert still shows the truthful pre-revert state", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 4); // strokes at seqs[0..3]

  // revert to 2 strokes (pins a marker + snapshot above the original head)...
  s.revertTo(U, D, P, seqs[1]!);
  // ...but time-travel to the 3rd edit's seq must still reconstruct 3 strokes:
  // the revert marker (op_seq > seqs[2]) is excluded, so the retained log replays.
  expect(liveLines(s.stateAt(U, D, P, seqs[2]!).rm)).toBe(3);
  expect(liveLines(s.stateAt(U, D, P, seqs[3]!).rm)).toBe(4);
  // and time-travel AT/after the revert head shows the reverted 2 strokes.
  expect(liveLines(s.stateAt(U, D, P, s.latestOpSeq(U, D, P)).rm)).toBe(2);
});

test("a revert snapshot survives >SNAPSHOT_KEEP faithful checkpoints (no silent un-revert)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 4);

  // revert to 2 strokes
  s.revertTo(U, D, P, seqs[1]!);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2);

  // now write MORE than SNAPSHOT_KEEP ordinary faithful checkpoints of the
  // current (reverted) live state — the churn that used to prune the revert
  // marker away and silently restore the un-reverted 4 strokes.
  for (let i = 0; i < SNAPSHOT_KEEP + 3; i++) {
    const cur = s.reconstructDevicePage(U, D, P).bytes;
    s.putSnapshot(U, D, P, encodeSnapshot(cur, { shapes: [] }));
  }

  // the revert marker is exempt from pruning, so the live state is STILL reverted.
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2);
  expect(liveLines(s.stateAt(U, D, P, s.latestOpSeq(U, D, P)).rm)).toBe(2);
  // and the revert is still there to be recovered from (full log retained).
  s.revertTo(U, D, P, seqs[3]!);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(4);
});

test("/history represents a revert as a distinct point on the timeline", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 3);
  expect(s.historyPoints(U, D, P).some((p) => p.kind === "revert")).toBe(false);

  s.revertTo(U, D, P, seqs[0]!);
  const pts = s.historyPoints(U, D, P);
  const reverts = pts.filter((p) => p.kind === "revert");
  expect(reverts.length).toBe(1);
  // the revert point sits after every original edit op (it advanced the head)
  const maxOp = Math.max(
    ...pts.filter((p) => p.kind === "op").map((p) => p.seq),
  );
  expect(reverts[0]!.seq).toBeGreaterThan(maxOp);
  // and a snapshot checkpoint is co-located at the revert's op head
  expect(
    pts.some((p) => p.kind === "snapshot" && p.seq === reverts[0]!.seq),
  ).toBe(true);
});

// ----- edge cases the contract implies (spec: "detailed tests for ALL edge cases") -----

test("stateAt(seq=0) is the empty base state (no snapshot, no ops replayed)", () => {
  const s = freshStore();
  appendEdits(s, 3); // ops exist, but seq=0 must ignore all of them
  const at = s.stateAt(U, D, P, 0);
  expect(liveLines(at.rm)).toBe(0);
  expect(at.overlay.shapes.length).toBe(0);
});

test("stateAt(seq > head) clamps to head (byte-identical, not an error)", () => {
  const s = freshStore();
  appendEdits(s, 3);
  const head = s.latestOpSeq(U, D, P);
  const atHead = s.stateAt(U, D, P, head);
  const beyond = s.stateAt(U, D, P, head + 100);
  // clamping means every op <= head replays and nothing past head exists
  expect([...beyond.rm]).toEqual([...atHead.rm]);
  expect(beyond.overlay).toEqual(atHead.overlay);
  expect(liveLines(beyond.rm)).toBe(3);
});

test("revertTo(seq > head) equals revertTo(head) (clamped, not an error)", () => {
  const s = freshStore();
  appendEdits(s, 3);
  const head = s.latestOpSeq(U, D, P);
  const liveBefore = s.reconstructDevicePage(U, D, P).bytes;
  s.revertTo(U, D, P, head + 100); // clamps to head -> a no-op revert
  const liveAfter = s.reconstructDevicePage(U, D, P).bytes;
  expect(liveLines(liveAfter)).toBe(liveLines(liveBefore));
  expect([...liveAfter]).toEqual([...liveBefore]);
  // the full log is still intact (marker included)
  expect(s.opsSince(U, D, P, 0).length).toBeGreaterThanOrEqual(3);
});

test("a raw client replay of the FULL log (revert marker included) is well-formed", () => {
  // A client that replays opsSince(0) — decoding every blob, marker included —
  // must not throw and must converge on the same state as stateAt(head): the
  // {op:'revert-marker'} blob is ignored by type-filtering in reconstructRm and
  // foldOverlayOps.
  const s = freshStore();
  const e = editor(s);
  e.editShape("shape:a");
  e.editShape("shape:b");
  const second = s.latestOpSeq(U, D, P);
  e.editShape("shape:c");
  s.revertTo(U, D, P, second); // appends the marker op to the log

  const raw = s.opsSince(U, D, P, 0).map((r) => decodeOp(r.op));
  expect(raw.some((o) => (o as { op: string }).op === "revert-marker")).toBe(
    true,
  );
  const rm = reconstructRm(null, raw, RECON_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  foldOverlayOps(overlay, raw);
  // The raw replay materializes every RETAINED op (all 3 strokes + all 3
  // overlay objects — the log keeps the reverted-away future; the revert's
  // truncation-to-past lives in the SNAPSHOT layer, not the log). The point
  // here: the marker neither throws nor perturbs either channel.
  expect(liveLines(rm)).toBe(3);
  expect(overlay.shapes.map((sh) => sh.shapeId).sort()).toEqual([
    "shape:a",
    "shape:b",
    "shape:c",
  ]);
});

test("revertTo(0) clears the page to base while RETAINING the full op log", () => {
  const s = freshStore();
  appendEdits(s, 4);
  const headBefore = s.latestOpSeq(U, D, P);
  const opCountBefore = s.opsSince(U, D, P, 0).length;
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(4);

  const res = s.revertTo(U, D, P, 0);
  expect(res.opHead).toBe(headBefore); // the head the revert was taken AT

  // live head is now the empty base state
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(0);
  // nothing deleted: every original edit op is still present (head advanced by
  // one marker op), so the revert itself is revertible (revertTo(head) -> 4).
  expect(s.opsSince(U, D, P, 0).length).toBe(opCountBefore + 1); // +1 marker only
  expect(s.latestOpSeq(U, D, P)).toBe(headBefore + 1);
  s.revertTo(U, D, P, headBefore);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(4);
});

test("overlay half of stateAt is reconstructed and round-trips through revert", () => {
  const s = freshStore();
  const e = editor(s);
  const seq1 = e.editShape("shape:a");
  const seq2 = e.editShape("shape:b");

  // time-travel: the overlay reflects exactly the shapes present at each seq
  expect(s.stateAt(U, D, P, seq1).overlay.shapes.map((x) => x.shapeId)).toEqual(
    ["shape:a"],
  );
  const at2 = s.stateAt(U, D, P, seq2);
  expect(at2.overlay.shapes.map((x) => x.shapeId).sort()).toEqual([
    "shape:a",
    "shape:b",
  ]);

  // revert to seq1: the checkpoint published by the revert must ENCODE the
  // past overlay (only shape:a), not drop it. The revert snapshot is what
  // bootstrap/reconstruct reads back, so decode it and assert the overlay
  // survived encodeSnapshot -> disk -> decodeSnapshot round-trip.
  s.revertTo(U, D, P, seq1);
  const snap = s.latestSnapshot(U, D, P);
  expect(snap).toBeTruthy();
  const revertedOverlay = decodeSnapshot(snap!.bytes).overlay;
  expect(revertedOverlay.shapes.map((x) => x.shapeId)).toEqual(["shape:a"]);
  // and the ink half of the same checkpoint carries exactly the seq1 stroke
  expect(liveLines(decodeSnapshot(snap!.bytes).rm)).toBe(1);
});

test("history/stateAt/revert are isolated per user", () => {
  const s = freshStore();
  // user U populates (U, D, P); a second user must see nothing there.
  const seqs = appendEdits(s, 3);
  const OTHER = "other-user";

  // another user's timeline on the SAME (doc, page) coordinates is empty
  expect(s.historyPoints(OTHER, D, P).length).toBe(0);
  expect(s.latestOpSeq(OTHER, D, P)).toBe(0);
  // and reconstructing at U's head seq under the other user yields base state,
  // i.e. it does not read U's data.
  const otherAt = s.stateAt(OTHER, D, P, seqs[2]!);
  expect(liveLines(otherAt.rm)).toBe(0);
  expect(otherAt.overlay.shapes.length).toBe(0);

  // the other user reverting their (empty) page must NOT touch U's live state
  const uOpsBefore = s.opsSince(U, D, P, 0).length;
  s.revertTo(OTHER, D, P, seqs[2]!);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(3);
  expect(s.opsSince(U, D, P, 0).length).toBe(uOpsBefore); // U's log untouched
  expect(liveLines(s.reconstructDevicePage(OTHER, D, P).bytes)).toBe(0);
});

// ----- HTTP routes -----

let server: CloudServer;
let base: string;
const TOK = "dev:history";
const h = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOK}`,
  ...extra,
});

beforeAll(() => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop());

const HDOC = "hdoc";
const HPAGE = "hpage";

async function postOps(ops: Op[]): Promise<number> {
  const r = await fetch(`${base}/api/documents/${HDOC}/pages/${HPAGE}/ops`, {
    method: "POST",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({
      ops: ops.map((o) => Buffer.from(encodeOp(o)).toString("base64")),
      author: "web",
    }),
  });
  expect(r.status).toBe(200);
  return (await r.json()).lastSeq as number;
}

test("GET /history lists points; GET /at?seq=K matches; POST /revert reverts and keeps history", async () => {
  // build 3 edits through the real HTTP op channel
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  const seqs: number[] = [];
  for (let i = 0; i < 3; i++) {
    seqs.push(
      await postOps(
        webStroke(doc, overlay, `s:${i}`, [
          { x: i, y: i },
          { x: 50, y: 50 },
        ]),
      ),
    );
  }

  // history lists all three ops in order
  const hist = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/history`,
    { headers: h() },
  );
  expect(hist.status).toBe(200);
  const histBody = (await hist.json()) as {
    points: { seq: number; kind: string }[];
    head: number;
  };
  expect(histBody.head).toBe(seqs[2]);
  const opSeqs = histBody.points
    .filter((p) => p.kind === "op")
    .map((p) => p.seq);
  expect(opSeqs).toEqual([...opSeqs].sort((a, b) => a - b));
  for (const s of seqs) expect(opSeqs.includes(s)).toBe(true);

  // at?seq= second edit -> 2 live strokes; bad seq -> 400
  const at = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/at?seq=${seqs[1]}`,
    {
      headers: h(),
    },
  );
  expect(at.status).toBe(200);
  expect(at.headers.get("x-snapshot-op-seq")).toBe(String(seqs[1]));
  const container = new Uint8Array(await at.arrayBuffer());
  expect(liveLines(decodeSnapshot(container).rm)).toBe(2);
  const bad = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/at?seq=-1`,
    { headers: h() },
  );
  expect(bad.status).toBe(400);
  const missing = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/at`,
    { headers: h() },
  );
  expect(missing.status).toBe(400);

  // revert to the second edit -> live /rm reconstruct has 2 strokes
  const rev = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/revert`,
    {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({ toSeq: seqs[1] }),
    },
  );
  expect(rev.status).toBe(200);
  const revBody = (await rev.json()) as { opHead: number };
  expect(revBody.opHead).toBe(seqs[2]);

  const liveRm = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/rm`,
    { headers: h() },
  );
  expect(liveLines(new Uint8Array(await liveRm.arrayBuffer()))).toBe(2);

  // history is intact: all 3 ops still present after the revert
  const hist2 = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/history`,
    { headers: h() },
  );
  const hist2Body = (await hist2.json()) as {
    points: { seq: number; kind: string }[];
  };
  const op2 = hist2Body.points.filter((p) => p.kind === "op").map((p) => p.seq);
  for (const s of seqs) expect(op2.includes(s)).toBe(true);

  // revert the revert (back to head) restores all 3 strokes
  const rev2 = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/revert`,
    {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({ toSeq: seqs[2] }),
    },
  );
  expect(rev2.status).toBe(200);
  const liveRm2 = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/rm`,
    { headers: h() },
  );
  expect(liveLines(new Uint8Array(await liveRm2.arrayBuffer()))).toBe(3);

  // bad revert body -> 400
  const badRev = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/revert`,
    {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({ toSeq: "nope" }),
    },
  );
  expect(badRev.status).toBe(400);
});

test("GET /at?seq=head equals live /rm after a revert + a post-revert edit", async () => {
  // isolate on a fresh (doc, page) so the shared editor state is clean.
  const RDOC = "rdoc";
  const RPAGE = "rpage";
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  const postOpsTo = async (ops: Op[]): Promise<number> => {
    const r = await fetch(`${base}/api/documents/${RDOC}/pages/${RPAGE}/ops`, {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({
        ops: ops.map((o) => Buffer.from(encodeOp(o)).toString("base64")),
        author: "web",
      }),
    });
    expect(r.status).toBe(200);
    return (await r.json()).lastSeq as number;
  };
  const seqs: number[] = [];
  for (let i = 0; i < 4; i++) {
    seqs.push(
      await postOpsTo(
        webStroke(doc, overlay, `r:${i}`, [
          { x: i, y: i },
          { x: 60, y: 60 },
        ]),
      ),
    );
  }

  // revert to 2 strokes, then draw a NEW stroke through the op channel.
  const rev = await fetch(
    `${base}/api/documents/${RDOC}/pages/${RPAGE}/revert`,
    {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({ toSeq: seqs[1] }),
    },
  );
  expect(rev.status).toBe(200);
  await postOpsTo(
    webStroke(doc, overlay, "r:new", [
      { x: 5, y: 5 },
      { x: 70, y: 70 },
    ]),
  );

  // head from /history, then /at?seq=head must equal the live /rm byte-for-byte.
  const hist = await fetch(
    `${base}/api/documents/${RDOC}/pages/${RPAGE}/history`,
    { headers: h() },
  );
  const head = ((await hist.json()) as { head: number }).head;
  const at = await fetch(
    `${base}/api/documents/${RDOC}/pages/${RPAGE}/at?seq=${head}`,
    { headers: h() },
  );
  const atRm = decodeSnapshot(new Uint8Array(await at.arrayBuffer())).rm;
  const live = await fetch(`${base}/api/documents/${RDOC}/pages/${RPAGE}/rm`, {
    headers: h(),
  });
  const liveRm = new Uint8Array(await live.arrayBuffer());
  expect([...atRm]).toEqual([...liveRm]); // time-travel head == live 'now'
  expect(liveLines(liveRm)).toBe(3); // kept 2 + 1 post-revert stroke
  expect(liveLines(atRm)).toBe(3);
});

test("GET /at?seq beyond head reports the EFFECTIVE seq in x-snapshot-op-seq", async () => {
  // stateAt clamps seq>head to head; the header must advertise the clamped seq
  // (a cursor that exists), not echo the raw request.
  const hist = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/history`,
    { headers: h() },
  );
  const head = ((await hist.json()) as { head: number }).head;
  expect(head).toBeGreaterThan(0);
  const at = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/at?seq=${head + 1000}`,
    { headers: h() },
  );
  expect(at.status).toBe(200);
  expect(at.headers.get("x-snapshot-op-seq")).toBe(String(head));
});

test("user B's token sees an empty history/state for user A's page (auth isolation)", async () => {
  // user A (TOK -> dev user "history") owns (HDOC, HPAGE) from the test above.
  // A second Bearer token maps to a DIFFERENT dev user; it must not read A's
  // timeline or reconstruct A's data on the same (doc, page) coordinates.
  const otherTok = `${TOK}-b`;
  const hB = { authorization: `Bearer ${otherTok}` };

  // /history for B is empty (head 0, no points) — B cannot read A's timeline.
  const hist = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/history`,
    { headers: hB },
  );
  expect(hist.status).toBe(200);
  const body = (await hist.json()) as { points: unknown[]; head: number };
  expect(body.head).toBe(0);
  expect(body.points.length).toBe(0);

  // /at at any seq under B reconstructs the empty base state, never A's strokes.
  const at = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/at?seq=999`,
    { headers: hB },
  );
  expect(at.status).toBe(200);
  expect(
    liveLines(decodeSnapshot(new Uint8Array(await at.arrayBuffer())).rm),
  ).toBe(0);

  // B reverting their (empty) page must not disturb A's live head.
  const rev = await fetch(
    `${base}/api/documents/${HDOC}/pages/${HPAGE}/revert`,
    {
      method: "POST",
      headers: { ...hB, "content-type": "application/json" },
      body: JSON.stringify({ toSeq: 999 }),
    },
  );
  expect(rev.status).toBe(200);
  const aLive = await fetch(`${base}/api/documents/${HDOC}/pages/${HPAGE}/rm`, {
    headers: h(),
  });
  expect(liveLines(new Uint8Array(await aLive.arrayBuffer()))).toBe(3);
});

// ----- restore by SNAPSHOT seq (tablet-authored checkpoints) -----
// The owner's real failure: a page only ever written from the TABLET has many
// snapshots (one per daemon push) all pinned at op_seq 0 and ZERO ops. Op seqs
// cannot address those states (head=0, every checkpoint "is" seq 0), so the
// panel could never offer restore and revertTo would always pick the newest.

/** A standalone snapshot container holding `k` strokes (distinct content). */
function snapshotWithStrokes(k: number): Uint8Array {
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  for (let i = 0; i < k; i++) {
    applyOps(
      doc,
      overlay,
      [
        {
          type: "upsert-shape",
          shape: {
            shapeId: `shape:${i}`,
            kind: "draw-native",
            props: {},
            x: 0,
            y: 0,
            rotation: 0,
            renderRevision: `r${i}`,
            version: { ts: 1, actor: "test" },
          },
          parts: [
            {
              partKey: "p0",
              strokes: [
                {
                  points: polylineToPoints(
                    [
                      { x: 10 + i, y: 10 },
                      { x: 90, y: 90 - i },
                    ],
                    { width: 40 },
                  ),
                  color: "black",
                },
              ],
            },
          ],
        },
      ],
      { authorUuid: WEB_AUTHOR },
    );
  }
  return encodeSnapshot(doc.serialize(), overlay);
}

test("tablet-only page: distinct snapshots at op_seq 0 are addressable and restorable by snapSeq", () => {
  const s = freshStore();
  const older = s.putSnapshot(U, D, P, snapshotWithStrokes(1)); // tablet push 1
  const newer = s.putSnapshot(U, D, P, snapshotWithStrokes(3)); // tablet push 2
  expect(s.latestOpSeq(U, D, P)).toBe(0); // zero ops — the owner's shape

  // historyPoints exposes each snapshot's OWN seq (the restore handle)
  const points = s.historyPoints(U, D, P);
  const snapPoints = points.filter((p) => p.kind === "snapshot");
  expect(snapPoints.map((p) => p.snapSeq)).toEqual([older, newer]);
  expect(snapPoints.every((p) => p.seq === 0)).toBe(true); // op seq is useless here

  // live state = the newer push (3 strokes)
  expect(liveLines(s.stateAt(U, D, P, s.latestOpSeq(U, D, P)).rm)).toBe(3);

  // restore the OLDER tablet state by its snapshot seq
  const res = s.revertToSnapshot(U, D, P, older);
  expect(res).not.toBeNull();
  const head = s.latestOpSeq(U, D, P);
  expect(head).toBe(res!.newHead);
  expect(head).toBeGreaterThan(0); // the marker advanced the head
  expect(liveLines(s.stateAt(U, D, P, head).rm)).toBe(1); // older state is live

  // nothing was lost: both original snapshots still exist, newer still readable
  expect(s.getSnapshotBytes(U, D, P, newer)).not.toBeNull();
  const back = s.revertToSnapshot(U, D, P, newer);
  expect(liveLines(s.stateAt(U, D, P, back!.newHead).rm)).toBe(3);
});

test("revertToSnapshot of a pruned/unknown snapshot returns null (no state change)", () => {
  const s = freshStore();
  s.putSnapshot(U, D, P, snapshotWithStrokes(2));
  const headBefore = s.latestOpSeq(U, D, P);
  expect(s.revertToSnapshot(U, D, P, 99999)).toBeNull();
  expect(s.latestOpSeq(U, D, P)).toBe(headBefore); // no marker appended
});
