/**
 * #45 step 5b (wired): the cloud's server-side device bridge. Web clients write
 * ops; the codec-dumb daemon reads/writes whole .rm. The cloud reconstructs .rm
 * from the op log for the daemon's GET and diffs the daemon's PUT back into ops.
 */

import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startCloud } from '../src/server'
import { CloudStore, OPS_PAGE_LIMIT, COMPACT_EVERY_N_OPS, SNAPSHOT_KEEP } from '../src/store'
import { BlockType, RmDocument, Pen, PenColor, TaggedBlockReader, TaggedBlockWriter, crdtId, createRootText, insertText, linearizeRootText, writeBlocks } from '@weft/rm-format'
import { polylineToPoints, type Xy } from '@weft/rm-ink/pure'
import { applyOps, decodeSnapshot, encodeOp, encodeSnapshot, type Op, type OverlayDocument } from '@weft/sync-engine'

/** Frame a raw .rm as an op-mode snapshot container (rm + empty overlay). */
function encodeSnapshotFixture(rm: Uint8Array): Uint8Array {
    return encodeSnapshot(rm, { shapes: [] })
}

const U = 'u'
const D = 'doc1'
const P = 'page1'
const WEB_AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'
const TABLET_AUTHOR = 'f73f497f-0000-4000-a000-000000000000'

function freshStore(): CloudStore {
    return new CloudStore(join(mkdtempSync(join(tmpdir(), 'weft-bridge-')), 't.db'))
}

function liveLines(rm: Uint8Array): number {
    return (RmDocument.parse(rm).blocks as unknown as { type: string; deletedLength: number }[]).filter(
        (b) => b.type === 'sceneLineItem' && b.deletedLength === 0,
    ).length
}

/** Produce a web stroke's ops against an evolving doc (real client path). */
function webStroke(doc: RmDocument, overlay: OverlayDocument, shapeId: string, line: Xy[]): Op[] {
    const { deltas } = applyOps(
        doc,
        overlay,
        [
            {
                type: 'upsert-shape',
                shape: {
                    shapeId,
                    kind: 'draw-native',
                    props: {},
                    x: 0,
                    y: 0,
                    rotation: 0,
                    renderRevision: shapeId,
                    version: { ts: 1, actor: 'test' },
                },
                parts: [{ partKey: 'p0', strokes: [{ points: polylineToPoints(line, { width: 40 }), color: 'black' }] }],
            },
        ],
        { authorUuid: WEB_AUTHOR },
    )
    return deltas
}

function tabletDraw(rm: Uint8Array, line: Xy[], author = TABLET_AUTHOR): Uint8Array {
    const doc = RmDocument.parse(rm)
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.BALLPOINT_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: { part1: 0, part2: 1 },
            moveId: null,
            points: polylineToPoints(line, { width: 8 }),
        },
        { authorUuid: author },
    )
    doc.normalizeLayout()
    return doc.serialize()
}

test('a page with ops is op-mode; a legacy page is not', () => {
    const s = freshStore()
    expect(s.isOpModePage(U, D, P)).toBe(false)
    s.appendOps(U, D, P, [encodeOp({ op: 'delete-object', id: 'x', version: { ts: 1, actor: 'web' } })], 'web')
    expect(s.isOpModePage(U, D, P)).toBe(true)
})

test('reconstructDevicePage materializes the .rm the daemon should push', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    const ops = [
        ...webStroke(doc, overlay, 'shape:a', [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
        ]),
        ...webStroke(doc, overlay, 'shape:b', [
            { x: 20, y: 20 },
            { x: 80, y: 80 },
        ]),
    ]
    s.appendOps(U, D, P, ops.map(encodeOp), 'web')
    const recon = s.reconstructDevicePage(U, D, P)
    expect(liveLines(recon.bytes)).toBe(2)
    expect(recon.revision).toMatch(/^ops:\d+\+\d+$/)
})

test('applyDevicePut diffs xochitl\'s merged .rm back into ops (new tablet ink)', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const ops = webStroke(doc, { shapes: [] }, 'shape:a', [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
    ])
    s.appendOps(U, D, P, ops.map(encodeOp), 'web')

    // daemon pulls the reconstructed file, xochitl merges + the user draws
    const pulled = s.reconstructDevicePage(U, D, P).bytes
    const merged = tabletDraw(pulled, [
        { x: 0, y: 0 },
        { x: 30, y: 30 },
    ])
    const before = s.latestOpSeq(U, D, P)
    const result = s.applyDevicePut(U, D, P, merged)
    expect(result.changed).toBe(true)
    expect(s.latestOpSeq(U, D, P)).toBeGreaterThan(before) // the tablet stroke became an op

    // the reconstructed page now has both strokes (1 web + 1 tablet)
    expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2)
})

test('full round-trip converges a second web peer (store level)', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const webOps = webStroke(doc, { shapes: [] }, 'shape:a', [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
    ])
    s.appendOps(U, D, P, webOps.map(encodeOp), 'web')
    const pulled = s.reconstructDevicePage(U, D, P).bytes
    const merged = tabletDraw(pulled, [
        { x: 0, y: 0 },
        { x: 30, y: 30 },
    ])
    s.applyDevicePut(U, D, P, merged)

    // a second web peer replaying the whole op log sees both strokes
    const peerRm = s.reconstructDevicePage(U, D, P).bytes
    expect(liveLines(peerRm)).toBe(2)
})

test('a tablet glyph PUT is incomplete -> publishes a snapshot', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const ops = webStroke(doc, { shapes: [] }, 'shape:a', [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
    ])
    s.appendOps(U, D, P, ops.map(encodeOp), 'web')
    expect(s.latestSnapshot(U, D, P)).toBeNull()

    // tablet introduces a glyph (typed text) the line diff can't represent
    const pulled = s.reconstructDevicePage(U, D, P).bytes
    const tdoc = RmDocument.parse(pulled)
    const author = tdoc.resolveAuthor(TABLET_AUTHOR)
    tdoc.blocks.push({
        type: 'sceneGlyphItem',
        version: { min: 0, current: 0 },
        extraData: new Uint8Array(0),
        extraValueData: new Uint8Array(0),
        parentId: tdoc.defaultLayerId()!,
        itemId: { part1: author, part2: tdoc.maxClock(author) + 1 },
        leftId: { part1: 0, part2: 0 },
        rightId: { part1: 0, part2: 0 },
        deletedLength: 0,
        glyph: { kind: 'glyph', start: 0, length: 1, color: 0, rectangles: [] },
    } as never)
    const result = s.applyDevicePut(U, D, P, tdoc.serialize())
    expect(result.changed).toBe(true)
    // a snapshot was published so peers re-bootstrap (glyph can't ride the diff)
    expect(s.latestSnapshot(U, D, P)).not.toBeNull()
})

test('a device round-trip PRESERVES the web overlay (does not wipe semantic shapes)', () => {
    // ROOT of the weft-cal23 phantom-duplicate/undo/anchor bugs: applyDevicePut
    // used to snapshot with the EMPTY legacy overlays table, wiping every
    // web-authored shape on each tablet save. Any doc with device text is always
    // `!complete`, so its overlay was erased on every round-trip -> the web then
    // rendered raw ink as loose duplicates.
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    // a web-drawn shape -> lives in the overlay (an object op in the log)
    const ops = webStroke(doc, { shapes: [] }, 'shape:web1', [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
    ])
    s.appendOps(U, D, P, ops.map(encodeOp), 'web')

    // the tablet round-trips and introduces a glyph (typed text) -> `!complete`,
    // forcing the snapshot-publish path that used to wipe the overlay.
    const pulled = s.reconstructDevicePage(U, D, P).bytes
    const tdoc = RmDocument.parse(pulled)
    const author = tdoc.resolveAuthor(TABLET_AUTHOR)
    tdoc.blocks.push({
        type: 'sceneGlyphItem',
        version: { min: 0, current: 0 },
        extraData: new Uint8Array(0),
        extraValueData: new Uint8Array(0),
        parentId: tdoc.defaultLayerId()!,
        itemId: { part1: author, part2: tdoc.maxClock(author) + 1 },
        leftId: { part1: 0, part2: 0 },
        rightId: { part1: 0, part2: 0 },
        deletedLength: 0,
        glyph: { kind: 'glyph', start: 0, length: 1, color: 0, rectangles: [] },
    } as never)
    s.applyDevicePut(U, D, P, tdoc.serialize())

    // the published snapshot MUST still carry the web shape (was [] before the fix)
    const snap = s.latestSnapshot(U, D, P)!
    const overlay = decodeSnapshot(snap.bytes).overlay
    expect(overlay.shapes.map((sh) => sh.shapeId)).toContain('shape:web1')
})

test('a legacy (blob) page is never treated as op-mode', () => {
    const s = freshStore()
    const rm = RmDocument.empty(WEB_AUTHOR).serialize()
    s.putPage(U, D, P, '', rm, 'web')
    expect(s.isOpModePage(U, D, P)).toBe(false)
    // getPage still returns the blob; reconstruct is not used for it
    expect(s.getPage(U, D, P)!.bytes.length).toBe(rm.length)
})

test('recordOpChange writes a change row the daemon can pull (origin not rmsyncd)', () => {
    const s = freshStore()
    s.appendOps(U, D, P, [encodeOp({ op: 'delete-object', id: 'x', version: { ts: 1, actor: 'web' } })], 'web')
    s.recordOpChange(U, D, P, 'web')
    const changes = s.changesSince(U, 0)
    const mine = changes.find((c) => c.doc === D && c.page === P)
    expect(mine).toBeTruthy()
    expect(mine!.revision).toMatch(/^ops:\d+\+\d+$/)
})

// ----- F5: the daemon<->server bridge cannot diverge or lose an edit --------
// These exercise the STORE path (applyDevicePut / reconstructDevicePage), the
// exact code the cloud HTTP handler calls, so the guarantees hold end to end.

test('F5 bidirectional op-mode round-trip converges (web->tablet->web)', () => {
    const s = freshStore()
    // (a) web ops reach the tablet: append web ink, reconstruct the file the
    // daemon GETs and writes to xochitl.
    const doc = RmDocument.empty(WEB_AUTHOR)
    const webOps = webStroke(doc, { shapes: [] }, 'shape:a', [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
    ])
    s.appendOps(U, D, P, webOps.map(encodeOp), 'web')
    const forTablet = s.reconstructDevicePage(U, D, P)
    expect(liveLines(forTablet.bytes)).toBe(1)
    expect(forTablet.revision).toMatch(/^ops:\d+\+\d+$/)

    // (b) tablet edits reach web: xochitl merges + the user draws; the daemon
    // PUTs; applyDevicePut diffs it into ops appended to the log.
    const merged = tabletDraw(forTablet.bytes, [
        { x: 0, y: 0 },
        { x: 30, y: 30 },
    ])
    const put = s.applyDevicePut(U, D, P, merged)
    expect(put.changed).toBe(true)

    // a web peer replaying the whole op log converges to BOTH strokes.
    const converged = s.reconstructDevicePage(U, D, P).bytes
    expect(liveLines(converged)).toBe(2)
})

test('F5 stale-push-no-false-delete: a daemon PUT missing recent web ops deletes nothing', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }

    // web draws A; the daemon pulls (captures) the reconstructed file.
    const opsA = webStroke(doc, overlay, 'shape:a', [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
    ])
    s.appendOps(U, D, P, opsA.map(encodeOp), 'web')
    const daemonStaleFile = s.reconstructDevicePage(U, D, P).bytes // has only A

    // web draws B *after* that pull; the store's current state now has A + B.
    const opsB = webStroke(doc, overlay, 'shape:b', [
        { x: 20, y: 20 },
        { x: 80, y: 80 },
    ])
    s.appendOps(U, D, P, opsB.map(encodeOp), 'web')
    expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2)

    const seqBefore = s.latestOpSeq(U, D, P)
    // the daemon PUTs its STALE file (missing B). It must NOT tombstone B.
    const put = s.applyDevicePut(U, D, P, daemonStaleFile)
    expect(put.changed).toBe(false) // no ops: no false delete, no re-add
    expect(s.latestOpSeq(U, D, P)).toBe(seqBefore)

    // both strokes still live after the stale push.
    expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2)
})

test('F5 idempotent-repush-zero-ops: re-PUTting the same content appends ZERO ops (no loop)', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const ops = webStroke(doc, { shapes: [] }, 'shape:a', [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
    ])
    s.appendOps(U, D, P, ops.map(encodeOp), 'web')
    const file = s.reconstructDevicePage(U, D, P).bytes
    const before = s.latestOpSeq(U, D, P)
    for (let i = 0; i < 3; i++) {
        const put = s.applyDevicePut(U, D, P, file)
        expect(put.changed).toBe(false)
    }
    expect(s.latestOpSeq(U, D, P)).toBe(before) // the op log did not grow
})

test('F5 normalize-empty-diff: xochitl re-serializing a real fixture applies as unchanged', () => {
    const s = freshStore()
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const real = new Uint8Array(
        readFileSync(join(import.meta.dir, '../../../fixtures/ferrari-bridge-real-page.rm')),
    )
    // Bootstrap the page as op-mode by publishing the real file as a snapshot,
    // so reconstructDevicePage returns exactly these bytes (the "current" state
    // the daemon holds). Then the daemon re-saves after a normalize-only rewrite.
    s.appendOps(U, D, P, [encodeOp({ op: 'delete-object', id: '__seed__', version: { ts: 1, actor: 'web' } })], 'web')
    s.putSnapshot(U, D, P, encodeSnapshotFixture(real))

    const doc = RmDocument.parse(real)
    doc.normalizeLayout()
    const rewritten = doc.serialize()

    const before = s.latestOpSeq(U, D, P)
    const put = s.applyDevicePut(U, D, P, rewritten)
    expect(put.changed).toBe(false) // a normalize-only rewrite is not an edit
    expect(s.latestOpSeq(U, D, P)).toBe(before)
})

// ----- tablet TEXT edits must survive the op-mode bridge (regression:
// diffToOps saw no line changes -> complete:true -> no snapshot -> the next
// reconstruction REVERTED the tablet's typing)

import {
  createRootText,
  insertText,
  linearizeRootText,
} from "@weft/rm-format";

test("a tablet TEXT edit on an op-mode page survives reconstruction", () => {
  const s = freshStore();
  const U2 = "text-user";
  // page goes op-mode via a web ink op
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay = { shapes: [] } as never;
  const { deltas } = applyOps(
    doc,
    overlay,
    [
      {
        type: "upsert-shape",
        shape: {
          shapeId: "shape:t1",
          kind: "draw-native",
          props: {},
          x: 0,
          y: 0,
          rotation: 0,
          renderRevision: "r1",
          version: { ts: 1, actor: "t" },
        },
        parts: [
          {
            partKey: "p0",
            strokes: [
              {
                points: polylineToPoints(
                  [
                    { x: 10, y: 10 },
                    { x: 90, y: 90 },
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
  s.appendOps(U2, D, P, deltas.map(encodeOp), "web");

  // the tablet pulls, the user TYPES on the device, the daemon pushes back
  const pulled = s.reconstructDevicePage(U2, D, P).bytes;
  const tablet = RmDocument.parse(pulled);
  createRootText(tablet);
  insertText(tablet, null, "typed on the device", {
    authorUuid: "f73f497f-0000-4000-a000-000000000000",
  });
  const res = s.applyDevicePut(U2, D, P, tablet.serialize());
  expect(res.changed).toBe(true);

  // the reconstruction (what BOTH the daemon and web bootstrap from) keeps it
  const after = RmDocument.parse(s.reconstructDevicePage(U2, D, P).bytes);
  const text = linearizeRootText(after.tree().rootText!)
    .map((p) => p.spans.map((sp) => sp.text).join(""))
    .join("\n");
  expect(text).toBe("typed on the device");
  // and the web ink is still there
  expect(
    after.blocks.some(
      (b) => b.type === "sceneLineItem" && (b as { deletedLength: number }).deletedLength === 0,
    ),
  ).toBe(true);
});

test("an idempotent tablet re-push after a text edit stays unchanged (no churn)", () => {
  const s = freshStore();
  const U3 = "text-user-2";
  const doc = RmDocument.empty(WEB_AUTHOR);
  createRootText(doc);
  insertText(doc, null, "hello", { authorUuid: WEB_AUTHOR });
  s.applyDevicePut(U3, D, P, doc.serialize());
  const pulled = s.reconstructDevicePage(U3, D, P).bytes;
  const res = s.applyDevicePut(U3, D, P, RmDocument.parse(pulled).serialize());
  expect(res.changed).toBe(false);
});

// ----- concurrency: the merge paths (owner's conflict-resolution sweep)

import { deleteText, rootTextCharPositions, crdtId as mkId } from "@weft/rm-format";
import { encodeSnapshot as encSnap, decodeSnapshot as decSnap } from "@weft/sync-engine";

const TABLET_UUID = "f73f497f-0000-4000-a000-000000000000";
const WEB_UUID = "c8050a7c-9999-4999-a999-000000000001";

function pageText(bytes: Uint8Array): string {
  const d = RmDocument.parse(bytes);
  const rt = d.tree().rootText;
  if (!rt) return "";
  return linearizeRootText(rt)
    .map((p) => p.spans.map((s) => s.text).join(""))
    .join("\n");
}

test("RACE: web ink lands between tablet pull and tablet TEXT push - both survive", () => {
  const s = freshStore();
  const U = "race-user";
  // tablet establishes the page
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "from tablet", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  // tablet pulls...
  const pulled = s.reconstructDevicePage(U, D, P).bytes;
  // ...web ink op lands AFTER the pull
  const webDoc = RmDocument.parse(s.reconstructDevicePage(U, D, P).bytes);
  const overlay = { shapes: [] } as never;
  const { deltas } = applyOps(
    webDoc,
    overlay,
    [
      {
        type: "upsert-shape",
        shape: {
          shapeId: "shape:w1", kind: "draw-native", props: {}, x: 0, y: 0,
          rotation: 0, renderRevision: "r1", version: { ts: 1, actor: "w" },
        },
        parts: [
          { partKey: "p0", strokes: [{ points: polylineToPoints([{ x: 5, y: 5 }, { x: 50, y: 50 }], { width: 40 }), color: "black" }] },
        ],
      },
    ],
    { authorUuid: WEB_UUID },
  );
  s.appendOps(U, D, P, deltas.map(encodeOp), "web");
  // tablet pushes its (stale-base) TEXT edit
  const tablet = RmDocument.parse(pulled);
  insertText(tablet, rootTextCharPositions(tablet.tree().rootText!).at(-1)!.id, " typed more", {
    authorUuid: TABLET_UUID,
  });
  s.applyDevicePut(U, D, P, tablet.serialize());
  // BOTH the web stroke and the tablet text survive the reconstruction
  const after = s.reconstructDevicePage(U, D, P).bytes;
  expect(pageText(after)).toBe("from tablet typed more");
  const doc = RmDocument.parse(after);
  expect(
    doc.blocks.filter(
      (b) => b.type === "sceneLineItem" && (b as { deletedLength: number }).deletedLength === 0,
    ).length,
  ).toBe(1);
});

test("CONCURRENT text-text: tablet typing + web snapshot publish UNION", () => {
  const s = freshStore();
  const U = "text-race";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  const first = insertText(base, null, "shared", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const common = s.reconstructDevicePage(U, D, P).bytes;
  // tablet appends
  const tablet = RmDocument.parse(common);
  insertText(tablet, rootTextCharPositions(tablet.tree().rootText!).at(-1)!.id, " tabletword", {
    authorUuid: TABLET_UUID,
  });
  s.applyDevicePut(U, D, P, tablet.serialize());
  // web (which saw only `common`) publishes a snapshot with ITS edit
  const web = RmDocument.parse(common);
  insertText(web, first, "WEB", { authorUuid: WEB_UUID });
  s.putSnapshotMerged(U, D, P, encSnap(web.serialize(), { shapes: [] } as never));
  const after = pageText(s.reconstructDevicePage(U, D, P).bytes);
  expect(after).toContain("tabletword"); // tablet edit not clobbered
  expect(after).toContain("WEB"); // web edit present
});

test("DELETED-WINS: a web deletion is not resurrected by a stale tablet push", () => {
  const s = freshStore();
  const U = "del-race";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  const first = insertText(base, null, "ABCDE", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const common = s.reconstructDevicePage(U, D, P).bytes;
  // web deletes 'C' and publishes
  const web = RmDocument.parse(common);
  deleteText(web, [mkId(first.part1, first.part2 + 2)]);
  s.putSnapshotMerged(U, D, P, encSnap(web.serialize(), { shapes: [] } as never));
  // stale tablet push still carries the full 'ABCDE'
  s.applyDevicePut(U, D, P, common);
  expect(pageText(s.reconstructDevicePage(U, D, P).bytes)).toBe("ABDE");
});

// ----- weft-cal15 (live-confirmed 2026-07-07): snapshot-only edits must be
// visible to the daemon. A device-TEXT web edit publishes a snapshot with
// ZERO ops; the old change marker was op-head-only ("ops:N"), so every text
// edit after the first produced a change row identical to the daemon's
// remembered revision — pull_changes deduped them away and the tablet never
// saw web text edits again (changes 668/669 consumed, file untouched).

test("REGRESSION cal15: a snapshot-only edit produces a DISTINCT revision marker", () => {
  const s = freshStore();
  const U = "cal15";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "check me", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const markerBefore = s.reconstructDevicePage(U, D, P).revision;

  // web text edit: snapshot published, zero ops (the exact cal15 flow)
  const web = RmDocument.parse(s.reconstructDevicePage(U, D, P).bytes);
  insertText(web, rootTextCharPositions(web.tree().rootText!).at(-1)!.id, "a ladljf ad", {
    authorUuid: WEB_UUID,
  });
  s.putSnapshotMerged(U, D, P, encSnap(web.serialize(), { shapes: [] } as never));
  s.recordOpChange(U, D, P, "web");

  expect(s.latestOpSeq(U, D, P)).toBe(0); // truly snapshot-only
  const markerAfter = s.reconstructDevicePage(U, D, P).revision;
  expect(markerAfter).not.toBe(markerBefore); // the daemon can now SEE it
  // and the change row carries the same fresh marker
  const change = s.changesSince(U, 0).findLast((c) => c.doc === D && c.page === P)!;
  expect(change.revision).toBe(markerAfter);
});

test("REGRESSION cal15: consecutive snapshot-only edits each get fresh markers", () => {
  const s = freshStore();
  const U = "cal15-b";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "seed", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const markers = new Set<string>([s.reconstructDevicePage(U, D, P).revision]);
  for (let i = 0; i < 3; i++) {
    const web = RmDocument.parse(s.reconstructDevicePage(U, D, P).bytes);
    insertText(web, rootTextCharPositions(web.tree().rootText!).at(-1)!.id, ` edit${i}`, {
      authorUuid: WEB_UUID,
    });
    s.putSnapshotMerged(U, D, P, encSnap(web.serialize(), { shapes: [] } as never));
    markers.add(s.reconstructDevicePage(U, D, P).revision);
  }
  expect(markers.size).toBe(4); // every edit distinguishable, none skippable
});

test("pageRevisions reports every page with its current device marker", () => {
  const s = freshStore();
  const U = "revs";
  // an op-mode page
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "x", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  // a legacy blob page
  const rm = RmDocument.empty(WEB_UUID).serialize();
  s.putPage(U, "doc2", "pageB", "", rm, "web");
  const revs = s.pageRevisions(U);
  expect(revs[`${D}/${P}`]).toBe(s.reconstructDevicePage(U, D, P).revision);
  expect(revs["doc2/pageB"]).toMatch(/^[0-9a-f]{64}$/); // blob sha
});

// ----- merged flag: the daemon must learn when the server's stored state is
// a SUPERSET of what it pushed (concurrent web edits union-merged in), so it
// pulls the union back instead of diverging until the next foreign change.

test("merged=false for a plain tablet push with nothing concurrent", () => {
  const s = freshStore();
  const U = "m0";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "hello", { authorUuid: TABLET_UUID });
  const first = s.applyDevicePut(U, D, P, base.serialize());
  expect(first.merged).toBe(false);
  // pull, edit on tablet, push again: still nothing concurrent
  const pulled = s.reconstructDevicePage(U, D, P).bytes;
  const t = RmDocument.parse(pulled);
  insertText(t, rootTextCharPositions(t.tree().rootText!).at(-1)!.id, " more", {
    authorUuid: TABLET_UUID,
  });
  const second = s.applyDevicePut(U, D, P, t.serialize());
  expect(second.changed).toBe(true);
  expect(second.merged).toBe(false); // no spurious pull -> no file rewrite churn
});

test("merged=true when a concurrent web text edit was union-merged into the push", () => {
  const s = freshStore();
  const U = "m1";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "shared", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const common = s.reconstructDevicePage(U, D, P).bytes;
  // web edits after the tablet's pull
  const web = RmDocument.parse(common);
  insertText(web, rootTextCharPositions(web.tree().rootText!).at(-1)!.id, " WEB", {
    authorUuid: WEB_UUID,
  });
  s.putSnapshotMerged(U, D, P, encSnap(web.serialize(), { shapes: [] } as never));
  // tablet pushes its own (stale-base) edit
  const t = RmDocument.parse(common);
  insertText(t, rootTextCharPositions(t.tree().rootText!).at(-1)!.id, " TAB", {
    authorUuid: TABLET_UUID,
  });
  const res = s.applyDevicePut(U, D, P, t.serialize());
  expect(res.merged).toBe(true); // server state ⊃ tablet bytes -> pull back
  const text = pageText(s.reconstructDevicePage(U, D, P).bytes);
  expect(text).toContain("WEB");
  expect(text).toContain("TAB");
});

test("merged=true on a STALE push missing web ink the tablet never pulled", () => {
  const s = freshStore();
  const U = "m2";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "seed", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const stale = s.reconstructDevicePage(U, D, P).bytes; // daemon's old copy
  // web draws AFTER the daemon's pull
  const webDoc = RmDocument.parse(s.reconstructDevicePage(U, D, P).bytes);
  const { deltas } = applyOps(
    webDoc,
    { shapes: [] } as never,
    [
      {
        type: "upsert-shape",
        shape: {
          shapeId: "shape:w2", kind: "draw-native", props: {}, x: 0, y: 0,
          rotation: 0, renderRevision: "r1", version: { ts: 1, actor: "w" },
        },
        parts: [
          { partKey: "p0", strokes: [{ points: polylineToPoints([{ x: 5, y: 5 }, { x: 50, y: 50 }], { width: 40 }), color: "black" }] },
        ],
      },
    ],
    { authorUuid: WEB_UUID },
  );
  s.appendOps(U, D, P, deltas.map(encodeOp), "web");
  // daemon re-pushes its stale file (e.g. an unrelated xochitl re-save)
  const res = s.applyDevicePut(U, D, P, stale);
  expect(res.changed).toBe(false); // no false tombstones (F5 invariant intact)
  expect(res.merged).toBe(true); // but the daemon must pull the web stroke
});

test("merged=false for an idempotent re-push (no reconcile churn)", () => {
  const s = freshStore();
  const U = "m3";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "same", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const pulled = s.reconstructDevicePage(U, D, P).bytes;
  const res = s.applyDevicePut(U, D, P, RmDocument.parse(pulled).serialize());
  expect(res.changed).toBe(false);
  expect(res.merged).toBe(false);
});

// ----- #89: deletion detection is scoped to the daemon's CAUSAL BASE
// (x-base-revision). The old clock-vector inference ("seen past this clock +
// absent = deleted") falsely tombstones same-author items that arrive out of
// clock order — a second session sharing the author id, or a REVERT
// resurrecting old-clock items. The base-scoped regime only treats absence
// as deletion for items that were live in the exact state the device file
// descends from.

test("#89 late low-clock op from the same author survives a device push", () => {
  const s = freshStore();
  const U = "base-scope-1";
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  const opsA = webStroke(doc, overlay, "shape:early", [
    { x: 1, y: 1 },
    { x: 9, y: 9 },
  ]); // minted FIRST -> lower clocks
  const opsB = webStroke(doc, overlay, "shape:late", [
    { x: 20, y: 20 },
    { x: 80, y: 80 },
  ]); // minted SECOND -> higher clocks
  // the HIGH-clock stroke reaches the relay first (the other session's ops
  // are still buffered offline)
  s.appendOps(U, D, P, opsB.map(encodeOp), "web");
  const pulled = s.reconstructDevicePage(U, D, P); // device pulls: has B only
  // now the LOW-clock stroke arrives late
  s.appendOps(U, D, P, opsA.map(encodeOp), "web");
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2);
  // device re-pushes its (unchanged) file, declaring its causal base
  const put = s.applyDevicePut(U, D, P, pulled.bytes, pulled.revision);
  expect(put.changed).toBe(false); // no false tombstone appended
  expect(put.merged).toBe(true); // and the daemon is told to pull the union
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2); // A lives
});

test.each(['future', 'before checkpoint', 'another page', 'unsafe head', 'unsafe checkpoint'] as const)(
    'an invalid tablet marker (%s) cannot erase peer ink', (kind) => {
        const s = freshStore()
        const blank = RmDocument.empty(TABLET_AUTHOR).serialize()
        const doc = RmDocument.parse(blank)
        const overlay: OverlayDocument = { shapes: [] }
        const edits = webStroke(doc, overlay, 'shape:peer', [{ x: 0, y: 0 }, { x: 20, y: 10 }])
        const { lastSeq } = s.appendOps(U, D, P, edits.map(encodeOp), 'web')
        const snap = s.putSnapshot(U, D, P, encodeSnapshot(doc.serialize(), overlay))
        const foreign = s.appendOps(U, D, 'other', edits.map(encodeOp), 'web').lastSeq
        // Put the foreign sequence inside this page's range, not beyond its head.
        const head = s.appendOps(U, D, P, [encodeOp(edits.at(-1)!)], 'web').lastSeq
        const unsafe = '9007199254740993'
        const markers = {
            'future': `ops:${head + 1}+${snap}`,
            'before checkpoint': `ops:${lastSeq - 1}+${snap}`,
            'another page': `ops:${foreign}+${snap}`,
            'unsafe head': `ops:${unsafe}+${snap}`,
            'unsafe checkpoint': `ops:${head}+${unsafe}`,
        }

        const current = s.reconstructDevicePage(U, D, P)
        expect(liveLines(current.bytes)).toBe(1)
        const put = s.applyDevicePut(U, D, P, blank, markers[kind])
        expect(put.changed).toBe(false)
        expect(put.merged).toBe(true)
        expect(s.reconstructDevicePage(U, D, P)).toEqual(current)
    },
)

test('a tablet undo uses its named checkpoint when a newer checkpoint shares the cursor', () => {
    const s = freshStore()
    const blank = RmDocument.empty(TABLET_AUTHOR).serialize()
    const first = tabletDraw(blank, [{ x: 0, y: 0 }, { x: 10, y: 10 }])
    s.putSnapshot(U, D, P, encodeSnapshotFixture(first))
    const pulled = s.reconstructDevicePage(U, D, P)
    const second = tabletDraw(first, [{ x: 70, y: 80 }, { x: 90, y: 100 }], WEB_AUTHOR)
    s.putSnapshot(U, D, P, encodeSnapshotFixture(second))

    const put = s.applyDevicePut(U, D, P, blank, pulled.revision)
    expect(put.changed).toBe(true)
    expect(put.merged).toBe(true)
    const current = RmDocument.parse(s.reconstructDevicePage(U, D, P).bytes)
    const live = current.blocks.filter((block) => block.type === 'sceneLineItem' && !block.deletedLength)
    expect(live).toHaveLength(1)
    expect(live[0]?.type === 'sceneLineItem' && live[0].line?.points[0]?.x).toBe(70)
})

test("#89 a real device deletion still propagates under the base regime", () => {
  const s = freshStore();
  const U = "base-scope-2";
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  s.appendOps(
    U, D, P,
    [
      ...webStroke(doc, overlay, "shape:a", [{ x: 1, y: 1 }, { x: 9, y: 9 }]),
      ...webStroke(doc, overlay, "shape:b", [{ x: 2, y: 2 }, { x: 8, y: 8 }]),
    ].map(encodeOp),
    "web",
  );
  const pulled = s.reconstructDevicePage(U, D, P); // device has A + B
  // the user erases ONE stroke on the tablet (xochitl removes the block)
  const tdoc = RmDocument.parse(pulled.bytes);
  const lines = tdoc.blocks.filter(
    (b) => b.type === "sceneLineItem" && (b as { deletedLength: number }).deletedLength === 0,
  );
  tdoc.blocks.splice(tdoc.blocks.indexOf(lines[0]!), 1);
  const put = s.applyDevicePut(U, D, P, tdoc.serialize(), pulled.revision);
  expect(put.changed).toBe(true);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(1);
});

test("#89 a web RESTORE survives a concurrent device push (revert-undone bug)", () => {
  const s = freshStore();
  const U = "base-scope-3";
  // device establishes ink
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "seed", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, tabletDraw(base.serialize(), [{ x: 0, y: 0 }, { x: 30, y: 30 }]));
  const restorePoint = s.latestSnapshotSeq(U, D, P);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(1);
  // web deletes the stroke (tombstone op) ...
  const recon = RmDocument.parse(s.reconstructDevicePage(U, D, P).bytes);
  const line = recon.blocks.find((b) => b.type === "sceneLineItem") as { itemId: { part1: number; part2: number } };
  const author = recon.authorTable().get(line.itemId.part1)!;
  s.appendOps(
    U, D, P,
    [encodeOp({ op: "tombstone", id: { author, clock: line.itemId.part2 } } as never)],
    "web",
  );
  // ... the device pulls the deletion (its base is now the no-stroke state)
  const pulledAfterDelete = s.reconstructDevicePage(U, D, P);
  expect(liveLines(pulledAfterDelete.bytes)).toBe(0);
  // the user RESTORES the pre-delete state on the web
  const restored = s.revertToSnapshot(U, D, P, restorePoint);
  expect(restored).not.toBeNull();
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(1);
  // concurrent device push (file lacks the stroke; base = post-delete marker):
  // the restored stroke must NOT be tombstoned back to oblivion
  const put = s.applyDevicePut(U, D, P, pulledAfterDelete.bytes, pulledAfterDelete.revision);
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(1);
  expect(put.merged).toBe(true); // daemon pulls the restored state back
});

test("#89 snapshot path: late low-clock web ink survives a device TEXT push", () => {
  const s = freshStore();
  const U = "base-scope-4";
  const doc = RmDocument.empty(WEB_AUTHOR);
  const overlay: OverlayDocument = { shapes: [] };
  const opsA = webStroke(doc, overlay, "shape:early", [{ x: 1, y: 1 }, { x: 9, y: 9 }]);
  const opsB = webStroke(doc, overlay, "shape:late", [{ x: 20, y: 20 }, { x: 80, y: 80 }]);
  s.appendOps(U, D, P, opsB.map(encodeOp), "web"); // high clock first
  const pulled = s.reconstructDevicePage(U, D, P);
  s.appendOps(U, D, P, opsA.map(encodeOp), "web"); // low clock late
  // device types text -> !complete -> mergeForSnapshot path
  const tdoc = RmDocument.parse(pulled.bytes);
  createRootText(tdoc);
  insertText(tdoc, null, "typed", { authorUuid: TABLET_UUID });
  const saved = tdoc.serialize();
  const result = s.applyDevicePut(U, D, P, saved, pulled.revision);
  expect(result).toMatchObject({ changed: true, merged: true });
  const after = s.reconstructDevicePage(U, D, P).bytes;
  expect(liveLines(after)).toBe(2); // BOTH strokes live in the merged snapshot
  expect(pageText(after)).toBe("typed");
  expect(s.applyDevicePut(U, D, P, saved, pulled.revision)).toEqual({
    changed: false, merged: true, revision: result.revision,
  });
});

test("H1: a stroke drawn AND erased in one push interval stays dead (no resurrection)", () => {
  const s = freshStore();
  const U = "h1";
  const base = RmDocument.empty(TABLET_UUID);
  createRootText(base);
  insertText(base, null, "seed", { authorUuid: TABLET_UUID });
  s.applyDevicePut(U, D, P, base.serialize());
  const pulled = s.reconstructDevicePage(U, D, P);
  // the user draws a stroke and erases it BEFORE the next push: xochitl
  // keeps the block with deletedLength>0 — new-born dead
  const tdoc = RmDocument.parse(pulled.bytes);
  const blk = tabletDraw(tdoc.serialize(), [{ x: 1, y: 1 }, { x: 9, y: 9 }]);
  const withDead = RmDocument.parse(blk);
  const line = withDead.blocks.find(
    (b) => b.type === "sceneLineItem" && (b as { deletedLength: number }).deletedLength === 0,
  ) as { itemId: { part1: number; part2: number } };
  withDead.tombstone(line.itemId as never);
  const put = s.applyDevicePut(U, D, P, withDead.serialize(), pulled.revision);
  // the cloud must NOT gain the stroke live, and must not tell the daemon
  // to pull anything back (that was the resurrection loop)
  expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(0);
  expect(put.merged).toBe(false);
});

// ---- H3/H4 (attack panel): deletion inference REQUIRES the exact base ----

/** xochitl UNDO removes the block outright (no tombstone left behind). */
function tabletUndoFirstStroke(rm: Uint8Array): Uint8Array {
    const doc = RmDocument.parse(rm)
    const idx = (doc.blocks as unknown as { type: string }[]).findIndex(
        (b) => b.type === 'sceneLineItem',
    )
    expect(idx).toBeGreaterThanOrEqual(0)
    ;(doc.blocks as unknown as unknown[]).splice(idx, 1)
    return doc.serialize()
}

test('native and overlay replay reach operations beyond the poll limit when compaction fails', () => {
    const store = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const tail = webStroke(doc, { shapes: [] }, 'shape:tail', [{ x: 1, y: 1 }, { x: 9, y: 9 }])
    const filler = encodeOp({ op: 'delete-object', id: 'shape:old', version: { ts: 1, actor: 'web' } })
    const compact = spyOn(store, 'compact').mockImplementation(() => { throw new Error('checkpoint unavailable') })
    try {
        store.appendOps(U, D, P, [...Array<Uint8Array>(OPS_PAGE_LIMIT).fill(filler), ...tail.map(encodeOp)], 'web')
        expect(compact).toHaveBeenCalled()
        expect(store.latestSnapshot(U, D, P)).toBeNull()
        expect(store.opsSince(U, D, P, 0)).toHaveLength(OPS_PAGE_LIMIT)

        const pulled = store.reconstructDevicePage(U, D, P)
        expect(liveLines(pulled.bytes)).toBe(1)
        expect(store.overlayAtHead(U, D, P).shapes.map((shape) => shape.shapeId)).toEqual(['shape:tail'])

        // A later overlay-only op makes the tablet's base historical.
        store.appendOps(U, D, P, [filler], 'web')
        expect(store.deviceRevision(U, D, P)).not.toBe(pulled.revision)
        store.applyDevicePut(U, D, P, tabletUndoFirstStroke(pulled.bytes), pulled.revision)
        expect(liveLines(store.reconstructDevicePage(U, D, P).bytes)).toBe(0)
    } finally {
        compact.mockRestore()
    }
})

test.each(['marker', 'legacy hash'])('solo tablet Undo and Redo preserve exact file bytes (%s)', (baseKind) => {
    const store = freshStore()
    const drawn = tabletDraw(RmDocument.empty(TABLET_AUTHOR).serialize(), [{ x: 0, y: 0 }, { x: 30, y: 30 }])
    const legacy = store.putPage(U, D, P, '', drawn, 'rmsyncd')
    expect(store.seedSnapshotFromBlob(U, D, P)).toBe(true)
    const undone = tabletUndoFirstStroke(drawn)
    let revision = baseKind === 'legacy hash' ? legacy.revision : store.deviceRevision(U, D, P)
    for (const bytes of [undone, drawn, undone]) {
        const oldBase = revision
        const priorHead = store.latestOpSeq(U, D, P)
        const result = store.applyDevicePut(U, D, P, bytes, oldBase)
        expect(result.changed).toBe(true)
        expect(result.merged).toBe(false)
        const head = store.latestOpSeq(U, D, P)
        expect(head).toBeGreaterThan(priorHead)
        expect(store.stateAt(U, D, P, head).rm).toEqual(bytes)
        expect(store.reconstructDevicePage(U, D, P)).toEqual({ bytes, revision: result.revision })
        expect(store.changesSince(U, 0).at(-1)?.revision).toBe(result.revision)
        expect(store.applyDevicePut(U, D, P, bytes, oldBase)).toEqual({
            changed: false, merged: false, revision: result.revision,
        })
        revision = result.revision
    }
})

test('an acknowledged tablet save preserves valid native wire bytes across overlay-only edits', () => {
    const store = freshStore()
    const initial = RmDocument.empty(TABLET_AUTHOR).serialize()
    store.putPage(U, D, P, '', initial, 'rmsyncd')
    expect(store.seedSnapshotFromBlob(U, D, P)).toBe(true)
    const base = store.deviceRevision(U, D, P)
    const saved = initial.slice()
    const reader = new TaggedBlockReader(saved)
    reader.readHeader()
    let header = reader.readBlockHeader()
    while (header && header.blockType !== BlockType.MigrationInfo) {
        reader.endBlock()
        header = reader.readBlockHeader()
    }
    expect(header?.blockType).toBe(BlockType.MigrationInfo)
    reader.readId(1)
    expect(reader.readBool(2)).toBe(true)
    saved[reader.data.tell() - 1] = 2
    expect(RmDocument.parse(saved).serialize()).toEqual(initial)
    const overlay = encodeOp({ op: 'delete-object', id: 'shape:gone', version: { ts: 1, actor: 'web' } })
    store.appendOps(U, D, P, [overlay], 'web')
    const result = store.applyDevicePut(U, D, P, saved, base)
    expect(result.changed).toBe(true)
    expect(result.merged).toBe(false)
    store.appendOps(U, D, P, [overlay], 'web')
    expect(store.reconstructDevicePage(U, D, P).bytes).toEqual(saved)
    expect(store.applyDevicePut(U, D, P, saved, base)).toEqual({
        changed: false, merged: false, revision: store.deviceRevision(U, D, P),
    })
})

test('a failed tablet-save delivery preserves the checkpoint auto-compaction would prune', () => {
    const store = freshStore()
    const seed = encodeSnapshotFixture(RmDocument.empty(TABLET_AUTHOR).serialize())
    const oldest = store.putSnapshot(U, D, P, seed)
    for (let i = 1; i < SNAPSHOT_KEEP; i++) store.putSnapshot(U, D, P, seed)
    const filler = encodeOp({ op: 'delete-object', id: 'shape:none', version: { ts: 1, actor: 'web' } })
    store.appendOps(U, D, P, Array<Uint8Array>(COMPACT_EVERY_N_OPS - 1).fill(filler), 'web')
    const before = store.reconstructDevicePage(U, D, P)
    const saved = tabletDraw(before.bytes, [{ x: 2, y: 2 }, { x: 4, y: 6 }])
    const compact = spyOn(store, 'compact')
    const notify = spyOn(store, 'recordOpChange').mockImplementationOnce(() => { throw new Error('feed unavailable') })
    try {
        expect(() => store.applyDevicePut(U, D, P, saved, before.revision)).toThrow('feed unavailable')
        expect(compact).toHaveBeenCalledTimes(1)
        expect(store.getSnapshotBytes(U, D, P, oldest)).toEqual(seed)
        expect(store.reconstructDevicePage(U, D, P)).toEqual(before)
        const result = store.applyDevicePut(U, D, P, saved, before.revision)
        expect(store.getSnapshotBytes(U, D, P, oldest)).toBeNull()
        expect(store.changesSince(U, 0).at(-1)?.revision).toBe(result.revision)
    } finally {
        notify.mockRestore()
        compact.mockRestore()
    }
})

test('device undo with a RECONSTRUCTABLE base propagates the deletion (exact path)', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:x', [{ x: 1, y: 1 }, { x: 9, y: 9 }]).map(encodeOp), 'web')
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:y', [{ x: 20, y: 20 }, { x: 40, y: 40 }]).map(encodeOp), 'web')

    const pulled = s.reconstructDevicePage(U, D, P)
    const undone = tabletUndoFirstStroke(pulled.bytes)
    s.applyDevicePut(U, D, P, undone, pulled.revision)
    expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(1) // x gone, y lives
})

test('H3/H4: an UNRECONSTRUCTABLE base never infers deletions (no vector guess)', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:x', [{ x: 1, y: 1 }, { x: 9, y: 9 }]).map(encodeOp), 'web')
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:y', [{ x: 20, y: 20 }, { x: 40, y: 40 }]).map(encodeOp), 'web')

    // the device pulls, then retention truncates its base's replay range away
    const pulled = s.reconstructDevicePage(U, D, P)
    s.compact(U, D, P, { keepAll: false, keepRecentOps: 0 })

    // stroke x is ABSENT from the device push (an undo), and x.clock is below
    // the device's max-seen clock for the author (y came later) — exactly the
    // shape where the old version-vector fallback would tombstone x. With the
    // base unreconstructable, deletion inference must REFUSE instead: x
    // survives (conservative resurrection beats a false deletion — a web
    // revert restoring x concurrently would otherwise lose it, panel H3/H4).
    const undone = tabletUndoFirstStroke(pulled.bytes)
    s.applyDevicePut(U, D, P, undone, pulled.revision)
    expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(2) // x survives, y lives
})

test('TWO TABLETS on one page: interleaved pushes with distinct bases converge', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    s.appendOps(U, D, P, webStroke(doc, { shapes: [] }, 'shape:w', [{ x: 5, y: 5 }, { x: 9, y: 9 }]).map(encodeOp), 'web')

    // both tablets pull the same state, then edit CONCURRENTLY offline
    const pullA = s.reconstructDevicePage(U, D, P)
    const pullB = s.reconstructDevicePage(U, D, P)
    // each real xochitl device stamps its OWN author uuid into its files
    const fileA = tabletDraw(pullA.bytes, [{ x: 20, y: 20 }, { x: 30, y: 30 }])
    const TABLET_B = 'b73f497f-0000-4000-a000-000000000000'
    const fileB = tabletDraw(pullB.bytes, [{ x: 50, y: 50 }, { x: 60, y: 60 }], TABLET_B)

    // A lands first; B lands with its now-stale base — ops commute, no CAS
    const ra = s.applyDevicePut(U, D, P, fileA, pullA.revision, 'rmsyncd-A')
    expect(ra.changed).toBe(true)
    const rb = s.applyDevicePut(U, D, P, fileB, pullB.revision, 'rmsyncd-B')
    expect(rb.changed).toBe(true)

    // web stroke + A's stroke + B's stroke, nothing lost, nothing deleted
    expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(3)

    // and B's next pull (the merged union) round-trips cleanly: pushing the
    // union back is an idempotent no-op, not a change storm
    const merged = s.reconstructDevicePage(U, D, P)
    const again = s.applyDevicePut(U, D, P, merged.bytes, merged.revision, 'rmsyncd-B')
    expect(again.changed).toBe(false)
})

test('CLONE COLLISION: same author uuid + same clock, different strokes - both survive', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    s.appendOps(U, D, P, webStroke(doc, { shapes: [] }, 'shape:w', [{ x: 5, y: 5 }, { x: 9, y: 9 }]).map(encodeOp), 'web')

    // two tablets restored from ONE backup: same author uuid, same Lamport
    // counter -> both allocate the SAME clock for their next (different) stroke
    const pullA = s.reconstructDevicePage(U, D, P)
    const pullB = s.reconstructDevicePage(U, D, P)
    const fileA = tabletDraw(pullA.bytes, [{ x: 20, y: 20 }, { x: 30, y: 30 }])
    const fileB = tabletDraw(pullB.bytes, [{ x: 50, y: 50 }, { x: 60, y: 60 }]) // same author!

    const ra = s.applyDevicePut(U, D, P, fileA, pullA.revision, 'rmsyncd-A')
    expect(ra.changed).toBe(true)
    const rb = s.applyDevicePut(U, D, P, fileB, pullB.revision, 'rmsyncd-B')
    // the OLD behavior silently dropped B's stroke: changed=false, merged=false
    expect(rb.changed).toBe(true)
    expect(rb.merged).toBe(true) // B must pull the union to adopt the re-key

    // web + A's stroke + B's re-keyed stroke: nothing lost
    expect(liveLines(s.reconstructDevicePage(U, D, P).bytes)).toBe(3)

    // idempotence after B pulls the union: pushing it back is a no-op
    const merged = s.reconstructDevicePage(U, D, P)
    const again = s.applyDevicePut(U, D, P, merged.bytes, merged.revision, 'rmsyncd-B')
    expect(again.changed).toBe(false)
    expect(again.merged).toBe(false)
})

// Orphaned-ink regression (WEFT-MEASURE-B / weft-cal15 copy 2, 2026-07-12):
// putSnapshotMerged union-merged the INK but took the publisher's OVERLAY
// verbatim, so a client that published a stale/empty overlay wiped every
// semantic shape it lacked while the ink survived — orphaned raw ink with no
// text mapping and no reattach option, made permanent because the snapshot was
// pinned PAST the upsert-object ops so reconstruction never replayed them.
test('putSnapshotMerged: a publisher empty overlay does NOT wipe op-log shapes', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:A', [{ x: 0, y: 0 }, { x: 10, y: 10 }]).map(encodeOp), 'web')
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:B', [{ x: 20, y: 0 }, { x: 30, y: 10 }]).map(encodeOp), 'web')
    expect(s.overlayAtHead(U, D, P).shapes.length).toBe(2)
    // a client publishes a snapshot whose overlay is EMPTY but carries the ink
    const rm = s.reconstructDevicePage(U, D, P).bytes
    s.putSnapshotMerged(U, D, P, encodeSnapshot(rm, { shapes: [] }))
    // both shapes SURVIVE the publish (they were only absent, not deleted)
    expect(s.overlayAtHead(U, D, P).shapes.map((x) => x.shapeId).sort()).toEqual(['shape:A', 'shape:B'])
})

test('an unchanged merged drawing avoids decoding its ink again', () => {
    const store = freshStore()
    const empty = RmDocument.empty(WEB_AUTHOR)
    store.putSnapshot(U, D, P, encodeSnapshotFixture(empty.serialize()))
    const overlay: OverlayDocument = { shapes: [] }
    webStroke(empty, overlay, 'shape:kept', [{ x: 0, y: 0 }, { x: 10, y: 10 }])
    const drawing = empty.serialize()
    const parse = spyOn(RmDocument, 'parse')
    try {
        const result = store.putSnapshotMerged(U, D, P, encodeSnapshot(drawing, overlay))
        const drawingParses = parse.mock.calls.filter(([bytes]) =>
            Buffer.compare(new Uint8Array(bytes), drawing) === 0)
        expect(drawingParses.length).toBeLessThanOrEqual(2)
        expect(result.merged).toBe(false)
        expect(decodeSnapshot(store.latestSnapshot(U, D, P)!.bytes).rm).toEqual(drawing)
    } finally {
        parse.mockRestore()
    }
})

test('putSnapshotMerged: a real deletion (newer tombstone) still propagates', () => {
    const s = freshStore()
    const doc = RmDocument.empty(WEB_AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:A', [{ x: 0, y: 0 }, { x: 10, y: 10 }]).map(encodeOp), 'web')
    s.appendOps(U, D, P, webStroke(doc, overlay, 'shape:B', [{ x: 20, y: 0 }, { x: 30, y: 10 }]).map(encodeOp), 'web')
    const rm = s.reconstructDevicePage(U, D, P).bytes
    // publisher intentionally deletes A (newer tombstone) and keeps B
    const pub: OverlayDocument = {
        shapes: overlay.shapes.filter((x) => x.shapeId === 'shape:B'),
        tombstones: { 'shape:A': { ts: 999, actor: 'web' } },
    }
    s.putSnapshotMerged(U, D, P, encodeSnapshot(rm, pub))
    expect(s.overlayAtHead(U, D, P).shapes.map((x) => x.shapeId)).toEqual(['shape:B'])
})

test('RUNTIME GUARD: an in-place device mutation the diff cannot see falls back to a snapshot (byte-equality enforced)', () => {
    // The line diff keys on item ids: a same-id in-place change (here a
    // recolor) produces ZERO ops with complete=true, so the cloud silently
    // kept the old value and diverged from the device file forever — the
    // same class as the 2026-07-14/16 incidents, for whatever vocabulary
    // gap comes next. The runtime guard verifies the reconstruction against
    // the pushed bytes and demotes to the snapshot path on any mismatch.
    const s = freshStore()
    const base = tabletDraw(RmDocument.empty(TABLET_AUTHOR).serialize(), [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
    ])
    s.applyDevicePut(U, D, P, base)
    const pulled = s.reconstructDevicePage(U, D, P)
    const doc = RmDocument.parse(pulled.bytes)
    const line = doc.blocks.find((b) => b.type === 'sceneLineItem') as unknown as {
        line: { color: number }
    }
    line.line.color = PenColor.RED
    const put = s.applyDevicePut(U, D, P, doc.serialize(), pulled.revision)
    expect(put.changed).toBe(true)
    // the cloud reconstruction is byte-faithful to the device push
    const recon = s.reconstructDevicePage(U, D, P).bytes
    const want = RmDocument.parse(doc.serialize()).serialize()
    expect(Buffer.from(recon).equals(Buffer.from(want))).toBe(true)
    // and the device is not told to pull anything back (no spurious rewrite)
    expect(put.merged).toBe(false)
})

test.each(['browser', 'tablet'] as const)('a racing %s save merges the visible native text record', (lastWriter) => {
    const store = freshStore()
    const scene = RmDocument.empty(TABLET_AUTHOR)
    createRootText(scene, { width: 100 })
    insertText(scene, null, 'Hidden', { authorUuid: TABLET_AUTHOR })
    const earlier = scene.rootTextBlock!
    earlier.extraData = Uint8Array.of(0xca, 0xfe)
    const hiddenBytes = writeBlocks([earlier])
    const visible = RmDocument.empty(TABLET_AUTHOR)
    createRootText(visible, { width: 200 })
    scene.blocks.push(visible.rootTextBlock!)
    const first = insertText(scene, null, 'Visible', { authorUuid: TABLET_AUTHOR })
    const initial = scene.serialize()
    store.putSnapshot(U, D, P, encodeSnapshotFixture(initial))
    const tabletBase = store.reconstructDevicePage(U, D, P).revision
    const tablet = RmDocument.parse(initial)
    const browser = RmDocument.parse(initial)
    insertText(tablet, first, ' tablet', { authorUuid: TABLET_AUTHOR })
    insertText(browser, first, ' browser', { authorUuid: WEB_AUTHOR })
    const publishBrowser = () => store.putSnapshotMerged(U, D, P, encodeSnapshotFixture(browser.serialize()))
    const publishTablet = () => store.applyDevicePut(U, D, P, tablet.serialize(), tabletBase)
    if (lastWriter === 'browser') {
        publishTablet()
        publishBrowser()
    } else {
        publishBrowser()
        publishTablet()
    }
    const saved = RmDocument.parse(store.reconstructDevicePage(U, D, P).bytes)
    const displayed = linearizeRootText(saved.tree().rootText!).flatMap(p => p.spans.map(s => s.text)).join('')
    expect(displayed).toContain('browser')
    expect(displayed).toContain('tablet')
    expect(writeBlocks([saved.blocks.find(block => block.type === 'rootText')!])).toEqual(hiddenBytes)
})

test.each(['browser', 'tablet'] as const)('an ambiguous %s text author cannot replace the accepted drawing', async publisher => {
    const relay = startCloud({ port: 0 })
    const store = relay.store
    const token = store.mintDeviceToken(U, 'test tablet')
    const endpoint = `http://127.0.0.1:${relay.port}/api/documents/${D}/pages/${P}`
    const accepted = RmDocument.empty(TABLET_AUTHOR)
    createRootText(accepted)
    insertText(accepted, null, 'Accepted', { authorUuid: TABLET_AUTHOR })
    const prior = encodeSnapshotFixture(accepted.serialize())
    const seq = store.putSnapshot(U, D, P, prior)
    const head = store.reconstructDevicePage(U, D, P)
    const changes = store.changesSince(U, 0)
    const incoming = RmDocument.empty(WEB_AUTHOR)
    createRootText(incoming)
    insertText(incoming, null, 'Only saved locally', { authorUuid: WEB_AUTHOR })
    incoming.blocks.shift()
    try {
        const response = await fetch(endpoint + (publisher === 'browser' ? '/snapshot' : '/rm'), {
            method: 'PUT',
            headers: {
                'x-device-token': token,
                'x-base-revision': head.revision,
            },
            body: (publisher === 'browser' ? encodeSnapshotFixture(incoming.serialize()) : incoming.serialize()) as unknown as BodyInit,
        })
        expect(response.status).toBe(422)
        expect(await response.json()).toEqual({ error: 'unresolved-text-author' })
        expect(store.latestSnapshotSeq(U, D, P)).toBe(seq)
        expect(store.getSnapshotBytes(U, D, P, seq)).toEqual(prior)
        expect(store.reconstructDevicePage(U, D, P)).toEqual(head)
        expect(store.changesSince(U, 0)).toEqual(changes)
    } finally {
        relay.stop()
    }
})

test.each(['browser', 'tablet'] as const)('a stale %s save adopts the newer native text width', publisher => {
    const store = freshStore()
    const original = RmDocument.empty(TABLET_AUTHOR)
    createRootText(original)
    insertText(original, null, 'Shared text', { authorUuid: TABLET_AUTHOR })
    const withWidth = (clock: number, width: number, mark: number) => {
        const doc = RmDocument.parse(original.serialize())
        const extension = new TaggedBlockWriter()
        extension.subblock(5, () => {
            extension.subblock(1, () => {
                extension.writeId(1, crdtId(1, clock))
                extension.writeFloat(2, width)
                extension.writeByte(3, mark)
            })
        })
        doc.rootTextBlock!.extraData = extension.getBytes()
        return doc.serialize()
    }
    const stale = withWidth(80, 720, 1)
    const initial = store.putSnapshot(U, D, P, encodeSnapshotFixture(stale))
    const tabletBase = store.reconstructDevicePage(U, D, P).revision
    const latest = withWidth(85, 820, 2)
    store.putSnapshot(U, D, P, encodeSnapshotFixture(latest))
    const result = publisher === 'browser'
        ? store.putSnapshotMerged(U, D, P, encodeSnapshotFixture(stale))
        : store.applyDevicePut(U, D, P, stale, tabletBase)
    expect(result.merged).toBe(true)
    const saved = RmDocument.parse(store.reconstructDevicePage(U, D, P).bytes)
    expect(saved.rootTextBlock?.text.width).toBe(820)
    expect(saved.rootTextBlock?.widthData?.register?.timestamp).toEqual(crdtId(1, 85))
    expect(store.getSnapshotBytes(U, D, P, initial)).toEqual(encodeSnapshotFixture(stale))
})

test.each(['fresh base', 'stale base', 'explicit same-layer edit', 'same-value browser write'] as const)(
    'tablet visibility PUT with %s keeps independent browser edits',
    async (scenario) => {
        const relay = startCloud({ port: 0, db: ':memory:' })
        const { store } = relay
        try {
            const token = store.mintDeviceToken(U, 'test tablet')
            const endpoint = `http://127.0.0.1:${relay.port}/api/documents/${D}/pages/${P}`
            const initial = RmDocument.empty(TABLET_AUTHOR)
            const first = initial.layers()[0]!.nodeId
            const second = initial.createLayer('Second layer', { authorUuid: TABLET_AUTHOR })
            const original = initial.serialize()
            const seq = store.putSnapshot(U, D, P, encodeSnapshotFixture(original))
            const ancestor = store.reconstructDevicePage(U, D, P)

            const browser = RmDocument.parse(original)
            expect(browser.setLayerVisible(first, false, { authorUuid: WEB_AUTHOR })).toBe(true)
            const sameValue = scenario === 'same-value browser write'
            if (sameValue) expect(browser.setLayerVisible(first, true, { authorUuid: WEB_AUTHOR })).toBe(true)
            expect(store.putSnapshotMerged(U, D, P, encodeSnapshotFixture(browser.serialize())).merged).toBe(false)
            const latest = store.reconstructDevicePage(U, D, P)
            expect(RmDocument.parse(latest.bytes).layers().map(layer => layer.visible)).toEqual([sameValue, true])

            const base = scenario === 'fresh base' ? latest : ancestor
            const tablet = RmDocument.parse(base.bytes)
            // Both writers independently allocate slot 2 for different UUIDs.
            const localAuthor = 'cccccccc-0000-4000-a000-000000000003'
            expect(tablet.setLayerVisible(second, false, { authorUuid: localAuthor })).toBe(true)
            if (scenario === 'explicit same-layer edit') {
                // A true->false->true tablet gesture is still an edit: its
                // register changed even though the initial value was true.
                expect(tablet.setLayerVisible(first, false, { authorUuid: localAuthor })).toBe(true)
                expect(tablet.setLayerVisible(first, true, { authorUuid: localAuthor })).toBe(true)
            }
            const tabletBytes = tablet.serialize()
            const response = await fetch(endpoint + '/rm', {
                method: 'PUT',
                headers: { 'x-device-token': token, 'x-base-revision': base.revision, connection: 'close' },
                body: tabletBytes as unknown as BodyInit,
            })
            expect(response.status).toBe(200)
            const receipt = await response.json() as { revision: string; merged: boolean }
            const carriesBrowser = scenario === 'stale base' || sameValue
            expect(receipt.merged).toBe(carriesBrowser)

            const saved = store.reconstructDevicePage(U, D, P)
            expect(saved.revision).toBe(receipt.revision)
            const restored = RmDocument.parse(saved.bytes)
            expect(restored.layers().map(layer => layer.visible))
                .toEqual([scenario === 'explicit same-layer edit' || sameValue, false])
            expect(restored.layers().map(layer => layer.label))
                .toEqual(tablet.layers().map(layer => layer.label))
            expect(store.getSnapshotBytes(U, D, P, seq)).toEqual(encodeSnapshotFixture(original))
            if (scenario === 'fresh base') expect(saved.bytes).toEqual(tabletBytes)

            if (carriesBrowser) {
                const register = restored.blocks.find(block => block.type === 'treeNode'
                    && block.nodeId.part1 === first.part1 && block.nodeId.part2 === first.part2)
                expect(register?.type === 'treeNode'
                    && restored.authorTable().get(register.visible.timestamp.part1)).toBe(WEB_AUTHOR)
                const local = restored.blocks.find(block => block.type === 'treeNode'
                    && block.nodeId.part1 === second.part1 && block.nodeId.part2 === second.part2)
                expect(local?.type === 'treeNode'
                    && restored.authorTable().get(local.visible.timestamp.part1)).toBe(localAuthor)

                // Receiving and uploading the merged drawing is idempotent.
                const retry = await fetch(endpoint + '/rm', {
                    method: 'PUT',
                    headers: { 'x-device-token': token, 'x-base-revision': saved.revision, connection: 'close' },
                    body: saved.bytes as unknown as BodyInit,
                })
                expect(await retry.json()).toMatchObject({ revision: saved.revision, merged: false })
                expect(store.reconstructDevicePage(U, D, P)).toEqual(saved)
            }
        } finally {
            relay.stop()
        }
    },
)

test('tablet PUT retains its own visibility register when both writers reach the same value', async () => {
    const relay = startCloud({ port: 0, db: ':memory:' })
    const { store } = relay
    const localAuthor = 'cccccccc-0000-4000-a000-000000000003'
    try {
        for (const visible of [false, true]) {
            const pageId = visible ? P + '-visible' : P
            const native = RmDocument.empty(TABLET_AUTHOR)
            const layer = native.layers()[0]!.nodeId
            const initial = native.serialize()
            store.putSnapshot(U, D, pageId, encodeSnapshotFixture(initial))
            const base = store.reconstructDevicePage(U, D, pageId)
            const edit = (authorUuid: string) => {
                const doc = RmDocument.parse(initial)
                doc.setLayerVisible(layer, false, { authorUuid })
                if (visible) doc.setLayerVisible(layer, true, { authorUuid })
                return doc
            }
            const browser = edit(WEB_AUTHOR)
            store.putSnapshotMerged(U, D, pageId, encodeSnapshotFixture(browser.serialize()))
            const tablet = edit(localAuthor)
            const tabletBytes = tablet.serialize()
            const peerHead = store.reconstructDevicePage(U, D, pageId).revision
            const token = store.mintDeviceToken(U, 'test tablet')
            const response = await fetch(`http://127.0.0.1:${relay.port}/api/documents/${D}/pages/${pageId}/rm`, {
                method: 'PUT',
                headers: { 'x-device-token': token, 'x-base-revision': base.revision, connection: 'close' },
                body: tabletBytes as unknown as BodyInit,
            })
            expect(response.status).toBe(200)
            const receipt = await response.json() as { revision: string; merged: boolean }
            expect(receipt.revision).not.toBe(peerHead)
            expect(receipt.merged).toBe(false)
            const saved = RmDocument.parse(store.reconstructDevicePage(U, D, pageId).bytes)
            const register = saved.blocks.find(block => block.type === 'treeNode'
                && block.nodeId.part1 === layer.part1 && block.nodeId.part2 === layer.part2)
            expect(register?.type === 'treeNode'
                && saved.authorTable().get(register.visible.timestamp.part1)).toBe(localAuthor)
            expect(saved.layers()[0]?.visible).toBe(visible)
        }
    } finally {
        relay.stop()
    }
})
