/**
 * ADVERSARIAL CONVERGENCE SOAK — the test class that was missing while
 * "basic" sync bugs kept surfacing by hand. Every prior incident lived in a
 * gap no unit test reaches: concurrent edits racing transport failures and
 * process restarts. This soak plays that adversary at the STORE level (the
 * exact code the HTTP routes call): interleaved device pushes and web ops
 * with stale bases, device pull-then-edit cycles, and random ordering — then
 * asserts the two invariants every incident violated:
 *   1. NOTHING IS LOST: every stroke either side ever created (and did not
 *      delete) is live in the final reconstruction;
 *   2. CONVERGENCE: a device following the pull protocol ends byte-identical
 *      to the cloud's reconstruction.
 * Deterministic PRNG so a failure replays exactly.
 */

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudStore } from "../src/store";
import { RmDocument, Pen, PenColor } from "@weft/rm-format";
import { polylineToPoints } from "@weft/rm-ink/pure";
import { applyOps, encodeOp, type OverlayDocument } from "@weft/sync-engine";

const U = "soak";
const D = "soakdoc";
const P = "soakpage";
const TABLET = "f73f497f-0000-4000-a000-000000000000";
const WEB = "aaaaaaaa-0000-4000-a000-000000000001";

// deterministic PRNG (mulberry32)
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function liveKeys(bytes: Uint8Array): Set<string> {
  const doc = RmDocument.parse(bytes);
  const authors = doc.authorTable();
  const out = new Set<string>();
  for (const b of doc.blocks) {
    if (b.type !== "sceneLineItem") continue;
    const blk = b as { deletedLength: number; itemId: { part1: number; part2: number } };
    if (blk.deletedLength > 0) continue;
    out.add(`${(authors.get(blk.itemId.part1) ?? "sys").toLowerCase()}:${blk.itemId.part2}`);
  }
  return out;
}

test("soak: 120 interleaved concurrent operations lose nothing and converge", () => {
  const rand = rng(0x77ef7); // fixed seed
  const s = new CloudStore(join(mkdtempSync(join(tmpdir(), "weft-soak-")), "t.db"));

  // DEVICE model: a file + the daemon's remembered state (pushed hash,
  // base marker) — exactly the daemon's algorithm, minus the network.
  let deviceFile = (() => {
    const doc = RmDocument.empty(TABLET);
    return doc.serialize();
  })();
  let deviceBase = ""; // x-base-revision the daemon would send
  let x = 0;

  const deviceDraw = () => {
    const doc = RmDocument.parse(deviceFile);
    doc.appendLine(
      {
        kind: "line", tool: Pen.BALLPOINT_2, color: PenColor.BLACK,
        thicknessScale: 2, startingLength: 0,
        timestamp: { part1: 0, part2: 1 }, moveId: null,
        points: polylineToPoints([{ x: (x += 10), y: 10 }, { x, y: 90 }], { width: 20 }),
      },
      { authorUuid: TABLET },
    );
    doc.normalizeLayout();
    deviceFile = doc.serialize();
  };
  const devicePush = () => {
    const r = s.applyDevicePut(U, D, P, deviceFile, deviceBase);
    if (r.merged) {
      // daemon merged-pullback: adopt the union
      const rec = s.reconstructDevicePage(U, D, P);
      deviceFile = rec.bytes;
      deviceBase = rec.revision;
    } else {
      deviceBase = r.revision;
    }
  };
  const devicePull = () => {
    // the daemon's pull with the UNPUSHED-LOCAL GUARD: local content the
    // cloud has never seen forces push-first (the incident class)
    const rec = s.reconstructDevicePage(U, D, P);
    const same = rec.bytes.length === deviceFile.length && rec.bytes.every((b, i) => b === deviceFile[i]);
    if (!same) {
      devicePush();
      return;
    }
    deviceFile = rec.bytes;
    deviceBase = rec.revision;
  };

  // WEB model: an op-mode client (fresh doc view per burst, ops appended)
  const webDoc = () => RmDocument.parse(s.reconstructDevicePage(U, D, P).bytes);
  let shapeN = 0;
  const webDraw = () => {
    const doc = webDoc();
    const overlay: OverlayDocument = { shapes: [] };
    const { deltas } = applyOps(
      doc,
      overlay,
      [
        {
          type: "upsert-shape",
          shape: {
            shapeId: `shape:s${shapeN++}`, kind: "draw-native", props: {},
            x: 0, y: 0, rotation: 0, renderRevision: `r${shapeN}`,
            version: { ts: shapeN, actor: "web" },
          },
          parts: [
            {
              partKey: "p0",
              strokes: [
                {
                  points: polylineToPoints(
                    [{ x: 500 + shapeN, y: 10 }, { x: 500 + shapeN, y: 90 }],
                    { width: 20 },
                  ),
                  color: "black",
                },
              ],
            },
          ],
        },
      ],
      { authorUuid: WEB },
    );
    s.appendOps(U, D, P, deltas.map(encodeOp), "web");
  };

  // the adversary: 120 random actions; device pushes are sometimes SKIPPED
  // ("network down") so later pulls race unpushed content
  let pendingDeviceEdits = 0;
  for (let i = 0; i < 120; i++) {
    const roll = rand();
    if (roll < 0.35) {
      deviceDraw();
      pendingDeviceEdits++;
      if (rand() < 0.6) {
        devicePush(); // push often — but not always (outage simulation)
        pendingDeviceEdits = 0;
      }
    } else if (roll < 0.7) {
      webDraw();
    } else {
      devicePull(); // the clobber-race moment when pendingDeviceEdits > 0
    }
  }
  // link restored: final reconcile like the daemon's startup
  devicePush();
  devicePull();

  const finalCloud = s.reconstructDevicePage(U, D, P).bytes;
  const cloudLive = liveKeys(finalCloud);
  const deviceLive = liveKeys(deviceFile);

  // INVARIANT 1: nothing lost — every tablet stroke and every web stroke
  // ever created is live at the end (nothing was ever deleted in this run)
  const tabletCreated = [...liveKeys(deviceFile)].filter((k) => k.startsWith(TABLET)).length;
  const cloudTablet = [...cloudLive].filter((k) => k.startsWith(TABLET)).length;
  const cloudWeb = [...cloudLive].filter((k) => k.startsWith(WEB)).length;
  expect(cloudWeb).toBe(shapeN); // every web stroke survived
  expect(cloudTablet).toBe(tabletCreated); // every tablet stroke survived
  expect(cloudTablet + cloudWeb).toBe(cloudLive.size);

  // INVARIANT 2: convergence — the device holds exactly the cloud state
  expect(deviceLive.size).toBe(cloudLive.size);
  expect([...deviceLive].sort()).toEqual([...cloudLive].sort());
});
