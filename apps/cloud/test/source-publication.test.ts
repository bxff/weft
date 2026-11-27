import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { startCloud, type CloudServer } from "../src/server";

const user = "source-publication";
const auth = { authorization: `Bearer dev:${user}` };
const old = new Uint8Array(512).fill(7);
const cold = new Uint8Array(512).fill(2);
const next = new Uint8Array(1024).fill(9);
const raw = (server: CloudServer) => server.store as unknown as {
  db: Database;
  syncRecoveryPath(path: string): void;
};

async function withRelay(run: (relay: {
  server: () => CloudServer;
  restart: () => void;
  dir: string;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "weft-source-publication-"));
  const path = join(dir, "relay.db");
  const prior = process.env.CLOUD_DEV_USER;
  process.env.CLOUD_DEV_USER = "1";
  let server = startCloud({ port: 0, db: path });
  const close = () => { server.stop(); raw(server).db.close(); };
  try {
    await run({
      server: () => server,
      restart: () => { close(); server = startCloud({ port: 0, db: path }); },
      dir: `${path}-files`,
    });
  } finally {
    close();
    if (prior === undefined) delete process.env.CLOUD_DEV_USER;
    else process.env.CLOUD_DEV_USER = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

const file = (server: CloudServer, doc: string) => `http://localhost:${server.port}/api/documents/${doc}/file`;
const put = (server: CloudServer, doc: string, bytes: Uint8Array) =>
  fetch(file(server, doc), { method: "PUT", headers: auth, body: Buffer.from(bytes) });
const get = (server: CloudServer, doc: string, headers = {}) =>
  fetch(file(server, doc), { headers: { ...auth, ...headers } });

test.each(["ENOSPC", "EDQUOT", "insert", "evict"] as const)(
  "failed replacement (%s) preserves bytes, ETag, residency and quota across a restart",
  (failure) => withRelay(async ({ server, restart, dir }) => {
    server().store.setUserQuota(user, "sources", 1024);
    server().store.putDocuments(user, JSON.stringify({ documents: [
      { id: "cold", lastOpened: 1 }, { id: "hot", lastOpened: 2 },
    ] }));
    expect((await put(server(), "cold", cold)).status).toBe(200);
    expect((await put(server(), "hot", old)).status).toBe(200);
    const original = await get(server(), "hot");
    const etag = original.headers.get("etag");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(old);
    const originalFiles = readdirSync(dir).sort();

    const capacity = failure === "ENOSPC" || failure === "EDQUOT";
    if (!capacity) {
      // Fail the replacement after its bytes are staged, or the victim
      // delete after the row has been swapped. Both must roll back.
      const clause = failure === "insert" ? "INSERT ON files WHEN NEW.doc = 'hot'" : "DELETE ON files WHEN OLD.doc = 'cold'";
      raw(server()).db.run(`
        CREATE TEMP TRIGGER fail_publication BEFORE ${clause}
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
      `);
    } else {
      const sync = raw(server()).syncRecoveryPath.bind(server().store);
      raw(server()).syncRecoveryPath = (path) => {
        if (path === dir) throw Object.assign(new Error("injected directory barrier failure"), { code: failure });
        sync(path);
      };
    }
    const failed = await put(server(), "hot", next);
    expect(failed.status).toBe(capacity ? 507 : 500);
    if (capacity) {
      expect(failed.headers.get("access-control-allow-origin")).toBe("*");
      expect(await failed.json()).toMatchObject({ reason: "capacity" });
    }
    expect(readdirSync(dir).sort()).toEqual(originalFiles);
    restart();
    expect(server().store.residentSources(user)).toEqual(["cold", "hot"]);
    expect(server().store.usageBytes(user, "sources")).toBe(1024);
    const response = await get(server(), "hot");
    expect(response.headers.get("etag")).toBe(etag);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(old);
    const validated = await get(server(), "hot", { "if-none-match": etag! });
    expect(validated.status).toBe(304);
    const range = await get(server(), "hot", { range: "bytes=50-99" });
    expect(range.status).toBe(206);
    expect(range.headers.get("etag")).toBe(etag);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(old.slice(50, 100));
    expect(new Uint8Array(await (await get(server(), "cold")).arrayBuffer())).toEqual(cold);

    expect((await put(server(), "hot", next)).status).toBe(200);
    expect((await get(server(), "cold")).status).toBe(204);
    const replaced = await get(server(), "hot");
    expect(replaced.headers.get("etag")).not.toBe(etag);
    expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(next);
    expect(readdirSync(dir)).toHaveLength(1);
  }),
);

test("actual SQLite pager FULL is reported as capacity without losing the old page", () =>
  withRelay(async ({ server, restart }) => {
    const url = `http://localhost:${server().port}/api/documents/pager/pages/page/rm`;
    const putPage = (bytes: Uint8Array, revision = "") => fetch(url, {
      method: "PUT", headers: { ...auth, "x-base-revision": revision }, body: Buffer.from(bytes),
    });
    const before = new Uint8Array(32).fill(1);
    const initial = await putPage(before);
    expect(initial.status).toBe(200);
    const { revision } = await initial.json() as { revision: string };
    const db = raw(server()).db;
    const count = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
    db.run(`PRAGMA max_page_count = ${count}`);
    const result = await putPage(new Uint8Array(1_000_000).fill(2), revision);
    expect(result.status).toBe(507);
    expect(await result.json()).toMatchObject({ reason: "capacity" });
    restart();
    const saved = await fetch(`http://localhost:${server().port}/api/documents/pager/pages/page/rm`, { headers: auth });
    expect(saved.status).toBe(200);
    expect(new Uint8Array(await saved.arrayBuffer())).toEqual(before);
  }),
);

test("a blocked Range transfer keeps delivering the original immutable inode after replacement", () =>
  withRelay(async ({ server }) => {
    const big = new Uint8Array(12 * 1024 * 1024).fill(31);
    expect((await put(server(), "hot", big)).status).toBe(200);
    const oldPath = server().store.getFileRef(user, "hot")!.path;
    const response = await get(server(), "hot", { range: "bytes=1-" });
    expect(response.status).toBe(206);
    const reader = response.body!.getReader();
    const lead = await reader.read();
    expect(lead.done).toBe(false);
    expect(lead.value!.length).toBeLessThan(big.length - 1);
    expect((await put(server(), "hot", next)).status).toBe(200);
    expect(existsSync(oldPath)).toBe(false);
    let length = lead.value!.length;
    expect(lead.value!.every((b) => b === 31)).toBe(true);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value.every((b) => b === 31)) throw new Error("wrong bytes in old range");
      length += value.length;
    }
    expect(length).toBe(big.length - 1);
    const latest = await get(server(), "hot");
    expect(latest.headers.get("etag")).not.toBe(response.headers.get("etag"));
    expect(new Uint8Array(await latest.arrayBuffer())).toEqual(next);
  }),
);

test("on restart only unreferenced source-shaped files are removed", () =>
  withRelay(async ({ server, restart, dir }) => {
    expect((await put(server(), "hot", old)).status).toBe(200);
    const live = server().store.getFileRef(user, "hot")!;
    const orphan = join(dir, "b".repeat(64));
    const other = join(dir, "unrelated");
    writeFileSync(orphan, next);
    writeFileSync(other, "keep");
    restart();
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(live.path)).toBe(true);
    const response = await get(server(), "hot");
    expect(response.headers.get("etag")).toBe(`"${live.etag}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(old);
  }),
);

test.each(["before-commit", "after-commit"] as const)(
  "source replacement survives SIGKILL %s without a mixed state",
  async (phase) => {
    const dir = mkdtempSync(join(tmpdir(), "weft-source-crash-"));
    const path = join(dir, "relay.db");
    const files = `${path}-files`;
    const ready = join(dir, "ready");
    const blocked = join(dir, "blocked");
    const child = Bun.spawn([process.execPath, "--eval", `
      import { startCloud } from ${JSON.stringify(import.meta.resolve("../src/server"))};
      import { writeFileSync, renameSync } from "node:fs";
      const relay = startCloud({ port: 0, db: ${JSON.stringify(path)} });
      const user = ${JSON.stringify(user)};
      relay.store.setUserQuota(user, "sources", 1024);
      relay.store.putDocuments(user, JSON.stringify({ documents: [
        { id: "cold", lastOpened: 1 }, { id: "hot", lastOpened: 2 },
      ] }));
      relay.store.putFile(user, "cold", new Uint8Array(512).fill(2));
      relay.store.putFile(user, "hot", new Uint8Array(512).fill(7));
      function pause() {
        writeFileSync(${JSON.stringify(blocked)}, "");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
        throw Error("test failed to kill paused relay");
      }
      if (${phase === "before-commit"}) {
        const sync = relay.store.syncRecoveryPath.bind(relay.store);
        relay.store.syncRecoveryPath = (path) => {
          sync(path);
          if (path === ${JSON.stringify(dir)}) pause();
        };
      } else {
        relay.store.unlinkSource = pause;
      }
      const ready = ${JSON.stringify(ready)};
      writeFileSync(ready + ".tmp", String(relay.port));
      renameSync(ready + ".tmp", ready);
    `], {
      cwd: dir, stdout: "ignore", stderr: "inherit",
      env: { HOST: "127.0.0.1", CLOUD_DEV_USER: "1" },
    });
    let relay: CloudServer | undefined;
    const prior = process.env.CLOUD_DEV_USER;
    async function waitFor(path: string) {
      const until = Date.now() + 4000;
      while (!existsSync(path)) {
        if (child.exitCode !== null || Date.now() >= until) throw Error("source relay did not reach rendezvous");
        await Bun.sleep(15);
      }
    }
    try {
      await waitFor(ready);
      const port = Number(readFileSync(ready, "utf8"));
      const request = fetch(`http://127.0.0.1:${port}/api/documents/hot/file`, {
        method: "PUT", headers: auth, body: Buffer.from(next),
        signal: AbortSignal.timeout(4000),
      }).then((r) => r.status, () => "disconnected");
      await waitFor(blocked);
      expect(readdirSync(files)).toHaveLength(3);
      child.kill("SIGKILL");
      await child.exited;
      expect(await request).toBe("disconnected");
      process.env.CLOUD_DEV_USER = "1";
      relay = startCloud({ port: 0, db: path });
      const committed = phase === "after-commit";
      expect(relay.store.residentSources(user)).toEqual(committed ? ["hot"] : ["cold", "hot"]);
      expect(relay.store.usageBytes(user, "sources")).toBe(1024);
      expect(readdirSync(files)).toHaveLength(committed ? 1 : 2);
      expect(new Uint8Array(await (await get(relay, "hot")).arrayBuffer())).toEqual(committed ? next : old);
      if (!committed) {
        expect(new Uint8Array(await (await get(relay, "cold")).arrayBuffer())).toEqual(cold);
      }
      // The disconnected caller may safely repeat the same request either way.
      expect((await put(relay, "hot", next)).status).toBe(200);
      expect((await get(relay, "cold")).status).toBe(204);
      expect(new Uint8Array(await (await get(relay, "hot")).arrayBuffer())).toEqual(next);
      expect(readdirSync(files)).toHaveLength(1);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      if (relay) { relay.stop(); raw(relay).db.close(); }
      if (prior === undefined) delete process.env.CLOUD_DEV_USER;
      else process.env.CLOUD_DEV_USER = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10_000,
);
