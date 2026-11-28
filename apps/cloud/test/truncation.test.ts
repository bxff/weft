/**
 * F1 (#52): SAFE, tunable op-log truncation. Retention (RETENTION_KEEP_ALL=
 * false, injected per-call via compact opts — the const stays keep-all) now
 * ships with:
 *  - a PERSISTED per-page truncation floor (page_floors): the highest op seq
 *    deleted, set atomically with the DELETE, never derived from MIN(seq);
 *  - the /ops GAP SIGNAL: a cursor below the floor gets HTTP 410 { error,
 *    floorSeq } (a normal 200 would hand back a gapped log and the client
 *    would silently diverge); normal 200s carry `floor`;
 *  - the HISTORY CLAMP: stateAt/revertTo below the floor refuse (typed
 *    BelowFloorError; 410 on /at and /revert), at/above the floor stays
 *    byte-correct (compact pins a boundary checkpoint at the floor);
 *  - keep-all pages keep floor 0 and behave exactly as before.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BelowFloorError, CloudStore, HistoryCheckpointError } from "../src/store";
import { startCloud, type CloudServer } from "../src/server";
import { Pen, PenColor, RmDocument, crdtId } from "@weft/rm-format";
import { polylineToPoints, type Xy } from "@weft/rm-ink/pure";
import {
  applyOps,
  encodeOp,
  decodeSnapshot,
  encodeSnapshot,
  type Op,
  type OverlayDocument,
} from "@weft/sync-engine";

const U = "u";
const D = "doc1";
const P = "page1";
const WEB_AUTHOR = "aaaaaaaa-0000-4000-a000-000000000001";

function freshStore(): CloudStore {
  return new CloudStore(
    join(mkdtempSync(join(tmpdir(), "weft-trunc-")), "t.db"),
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

// ----- (a) compact truncates, sets the floor, live reconstruct exact -----

test("truncating compact sets the persisted floor and keeps the LIVE reconstruct byte-identical", () => {
  const s = freshStore();
  appendEdits(s, 20);
  const head = s.latestOpSeq(U, D, P);
  const liveBefore = s.reconstructDevicePage(U, D, P).bytes;
  expect(s.truncationFloor(U, D, P)).toBe(0);

  const keepRecentOps = 5;
  const r = s.compact(U, D, P, { keepAll: false, keepRecentOps });
  expect(r.opsTruncated).toBeGreaterThan(0);

  // the floor is the highest truncated-away seq: positive, strictly below the
  // cutoff, and no retained op sits at/below it
  const cutoff = head - keepRecentOps;
  const floor = s.truncationFloor(U, D, P);
  expect(floor).toBeGreaterThan(0);
  expect(floor).toBeLessThan(cutoff);
  const remaining = s.opsSince(U, D, P, 0).map((o) => o.seq);
  expect(Math.min(...remaining)).toBeGreaterThan(floor);
  expect(Math.min(...remaining)).toBeGreaterThanOrEqual(cutoff);

  // the LIVE reconstruct is byte-identical to before the truncation
  expect([...s.reconstructDevicePage(U, D, P).bytes]).toEqual([...liveBefore]);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(20);
});

test("the floor is durable (a reopened store reads the same floor) and monotonic", () => {
  const path = join(mkdtempSync(join(tmpdir(), "weft-trunc-")), "t.db");
  const s = new CloudStore(path);
  const e = editor(s);
  for (let i = 0; i < 12; i++) e.edit();
  s.compact(U, D, P, { keepAll: false, keepRecentOps: 3 });
  const floor = s.truncationFloor(U, D, P);
  expect(floor).toBeGreaterThan(0);

  // durable: NOT derived from MIN(page_ops.seq) — a second connection to the
  // same DB file reads the persisted value
  const reopened = new CloudStore(path);
  expect(reopened.truncationFloor(U, D, P)).toBe(floor);

  // monotonic: more edits + a second truncating compact only raises it
  for (let i = 0; i < 12; i++) e.edit();
  s.compact(U, D, P, { keepAll: false, keepRecentOps: 3 });
  expect(s.truncationFloor(U, D, P)).toBeGreaterThan(floor);
});

// ----- (b) opsSince around the floor -----

test("opsSince(since >= floor) returns the complete retained tail (nothing gapped)", () => {
  const s = freshStore();
  appendEdits(s, 20);
  const head = s.latestOpSeq(U, D, P);
  s.compact(U, D, P, { keepAll: false, keepRecentOps: 5 });
  const floor = s.truncationFloor(U, D, P);

  // from the floor onward the retained log is complete: identical to a full
  // scan (every surviving op has seq > floor)
  const fromFloor = s.opsSince(U, D, P, floor).map((o) => o.seq);
  const all = s.opsSince(U, D, P, 0).map((o) => o.seq);
  expect(fromFloor).toEqual(all);
  expect(fromFloor.length).toBeGreaterThan(0);
  // and from the head there is nothing left to pull
  expect(s.opsSince(U, D, P, head)).toEqual([]);
});

// ----- (c) history clamp: stateAt / revertTo -----

test("stateAt/revertTo below the floor refuse with BelowFloorError; at/above reconstruct exact bytes", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 20);
  const head = s.latestOpSeq(U, D, P);
  const before = new Map(seqs.map((sq) => [sq, s.stateAt(U, D, P, sq).rm]));

  s.compact(U, D, P, { keepAll: false, keepRecentOps: 5 });
  const floor = s.truncationFloor(U, D, P);
  const below = seqs.filter((sq) => sq < floor);
  const atOrAbove = seqs.filter((sq) => sq >= floor);
  expect(below.length).toBeGreaterThan(0);
  expect(atOrAbove.length).toBeGreaterThan(0);

  for (const sq of below) {
    expect(() => s.stateAt(U, D, P, sq)).toThrow(BelowFloorError);
    expect(() => s.revertTo(U, D, P, sq)).toThrow(BelowFloorError);
  }
  // the typed error carries the floor (routes surface it as 410 floorSeq)
  try {
    s.stateAt(U, D, P, below[0]!);
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(BelowFloorError);
    expect((e as BelowFloorError).floorSeq).toBe(floor);
  }
  // stateAt AT the floor works (the boundary checkpoint is its base)
  expect(liveLines(s.stateAt(U, D, P, floor).rm)).toBeGreaterThan(0);
  for (const sq of atOrAbove) {
    expect([...s.stateAt(U, D, P, sq).rm]).toEqual([...before.get(sq)!]);
  }

  // revertTo at/above the floor still works and restores the exact state
  const target = atOrAbove[0]!;
  s.revertTo(U, D, P, target);
  expect([...s.reconstructDevicePage(U, D, P).bytes]).toEqual([
    ...before.get(target)!,
  ]);
  // (head only grew; targets below the floor still refuse after the revert)
  expect(s.latestOpSeq(U, D, P)).toBeGreaterThan(head);
  expect(() => s.stateAt(U, D, P, below[0]!)).toThrow(BelowFloorError);
});

test("the floor's boundary checkpoint survives SNAPSHOT_KEEP churn (mid-window stateAt stays exact)", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 20);
  const stateBefore = new Map(
    seqs.map((sq) => [sq, s.stateAt(U, D, P, sq).rm]),
  );
  s.compact(U, D, P, { keepAll: false, keepRecentOps: 5 });
  const floor = s.truncationFloor(U, D, P);
  const midWindow = seqs.filter((sq) => sq >= floor);

  // churn out the faithful-checkpoint window: >SNAPSHOT_KEEP keep-all compacts
  // interleaved with edits (each writes a new head checkpoint)
  const e = editor(s);
  for (let i = 0; i < 12; i++) {
    e.edit();
    s.compact(U, D, P); // keep-all default: no further truncation
  }

  // the boundary checkpoint (op_seq == floor) must NOT have been pruned:
  // mid-window time-travel is still byte-exact, below-floor still refuses
  for (const sq of midWindow) {
    expect([...s.stateAt(U, D, P, sq).rm]).toEqual([...stateBefore.get(sq)!]);
  }
  expect(() => s.stateAt(U, D, P, seqs[0]!)).toThrow(BelowFloorError);
});

// ----- (d) keep-all pages: floor stays 0, identical to today -----

test("keep-all compaction never sets a floor: everything behaves exactly as before", () => {
  const s = freshStore();
  const seqs = appendEdits(s, 8);
  const before = new Map(seqs.map((sq) => [sq, s.stateAt(U, D, P, sq).rm]));

  const r = s.compact(U, D, P); // RETENTION_KEEP_ALL default
  expect(r.opsTruncated).toBe(0);
  expect(s.truncationFloor(U, D, P)).toBe(0);

  // every op retained, every point reconstructable, nothing refuses
  expect(s.opsSince(U, D, P, 0).length).toBeGreaterThanOrEqual(seqs.length);
  for (const sq of seqs) {
    expect([...s.stateAt(U, D, P, sq).rm]).toEqual([...before.get(sq)!]);
  }
  expect(liveLines(s.stateAt(U, D, P, 0).rm)).toBe(0); // seq 0 = empty base
  s.revertTo(U, D, P, seqs[0]!); // reverting to the oldest edit still works
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(1);
});

// ----- HTTP routes: 410 + floor fields -----

let server: CloudServer;
let base: string;
const TOK = "dev:trunc";
const USER = "trunc";
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

/** Drive edits through the real HTTP op channel; returns each batch head seq. */
async function postEdits(
  doc: string,
  page: string,
  count: number,
): Promise<number[]> {
  const rmDoc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  const seqs: number[] = [];
  for (let i = 0; i < count; i++) {
    const ops = webStroke(rmDoc, overlay, `s:${i}`, [
      { x: i, y: i },
      { x: 50, y: 50 },
    ]);
    const r = await fetch(`${base}/api/documents/${doc}/pages/${page}/ops`, {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({
        ops: ops.map((o) => Buffer.from(encodeOp(o)).toString("base64")),
        author: "web",
      }),
    });
    expect(r.status).toBe(200);
    seqs.push((await r.json()).lastSeq as number);
  }
  return seqs;
}

test("GET /ops: since below the floor -> 410 { error, floorSeq }; since >= floor -> 200 with floor", async () => {
  const DOC = "tdoc";
  const PAGE = "tpage";
  await postEdits(DOC, PAGE, 12);
  server.store.compact(USER, DOC, PAGE, { keepAll: false, keepRecentOps: 3 });
  const floor = server.store.truncationFloor(USER, DOC, PAGE);
  expect(floor).toBeGreaterThan(0);

  // cursor below the floor: the retained log is gapped for it -> 410
  const gapped = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/ops?since=0`,
    { headers: h() },
  );
  expect(gapped.status).toBe(410);
  const gapBody = (await gapped.json()) as { error: string; floorSeq: number };
  expect(gapBody.floorSeq).toBe(floor);
  expect(gapBody.error).toContain("re-bootstrap");

  // cursor at the floor: normal 200 carrying { ops, head, floor }
  const ok = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/ops?since=${floor}`,
    { headers: h() },
  );
  expect(ok.status).toBe(200);
  const okBody = (await ok.json()) as {
    ops: { seq: number }[];
    head: number;
    floor: number;
  };
  expect(okBody.floor).toBe(floor);
  expect(okBody.head).toBe(server.store.latestOpSeq(USER, DOC, PAGE));
  // the retained tail is complete: same seqs as a direct store scan
  expect(okBody.ops.map((o) => o.seq)).toEqual(
    server.store.opsSince(USER, DOC, PAGE, floor).map((o) => o.seq),
  );
});

test("GET /at and POST /revert: below the floor -> 410 + floorSeq; at/above -> correct bytes", async () => {
  const DOC = "tdoc2";
  const PAGE = "tpage2";
  const seqs = await postEdits(DOC, PAGE, 12);
  // capture a mid-window state before truncation for the byte assertion
  const midSeq = seqs[seqs.length - 2]!;
  const midBefore = server.store.stateAt(USER, DOC, PAGE, midSeq).rm;

  server.store.compact(USER, DOC, PAGE, { keepAll: false, keepRecentOps: 3 });
  const floor = server.store.truncationFloor(USER, DOC, PAGE);
  const belowSeq = seqs.find((sq) => sq < floor)!;

  // /at below the floor: 410, never a wrong reconstruct
  const atBelow = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/at?seq=${belowSeq}`,
    { headers: h() },
  );
  expect(atBelow.status).toBe(410);
  expect(((await atBelow.json()) as { floorSeq: number }).floorSeq).toBe(floor);

  // /at at/above the floor: 200 with the exact pre-truncation bytes
  const atMid = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/at?seq=${midSeq}`,
    { headers: h() },
  );
  expect(atMid.status).toBe(200);
  const container = new Uint8Array(await atMid.arrayBuffer());
  expect([...decodeSnapshot(container).rm]).toEqual([...midBefore]);

  // /revert below the floor: 410 (and nothing appended)
  const headBefore = server.store.latestOpSeq(USER, DOC, PAGE);
  const revBelow = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/revert`,
    {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({ toSeq: belowSeq }),
    },
  );
  expect(revBelow.status).toBe(410);
  expect(((await revBelow.json()) as { floorSeq: number }).floorSeq).toBe(
    floor,
  );
  expect(server.store.latestOpSeq(USER, DOC, PAGE)).toBe(headBefore);

  // /revert at/above the floor: works
  const revOk = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/revert`,
    {
      method: "POST",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({ toSeq: midSeq }),
    },
  );
  expect(revOk.status).toBe(200);
  const liveRm = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/rm`, {
    headers: h(),
  });
  expect([...new Uint8Array(await liveRm.arrayBuffer())]).toEqual([
    ...midBefore,
  ]);
});

test("GET /history reports the floor (and 0 for keep-all pages, which behave exactly as today)", async () => {
  // truncated page: floor > 0 and history only lists retained ops
  const DOC = "tdoc3";
  const PAGE = "tpage3";
  await postEdits(DOC, PAGE, 12);
  server.store.compact(USER, DOC, PAGE, { keepAll: false, keepRecentOps: 3 });
  const floor = server.store.truncationFloor(USER, DOC, PAGE);
  const hist = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/history`,
    { headers: h() },
  );
  expect(hist.status).toBe(200);
  const histBody = (await hist.json()) as {
    points: { seq: number; kind: string }[];
    head: number;
    floor: number;
  };
  expect(histBody.floor).toBe(floor);
  // historyPoints naturally lists only retained ops (all above the floor)
  for (const p of histBody.points.filter((x) => x.kind === "op")) {
    expect(p.seq).toBeGreaterThan(floor);
  }

  // keep-all page: floor 0, full log listed, /ops?since=0 answers 200
  const KDOC = "kdoc";
  const KPAGE = "kpage";
  const kSeqs = await postEdits(KDOC, KPAGE, 4);
  server.store.compact(USER, KDOC, KPAGE); // keep-all default
  const kHist = await fetch(
    `${base}/api/documents/${KDOC}/pages/${KPAGE}/history`,
    { headers: h() },
  );
  const kBody = (await kHist.json()) as {
    points: { seq: number; kind: string }[];
    floor: number;
  };
  expect(kBody.floor).toBe(0);
  const kOps = await fetch(
    `${base}/api/documents/${KDOC}/pages/${KPAGE}/ops?since=0`,
    { headers: h() },
  );
  expect(kOps.status).toBe(200);
  const kOpsBody = (await kOps.json()) as { ops: unknown[]; floor: number };
  expect(kOpsBody.floor).toBe(0);
  expect(kOpsBody.ops.length).toBeGreaterThanOrEqual(kSeqs.length);
  // /at reaches the oldest point on a keep-all page
  const kAt = await fetch(
    `${base}/api/documents/${KDOC}/pages/${KPAGE}/at?seq=${kSeqs[0]}`,
    { headers: h() },
  );
  expect(kAt.status).toBe(200);
});

// ----- #56: user-facing "Clear history" -----

test("POST /clear-history: live bytes identical, storage freed, old points gone, lagging cursors 410", async () => {
  const DOC = "cleardoc";
  const PAGE = "clearpage";
  // model a page whose HISTORY dominates its storage (the case the feature
  // exists for): many edits with interleaved keep-all checkpoints. A page
  // with a handful of ops has less history than the two safety snapshots
  // clearing writes, and correctly frees ~nothing.
  await postEdits(DOC, PAGE, 25);
  server.store.compact(USER, DOC, PAGE); // keep-all checkpoint
  await postEdits(DOC, PAGE, 25);
  server.store.compact(USER, DOC, PAGE);
  await postEdits(DOC, PAGE, 10);
  const liveBefore = await (
    await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/rm`, { headers: h() })
  ).arrayBuffer();
  const usageBefore = server.store.usageBytes(USER, "created");
  const opsBefore = server.store.opsSince(USER, DOC, PAGE, 0).length;

  const r = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/clear-history`,
    { method: "POST", headers: h() },
  );
  expect(r.status).toBe(200);
  const body = (await r.json()) as {
    opsDeleted: number;
    snapshotsDeleted: number;
    floor: number;
  };
  // Clear history retains the head op. Usage counter updates are not ops.
  expect(body.opsDeleted).toBe(opsBefore - 1);
  expect(body.snapshotsDeleted).toBeGreaterThan(0); // the old checkpoints
  expect(body.floor).toBeGreaterThan(0);

  // the live page is byte-identical
  const liveAfter = await (
    await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/rm`, { headers: h() })
  ).arrayBuffer();
  expect([...new Uint8Array(liveAfter)]).toEqual([...new Uint8Array(liveBefore)]);

  // storage actually freed (ops + old snapshots refunded by the triggers)
  expect(server.store.usageBytes(USER, "created")).toBeLessThan(usageBefore);

  // a lagging client's cursor now predates the floor -> 410 re-bootstrap
  const gapped = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/ops?since=0`,
    { headers: h() },
  );
  expect(gapped.status).toBe(410);

  // history clamps: every remaining op point sits at/above the floor
  const hist = (await (
    await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/history`, { headers: h() })
  ).json()) as { points: { seq: number; kind: string }[]; floor: number };
  expect(hist.floor).toBe(body.floor);
  for (const p of hist.points.filter((x) => x.kind === "op")) {
    expect(p.seq).toBeGreaterThanOrEqual(hist.floor);
  }

  // idempotent: clearing again finds nothing below the head to delete
  const again = await fetch(
    `${base}/api/documents/${DOC}/pages/${PAGE}/clear-history`,
    { method: "POST", headers: h() },
  );
  expect(((await again.json()) as { opsDeleted: number }).opsDeleted).toBe(0);
  // and the retained tail still streams fine from the floor
  expect(
    (
      await fetch(
        `${base}/api/documents/${DOC}/pages/${PAGE}/ops?since=${body.floor}`,
        { headers: h() },
      )
    ).status,
  ).toBe(200);
});


test("missing or corrupt history checkpoint refuses reads, reverts and trimming until restored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-required-checkpoint-"));
  const relay = startCloud({ port: 0, db: join(dir, "t.db") });
  const s = relay.store;
  const endpoint = `http://localhost:${relay.port}/api/documents/${D}/pages/${P}`;
  const call = (route: string, payload?: object) => fetch(endpoint + route, payload
    ? { method: "POST", headers: h({ "content-type": "application/json" }), body: JSON.stringify(payload) }
    : { headers: h() });
  try {
    // An untouched page genuinely has no checkpoint and reconstructs empty.
    expect(liveLines(s.stateAt(USER, D, P, 0).rm)).toBe(0);
    const e = editor(s, USER);
    for (let i = 0; i < 12; i++) e.edit();
    s.compact(USER, D, P, { keepAll: false, keepRecentOps: 5 });
    const initialFloor = s.truncationFloor(USER, D, P);
    const snapHead = s.latestOpSeq(USER, D, P);
    const beforeNativeEdit = s.stateAt(USER, D, P, snapHead);
    const rm = RmDocument.parse(beforeNativeEdit.rm);
    rm.appendLine({
      kind: "line", color: PenColor.BLACK, tool: Pen.FINELINER_1,
      points: polylineToPoints([{ x: 891, y: 765 }, { x: 940, y: 721 }], { width: 40 }),
      thicknessScale: 1, startingLength: 0, timestamp: crdtId(0, 0), moveId: null,
    }, { authorUuid: "bbbbbbbb-0000-4000-b000-000000000002" });
    const snapSeq = s.putSnapshot(USER, D, P, encodeSnapshot(rm.serialize(), beforeNativeEdit.overlay), false, snapHead);
    for (let i = 0; i < 9; i++) e.edit();
    const head = s.latestOpSeq(USER, D, P);
    const expected = s.stateAt(USER, D, P, head);
    const points = s.historyPoints(USER, D, P, 100);
    const ops = s.opsSince(USER, D, P, 0);
    const db = (s as unknown as { db: import("bun:sqlite").Database }).db;
    const { path } = db.query<{ path: string }, [number]>("SELECT path FROM page_snapshots WHERE seq=?").get(snapSeq)!;
    const checkpoint = readFileSync(path);
    unlinkSync(path);

    expect(() => s.stateAt(USER, D, P, head)).toThrow(HistoryCheckpointError);
    expect(() => s.compact(USER, D, P, { keepAll: false, keepRecentOps: 5 })).toThrow(HistoryCheckpointError);
    expect((await call(`/at?seq=${head}`)).status).toBe(503);
    expect((await call("/revert", { toSeq: head })).status).toBe(503);
    expect((await call("/revert", { toSnapshot: snapSeq })).status).toBe(503);
    expect((await call("/clear-history", {})).status).toBe(503);

    // Legacy snapshots lack a digest; still refuse a malformed envelope.
    const invalidFrame = Buffer.from(checkpoint);
    invalidFrame[0] ^= 1;
    writeFileSync(path, invalidFrame);
    expect((await call(`/at?seq=${head}`)).status).toBe(503);

    // A structurally valid changed byte is detected when a digest is recorded.
    const digest = new Bun.CryptoHasher("sha256").update(checkpoint).digest("hex");
    db.run("UPDATE page_snapshots SET sha256=? WHERE seq=?", [digest, snapSeq]);
    const changed = Buffer.from(checkpoint);
    const shape = changed.indexOf("shape:");
    expect(shape).toBeGreaterThan(0);
    changed[shape] = 0x53; // "shape:" -> "Shape:"; valid JSON, same byte count.
    expect(decodeSnapshot(changed).rm).toEqual(decodeSnapshot(checkpoint).rm);
    writeFileSync(path, changed);
    expect(() => s.compact(USER, D, P)).toThrow(HistoryCheckpointError);
    expect(s.historyPoints(USER, D, P, 100)).toEqual(points);
    expect(s.opsSince(USER, D, P, 0)).toEqual(ops);
    expect(s.truncationFloor(USER, D, P)).toBe(initialFloor);

    writeFileSync(path, checkpoint);
    const read = await call(`/at?seq=${head}`);
    expect(read.status).toBe(200);
    const recovered = decodeSnapshot(new Uint8Array(await read.arrayBuffer()));
    expect(recovered.rm).toEqual(expected.rm);
    expect(s.compact(USER, D, P, { keepAll: false, keepRecentOps: 5 }).opsTruncated).toBeGreaterThan(0);
    expect(s.stateAt(USER, D, P, head)).toEqual(expected);
  } finally {
    relay.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
