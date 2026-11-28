import { expect, test } from "bun:test";
import { RmDocument, Pen, PenColor, crdtId, lww, uuidToBytesLE } from "@weft/rm-format";
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

const imageId = "aaaaaaaa-0000-4000-a000-000000000004";
const filename = imageId + ".png";
const checkpointImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const replacementImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC", "base64");

function fixture() {
  const base = RmDocument.empty(author);
  base.appendLine(line(100), { authorUuid: author });
  base.blocks.push({
    type: "sceneImageInfo", extraData: new Uint8Array(), version: { min: 1, current: 1 },
    images: [{ uuid: imageId, filename: lww(crdtId(1, 11), filename), flags: lww(crdtId(1, 12), new Uint8Array([17, 0])) }],
  });
  base.appendImage({
    kind: "image", uuid: lww(crdtId(1, 12), uuidToBytesLE(imageId)), timestamp: crdtId(0, 0),
    vertices: [0, 0, 0, 0, 10, 0, 1, 0, 10, 10, 1, 1], indices: [0, 1, 2], filename: null,
  }, { authorUuid: author });
  const native = base.serialize();
  // Stock Undo removes a block outright. A fresh-pairing PUT from unknown
  // ancestry cannot prove this removal; explicit restore has the exact base.
  const current = RmDocument.parse(native);
  current.appendLine(line(200), { authorUuid: author });
  current.blocks.splice(current.blocks.findIndex(b => b.type === "sceneLineItem"), 1);
  return {
    version: 1, mode: "same-tablet-newer-native",
    notebook: { id: notebookId, name: "Recovery", type: "notebook", parent: "",
      pages: [{ id: pageId, template: "Blank" }] },
    pages: [{ id: pageId, nativeBase64: Buffer.from(native).toString("base64"),
      nativeSha256: digest(native),
      currentNative: { base64: Buffer.from(current.serialize()).toString("base64"),
        assets: [{ name: filename, sha256: digest(checkpointImage) }] },
      overlay, assets: [{ name: filename, sha256: digest(checkpointImage), base64: checkpointImage.toString("base64") }] }],
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
    const { mode: _mode, ...ordinary } = body;
    const { currentNative, ...storedPage } = body.pages[0]!;
    expect((await post(ordinary, fresh)).status).toBe(400); // A caller must declare newer-native provenance.
    expect((await post({ ...ordinary, pages: [{ ...storedPage, currentNativeBase64: currentNative.base64 }] }, fresh)).status).toBe(400);
    const withCurrentDigests = (assets: { name: string; sha256: string }[]) => ({
      ...body, pages: [{ ...storedPage, currentNative: { ...currentNative, assets } }],
    });
    expect((await post(withCurrentDigests([]), fresh)).status).toBe(400);
    expect((await post(withCurrentDigests([{ name: filename, sha256: digest(replacementImage) }]), fresh)).status).toBe(400);
    const checkpoint = credential("checkpoint");
    expect((await post({ ...ordinary, pages: [storedPage] }, checkpoint)).status).toBe(201);
    const url = baseUrl + "/documents/" + notebookId + "/pages/" + pageId;
    const exact = await fetch(url + "/rm", { headers: checkpoint });
    expect(Buffer.from(await exact.arrayBuffer()).toString("base64")).toBe(storedPage.nativeBase64);
    const exactImage = await fetch(url + "/assets/" + filename, { headers: checkpoint });
    expect(Buffer.from(await exactImage.arrayBuffer())).toEqual(checkpointImage);

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

test("file-backed recovery rolls back a durability fault and verifies the edited head after restart", async () => {
  const { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { encodeSnapshot } = await import("@weft/sync-engine");
  const host = process.env.HOST;
  process.env.HOST = "127.0.0.1";
  const dir = mkdtempSync(join(tmpdir(), "weft-restore-integrity-"));
  const db = join(dir, "restore.sqlite");
  const snapshots = join(dir, "restore.sqlite-files", "snapshots");
  let cloud = startCloud({ port: 0, db });
  try {
    const raw = cloud.store as unknown as {
      db: import("bun:sqlite").Database;
      syncPath(path: string): void;
    };
    const headers = { "x-api-key": cloud.store.mintApiKey("fresh", "restore").key, "content-type": "application/json" };
    const body = JSON.stringify(fixture());
    const post = () => fetch(`http://127.0.0.1:${cloud.port}/api/recovery/notebook`, { method: "POST", headers, body });
    const barrier = raw.syncPath.bind(raw);
    const checked: string[] = [];
    raw.syncPath = (path) => {
      expect(raw.db.inTransaction).toBe(true);
      expect(raw.db.query("PRAGMA synchronous").values()).toEqual([[2]]);
      checked.push(path);
      if (path === snapshots) throw new Error("synthetic directory flush failure");
      barrier(path);
    };
    expect((await post()).status).toBe(500);
    expect(checked.filter(path => path.startsWith(snapshots + "/"))).toHaveLength(2);
    expect(readdirSync(snapshots)).toEqual([]);
    expect(JSON.parse(cloud.store.getDocuments("fresh"))).toEqual({ documents: [] });
    expect(raw.db.query("SELECT * FROM recovery_imports").all()).toEqual([]);
    expect(raw.db.query("PRAGMA synchronous").values()).toEqual([[1]]);
    raw.syncPath = barrier;
    expect((await post()).status).toBe(201);
    expect(raw.db.query("PRAGMA synchronous").values()).toEqual([[1]]);
    const native = RmDocument.parse(Buffer.from(fixture().pages[0]!.currentNative.base64, "base64"));
    native.appendLine(line(333), { authorUuid: author });
    cloud.store.putSnapshot("fresh", notebookId, pageId, encodeSnapshot(native.serialize(), overlay));
    cloud.store.putAsset("fresh", notebookId, pageId, filename, replacementImage);
    const row = raw.db.query<{ path: string }, []>("SELECT path FROM page_snapshots ORDER BY seq DESC LIMIT 1").get()!;
    cloud.stop();
    raw.db.close();
    cloud = startCloud({ port: 0, db });
    expect((await post()).status).toBe(200);
    const edited = await fetch(`http://127.0.0.1:${cloud.port}/api/documents/${notebookId}/pages/${pageId}/rm`, { headers });
    expect([...RmDocument.parse(await edited.arrayBuffer()).tree().walk()]
      .some(([, item]) => item.kind === "line" && item.points[0]?.x === 333)).toBe(true);
    const exact = readFileSync(row.path);
    const corrupt = Buffer.from(exact);
    corrupt[corrupt.length - 1] ^= 0xff;
    writeFileSync(row.path, corrupt);
    expect((await post()).status).toBe(503);
    expect(readFileSync(row.path)).toEqual(corrupt); // no repair or re-import
    rmSync(row.path);
    expect((await post()).status).toBe(503);
    writeFileSync(row.path, exact);
    const live = cloud.store as unknown as { db: import("bun:sqlite").Database };
    // Rows written before the checksum migration have no trusted expected bytes.
    live.db.run("UPDATE page_snapshots SET sha256=NULL WHERE path=?", [row.path]);
    expect((await post()).status).toBe(503);
    expect(readFileSync(row.path)).toEqual(exact);
    live.db.run("UPDATE page_snapshots SET sha256=? WHERE path=?", [digest(exact), row.path]);
    live.db.run("UPDATE assets SET bytes=? WHERE user_id=?", [checkpointImage, "fresh"]);
    expect((await post()).status).toBe(503);
    live.db.run("DELETE FROM assets WHERE user_id=?", ["fresh"]);
    expect((await post()).status).toBe(503);
    cloud.store.putAsset("fresh", notebookId, pageId, filename, replacementImage);
    expect((await post()).status).toBe(200);
  } finally {
    cloud.stop();
    (cloud.store as unknown as { db: import("bun:sqlite").Database }).db.close();
    rmSync(dir, { recursive: true, force: true });
    if (host === undefined) delete process.env.HOST;
    else process.env.HOST = host;
  }
});

test.each(["acknowledged", "before-commit"] as const)(
  "recovery survives relay process loss: %s",
  async (phase) => {
    const { existsSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "weft-restore-process-loss-"));
    const db = join(dir, "restore.sqlite");
    const ready = join(dir, "ready");
    const blocked = join(dir, "blocked");
    const body = JSON.stringify(fixture());
    const subprocess = Bun.spawn(
      [process.execPath, "--eval", `
        import { startCloud } from ${JSON.stringify(import.meta.resolve("../src/server"))};
        import { writeFileSync, renameSync } from "node:fs";
        const cloud = startCloud({ port: 0, db: ${JSON.stringify(db)} });
        if (${phase === "before-commit"}) {
          const original = cloud.store.syncPath.bind(cloud.store);
          cloud.store.syncPath = path => {
            original(path);
            if (!path.endsWith("/snapshots")) return;
            writeFileSync(${JSON.stringify(blocked)}, "before commit");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
            throw Error("test failed to kill the paused relay");
          };
        }
        const key = cloud.store.mintApiKey("process-test", "restore").key;
        const ready = ${JSON.stringify(ready)};
        writeFileSync(ready + ".tmp", JSON.stringify({ port: cloud.port, key }));
        renameSync(ready + ".tmp", ready);
      `],
      { cwd: dir, env: { HOST: "127.0.0.1" }, stdout: "ignore", stderr: "inherit" },
    );
    let reopened: ReturnType<typeof startCloud> | undefined;
    const waitFor = async (path: string) => {
      const until = Date.now() + 5000;
      while (!existsSync(path)) {
        if (subprocess.exitCode !== null || Date.now() >= until) throw Error("relay did not reach test rendezvous");
        await Bun.sleep(15);
      }
    };
    try {
      await waitFor(ready);
      const { port, key } = JSON.parse(readFileSync(ready, "utf8")) as { port: number; key: string };
      const headers = { "x-api-key": key, "content-type": "application/json" };
      const post = (port: number) => fetch(`http://127.0.0.1:${port}/api/recovery/notebook`, {
        method: "POST", headers, body, signal: AbortSignal.timeout(5000),
      });
      if (phase === "acknowledged") {
        const result = await post(port);
        expect(result.status).toBe(201);
        expect(await result.json()).toEqual({ ok: true, notebookId });
        subprocess.kill("SIGKILL");
        await subprocess.exited;
      } else {
        const pending = post(port).then(response => response.status, () => "disconnected");
        await waitFor(blocked);
        subprocess.kill("SIGKILL");
        await subprocess.exited;
        expect(await pending).toBe("disconnected");
      }
      expect(subprocess.signalCode).toBe("SIGKILL");
      const host = process.env.HOST;
      try {
        process.env.HOST = "127.0.0.1";
        reopened = startCloud({ port: 0, db });
      } finally {
        if (host === undefined) delete process.env.HOST;
        else process.env.HOST = host;
      }
      const url = `http://127.0.0.1:${reopened.port}/api/documents/${notebookId}/pages/${pageId}`;
      if (phase === "before-commit") {
        expect(JSON.parse(reopened.store.getDocuments("process-test"))).toEqual({ documents: [] });
        expect((await fetch(url + "/rm", { headers })).status).toBe(404);
        expect((await post(reopened.port)).status).toBe(201);
      }
      expect((await post(reopened.port)).status).toBe(200);
      const native = await fetch(url + "/rm", { headers });
      expect(native.status).toBe(200);
      expect([...RmDocument.parse(await native.arrayBuffer()).tree().walk()]
        .filter(([, item]) => item.kind === "line")
        .map(([, item]) => item.kind === "line" ? item.points[0]?.x : 0)).toEqual([200]);
      const image = await fetch(url + "/assets/" + filename, { headers });
      expect(Buffer.from(await image.arrayBuffer())).toEqual(checkpointImage);
    } finally {
      if (subprocess.exitCode === null && subprocess.signalCode === null) subprocess.kill("SIGKILL");
      await subprocess.exited;
      reopened?.stop();
      (reopened?.store as unknown as { db: import("bun:sqlite").Database } | undefined)?.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 18000,
);
