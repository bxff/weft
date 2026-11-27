import { expect, test } from "bun:test";
import { RmDocument, Pen, PenColor, crdtId } from "@weft/rm-format";
import { startCloud } from "../src/server";
import type { OverlayDocument } from "@weft/sync-engine";

const author = "aaaaaaaa-0000-4000-a000-000000000001";
const notebookId = "aaaaaaaa-0000-4000-a000-000000000002";
const pageId = "aaaaaaaa-0000-4000-a000-000000000003";
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const binding = { toId: "shape:target", props: { terminal: "start" } };
const overlay: OverlayDocument = { shapes: [{
  shapeId: "shape:arrow", kind: "arrow", x: 0, y: 0, rotation: 0,
  props: { weftArrowLinks: [binding] }, rendered: [], renderRevision: "",
  state: "live", version: { actor: author, ts: 1 },
}] };

function line(x: number) {
  return {
    kind: "line" as const, tool: Pen.BALLPOINT_2, color: PenColor.BLACK,
    thicknessScale: 1, startingLength: 0, timestamp: crdtId(0, 1), moveId: null,
    points: [
      { x, y: 100, speed: 0, direction: 0, width: 8, pressure: 100 },
      { x, y: 200, speed: 0, direction: 0, width: 8, pressure: 100 },
    ],
  };
}

function fixture() {
  const base = RmDocument.empty(author);
  base.appendLine(line(100), { authorUuid: author });
  const native = base.serialize();
  // Stock Undo removes a block outright. A fresh-pairing PUT from unknown
  // ancestry cannot prove this removal; explicit restore has the exact base.
  const current = RmDocument.parse(native);
  current.appendLine(line(200), { authorUuid: author });
  current.blocks.splice(current.blocks.findIndex(b => b.type === "sceneLineItem"), 1);
  return {
    version: 1,
    notebook: { id: notebookId, name: "Recovery", type: "notebook", parent: "",
      pages: [{ id: pageId, template: "Blank" }] },
    pages: [{ id: pageId, nativeBase64: Buffer.from(native).toString("base64"),
      nativeSha256: digest(native), currentNativeBase64: Buffer.from(current.serialize()).toString("base64"),
      overlay, assets: [] }],
  };
}

test("explicit recovery restores editable state and reconciles tablet Undo into an empty relay", async () => {
  const host = process.env.HOST;
  process.env.HOST = "127.0.0.1";
  const cloud = startCloud({ port: 0, db: ":memory:" });
  try {
    const baseUrl = "http://127.0.0.1:" + cloud.port + "/api";
    const credential = (user: string) => ({ "x-api-key": cloud.store.mintApiKey(user, "restore").key });
    const post = (body: object, credential: Record<string, string>) => fetch(baseUrl + "/recovery/notebook", {
      method: "POST", headers: { ...credential, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const expected = { ok: true, notebookId };
    const fresh = credential("fresh");
    const other = credential("other");
    const body = fixture();
    const badDigest = {
      ...body, pages: [{ ...body.pages[0]!, nativeSha256: "0".repeat(64) }],
    };
    expect((await post(badDigest, fresh)).status).toBe(400);
    const device = { "x-device-token": cloud.store.mintDeviceToken("paired", "tablet") };
    expect((await post(body, device)).status).toBe(403);
    expect((await post(body, credential("paired"))).status).toBe(409);
    const result = await post(body, fresh);
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual(expected);
    const url = baseUrl + "/documents/" + notebookId + "/pages/" + pageId;
    const native = await fetch(url + "/rm", { headers: fresh });
    expect(native.status).toBe(200);
    const nativeDoc = RmDocument.parse(await native.arrayBuffer());
    expect([...nativeDoc.tree().walk()].filter(([, item]) => item.kind === "line")
      .map(([, item]) => item.kind === "line" ? item.points[0]?.x : 0)).toEqual([200]);
    const saved = await fetch(url + "/overlay", { headers: fresh });
    expect(await saved.json()).toEqual(overlay);
    expect((await fetch(url + "/rm", { headers: other })).status).toBe(404);
    const replay = await post(body, fresh);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(expected);
    const changed = await post({ ...body, notebook: { ...body.notebook, name: "Different" } }, fresh);
    expect(changed.status).toBe(409);

    cloud.store.setUserQuota("other", "created", 1);
    expect((await post(body, other)).status).toBe(507);
    expect((await fetch(url + "/rm", { headers: other })).status).toBe(404);
    const docs = await fetch(baseUrl + "/documents", { headers: other });
    expect(await docs.json()).toEqual({ documents: [] });
    cloud.store.setUserQuota("other", "created", null);
    expect((await post(body, other)).status).toBe(201);
  } finally {
    cloud.stop();
    if (host === undefined) delete process.env.HOST;
    else process.env.HOST = host;
  }
});
