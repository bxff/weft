/**
 * Lazy blob->snapshot migration ("5d"): a page written under the legacy
 * blob-CAS regime must transition LOSSLESSLY when an op-mode client (now the
 * default) touches it. Without this, an op-mode bootstrap saw legacy pages
 * EMPTY — and the first stroke flipped the page op-mode with the blob content
 * missing from the log, after which the daemon's reconstruct would overwrite
 * the tablet's .rm (device ink loss). The audit that found it: seed the blob
 * (+ overlay sidecar) as the base snapshot on every op-mode entry point.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudStore } from "../src/store";
import { startCloud, type CloudServer } from "../src/server";
import { RmDocument } from "@weft/rm-format";
import { polylineToPoints, type Xy } from "@weft/rm-ink/pure";
import {
  applyOps,
  encodeOp,
  decodeSnapshot,
  type Op,
  type OverlayDocument,
} from "@weft/sync-engine";

const U = "u";
const D = "doc1";
const P = "page1";
const WEB_AUTHOR = "aaaaaaaa-0000-4000-a000-000000000001";

function freshStore(): CloudStore {
  return new CloudStore(join(mkdtempSync(join(tmpdir(), "weft-mig-")), "t.db"));
}

function liveLines(rm: Uint8Array): number {
  return (
    RmDocument.parse(rm).blocks as unknown as {
      type: string;
      deletedLength: number;
    }[]
  ).filter((b) => b.type === "sceneLineItem" && b.deletedLength === 0).length;
}

/** One stroke as a LocalOp applied to a live doc; returns the minted deltas. */
function stroke(
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
          version: { ts: Date.now(), actor: "client-A" },
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

/** A legacy blob page: N strokes drawn under the blob-CAS regime. */
function seedLegacyBlob(s: CloudStore, strokes = 2): Uint8Array {
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  for (let i = 0; i < strokes; i++) {
    stroke(doc, overlay, `legacy:${i}`, [
      { x: 10 + i, y: 10 },
      { x: 90, y: 90 - i },
    ]);
  }
  const bytes = doc.serialize();
  const r = s.putPage(U, D, P, "", bytes, "web-blob");
  expect("revision" in r).toBe(true);
  s.putOverlay(U, D, P, JSON.stringify(overlay));
  return bytes;
}

test("seeding a legacy blob page creates a base snapshot (op_seq 0) with its ink + overlay", () => {
  const s = freshStore();
  seedLegacyBlob(s, 2);
  expect(s.latestSnapshot(U, D, P)).toBeNull();

  expect(s.seedSnapshotFromBlob(U, D, P)).toBe(true);
  const snap = s.latestSnapshot(U, D, P)!;
  expect(snap.opSeq).toBe(0); // future ops replay ON TOP of the blob base
  const { rm, overlay } = decodeSnapshot(snap.bytes);
  expect(liveLines(rm)).toBe(2);
  expect(overlay.shapes.map((sh) => sh.shapeId).sort()).toEqual([
    "legacy:0",
    "legacy:1",
  ]);
});

test("the LOSSLESS transition: blob ink + a new op-mode stroke both survive", () => {
  const s = freshStore();
  seedLegacyBlob(s, 2);
  s.seedSnapshotFromBlob(U, D, P); // what GET /snapshot now does on bootstrap

  // the op-mode client draws one stroke on top of the (visible) blob content
  const doc = RmDocument.parse(
    decodeSnapshot(s.latestSnapshot(U, D, P)!.bytes).rm,
  );
  const ops = stroke(doc, { shapes: [] }, "new:0", [
    { x: 0, y: 0 },
    { x: 30, y: 30 },
  ]);
  s.appendOps(U, D, P, ops.map(encodeOp), "web");

  // the daemon's reconstruct = blob's 2 strokes + the new one — NOTHING lost
  const recon = s.reconstructDevicePage(U, D, P).bytes;
  expect(liveLines(recon)).toBe(3);
});

test("ops-before-seed: NO blob union (colliding ids would silently drop strokes)", () => {
  // A page that went op-mode through a pre-migration empty bootstrap: ops
  // exist, no snapshot. Ops minted against an empty base REUSE the same
  // (author, clock) ids the blob's items occupy, so a blob "union" would
  // silently drop the colliding strokes — a fake recovery. The op content
  // stands; the blob stays readable in `pages` for manual recovery.
  const s = freshStore();
  seedLegacyBlob(s, 2);
  const doc = RmDocument.empty(WEB_AUTHOR); // the damaged client saw EMPTY
  const ops = stroke(doc, { shapes: [] }, "new:0", [
    { x: 0, y: 0 },
    { x: 30, y: 30 },
  ]);
  s.appendOps(U, D, P, ops.map(encodeOp), "web");

  expect(s.seedSnapshotFromBlob(U, D, P)).toBe(false); // deliberate no-op
  expect(s.latestSnapshot(U, D, P)).toBeNull();
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(1); // op only
  expect(liveLines((s.getPage(U, D, P) as { bytes: Uint8Array }).bytes)).toBe(
    2,
  ); // blob intact
});

test("a blob write on a seeded zero-op page REFRESHES the seed (tablet edits stay visible)", () => {
  const s = freshStore();
  const first = seedLegacyBlob(s, 2);
  s.seedSnapshotFromBlob(U, D, P);

  // the tablet draws a third stroke -> daemon pushes a new blob (CAS path)
  const doc = RmDocument.parse(first);
  stroke(doc, { shapes: [] }, "tablet:0", [
    { x: 5, y: 5 },
    { x: 50, y: 50 },
  ]);
  const rev = (s.getPage(U, D, P) as { revision: string }).revision;
  const r = s.putPage(U, D, P, rev, doc.serialize(), "rmsyncd");
  expect("revision" in r).toBe(true);

  // the seed followed the blob: an op-mode bootstrap now sees all 3 strokes
  const snap = s.latestSnapshot(U, D, P)!;
  expect(snap.opSeq).toBe(0);
  expect(liveLines(decodeSnapshot(snap.bytes).rm)).toBe(3);
});

test("no blob -> seeding is a no-op; existing snapshot -> never re-seeded", () => {
  const s = freshStore();
  expect(s.seedSnapshotFromBlob(U, D, P)).toBe(false); // fresh page: nothing
  expect(s.latestSnapshot(U, D, P)).toBeNull();

  seedLegacyBlob(s, 1);
  expect(s.seedSnapshotFromBlob(U, D, P)).toBe(true);
  const seq = s.latestSnapshot(U, D, P)!.seq;
  expect(s.seedSnapshotFromBlob(U, D, P)).toBe(false); // idempotent
  expect(s.latestSnapshot(U, D, P)!.seq).toBe(seq);
});

// ----- wire level: the routes seed before serving/appending -----

let server: CloudServer;
let base: string;
const TOK = "dev:migration";
const h = () => ({ authorization: `Bearer ${TOK}` });

beforeAll(() => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop());

test("GET /snapshot on a legacy blob page serves the seeded base (not 404-empty)", async () => {
  // create the legacy page over the wire (blob-CAS PUT)
  const doc = RmDocument.empty(WEB_AUTHOR);
  stroke(doc, { shapes: [] }, "legacy:0", [
    { x: 1, y: 1 },
    { x: 9, y: 9 },
  ]);
  const put = await fetch(`${base}/api/documents/mdoc/pages/mpage/rm`, {
    method: "PUT",
    headers: {
      ...h(),
      "content-type": "application/octet-stream",
      "x-base-revision": "",
      "x-client-id": "web-blob",
    },
    body: doc.serialize() as unknown as BodyInit,
  });
  expect(put.status).toBe(200);

  const snap = await fetch(`${base}/api/documents/mdoc/pages/mpage/snapshot`, {
    headers: h(),
  });
  expect(snap.status).toBe(200); // seeded, NOT 404
  expect(snap.headers.get("x-snapshot-op-seq")).toBe("0");
  const container = new Uint8Array(await snap.arrayBuffer());
  expect(liveLines(decodeSnapshot(container).rm)).toBe(1);
});

test("POST /ops on a legacy blob page seeds BEFORE the op lands (no loss window)", async () => {
  const doc = RmDocument.empty(WEB_AUTHOR);
  stroke(doc, { shapes: [] }, "legacy:0", [
    { x: 1, y: 1 },
    { x: 9, y: 9 },
  ]);
  const put = await fetch(`${base}/api/documents/odoc/pages/opage/rm`, {
    method: "PUT",
    headers: {
      ...h(),
      "content-type": "application/octet-stream",
      "x-base-revision": "",
      "x-client-id": "web-blob",
    },
    body: doc.serialize() as unknown as BodyInit,
  });
  expect(put.status).toBe(200);

  // an op-mode client posts a stroke WITHOUT first calling GET /snapshot —
  // the server must seed anyway. The stroke is minted against the blob base
  // (as any client holding the page's content would), so clocks don't collide.
  const fresh = RmDocument.parse(doc.serialize());
  const ops = stroke(fresh, { shapes: [] }, "new:0", [
    { x: 0, y: 0 },
    { x: 5, y: 5 },
  ]);
  const post = await fetch(`${base}/api/documents/odoc/pages/opage/ops`, {
    method: "POST",
    headers: { ...h(), "content-type": "application/json" },
    body: JSON.stringify({
      ops: ops.map((o) => Buffer.from(encodeOp(o)).toString("base64")),
      author: "web",
    }),
  });
  expect(post.status).toBe(200);

  // the daemon's view: blob stroke + op stroke — the blob was folded in first
  const rm = await fetch(`${base}/api/documents/odoc/pages/opage/rm`, {
    headers: h(),
  });
  expect(liveLines(new Uint8Array(await rm.arrayBuffer()))).toBe(2);
});
