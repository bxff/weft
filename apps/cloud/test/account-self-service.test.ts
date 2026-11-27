import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RmDocument } from "@weft/rm-format";
import { startCloud } from "../src/server";

const owner = "user_synthetic_owner", peer = "user_synthetic_peer";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(sub: string, age: number | null, issuedAgo = 0, azp = "https://synthetic.example") {
  const now = Math.floor(Date.now() / 1000);
  const data = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    sub, azp, sid: "sess_synthetic_" + sub, iss: "https://mock.clerk.invalid", nbf: now - 60,
    iat: now - issuedAgo, exp: now + 60, ...(age === null ? {} : { fva: [age, -1] }),
  });
  return data + "." + sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
}

async function waitFor(ready: () => boolean) {
  const limit = Date.now() + 2000;
  while (!ready() && Date.now() < limit) await Bun.sleep(10);
  expect(ready()).toBe(true);
}

function tarEntries(archive: Uint8Array) {
  const files = new Map<string, Buffer>();
  const buffer = Buffer.from(archive);
  for (let at = 0; at + 512 <= buffer.length;) {
    const header = buffer.subarray(at, at + 512);
    if (header[0] === 0) {
      expect(buffer.subarray(at)).toEqual(Buffer.alloc(1024));
      return files;
    }
    const path = header.subarray(0, 100).toString().split("\0")[0]!;
    const size = parseInt(header.toString("ascii", 124, 135), 8);
    const checksum = parseInt(header.toString("ascii", 148, 154), 8);
    expect(header.toString("ascii", 257, 263)).toBe("ustar\0");
    expect(header.reduce((n, byte, i) => n + (i >= 148 && i < 156 ? 32 : byte), 0)).toBe(checksum);
    files.set(path, buffer.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("truncated archive");
}

test("hosted delete verifies signed recent auth, fences HTTP and WS, and can resume after provider failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "weft-self-service-"));
  const env = ["HOST", "CLERK_SECRET_KEY", "WEFT_ACCOUNT_SELF_SERVICE", "WEFT_ACCOUNT_AUTHORIZED_ORIGIN", "WEFT_PASSWORD"] as const;
  const oldEnv = env.map(key => process.env[key]);
  process.env.HOST = "127.0.0.1";
  process.env.CLERK_SECRET_KEY = "sk_test_fixture";
  process.env.WEFT_ACCOUNT_SELF_SERVICE = "1";
  process.env.WEFT_ACCOUNT_AUTHORIZED_ORIGIN = "https://synthetic.example";
  delete process.env.WEFT_PASSWORD;
  const deleted: string[] = [];
  let providerDown = true;
  let cloud = startCloud({
    port: 0, db: join(root, "relay.sqlite"),
    testClerk: { jwtKey, retryMs: 10, deleteUser: async user => {
      if (providerDown) throw new Error("fixture provider unavailable");
      deleted.push(user);
    }},
  });
  const calls = () => {
    const base = "http://127.0.0.1:" + cloud.port;
    const call = (path: string, bearer: string, options = {}) => fetch(base + path, {
      ...options, headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    });
    const erase = (token: string, confirm = "DELETE") => call("/api/account", token, {
      method: "DELETE", body: JSON.stringify({ confirm, userId: peer }),
    });
    return { call, erase, base };
  };
  try {
    cloud.store.putDocuments(owner, '{"documents":[{"id":"own"}]}');
    cloud.store.putDocuments(peer, '{"documents":[{"id":"peer"}]}');
    cloud.store.putFile(owner, "own", new Uint8Array([0, 17, 255]));
    cloud.store.putFile(peer, "peer", new Uint8Array([1, 23, 35]));
    const native = RmDocument.empty("aaaaaaaa-0000-4000-a000-000000000001").serialize();
    cloud.store.putPage(owner, "own", "page", "", native, "fixture");
    cloud.store.putOverlay(owner, "own", "page", '{"shapes":[{"type":"text"}]}');
    cloud.store.putAsset(owner, "own", "page", "pic.png", new Uint8Array([7]));
    cloud.store.putPage(peer, "peer", "other-page", "", native, "peer-fixture");
    const device = cloud.store.mintDeviceToken(owner, "fixture");
    let { call, erase, base } = calls();
    const recent = jwt(owner, 0);
    expect((await erase(recent, "no")).status).toBe(400);
    expect((await erase(jwt(owner, 0, 0, "https://other.example"))).status).toBe(404);
    expect((await erase(jwt(owner, 9))).status).toBe(403);
    expect((await erase(jwt(owner, null))).status).toBe(403);
    expect((await erase(jwt(owner, 4, 61))).status).toBe(403);
    expect((await erase("dev:" + owner)).status).toBe(401);
    expect(cloud.store.isAccountFenced(owner)).toBe(false);
    const startExport = () => call("/api/account/export", recent, { method: "POST" });
    const exportTicket = async () => {
      const response = await startExport();
      expect(response.status).toBe(200);
      return (await response.json() as { ticket: string }).ticket;
    };
    const downloadWith = (ticket: string) => fetch(base + "/api/account/export/download", {
      method: "POST", body: new URLSearchParams({ ticket }),
    });
    const replaced = await exportTicket();
    const ticket = await exportTicket();
    expect((await downloadWith(replaced)).status).toBe(404);
    const download = await downloadWith(ticket);
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toBe("private, no-store");
    expect(download.headers.get("Content-Disposition")).toContain("weft-notebooks.tar");
    const files = tarEntries(new Uint8Array(await download.arrayBuffer()));
    expect(JSON.parse(files.get("documents.json")!.toString())).toEqual({ documents: [{ id: "own" }] });
    expect(files.get("pages/0/native.rm")).toEqual(Buffer.from(native));
    expect(JSON.parse(files.get("pages/0/page.json")!.toString()).overlay).toEqual({ shapes: [{ type: "text" }] });
    expect(files.get("pages/0/assets/0")).toEqual(Buffer.from([7]));
    expect(files.get("sources/0/content")).toEqual(Buffer.from([0, 17, 255]));
    expect(files.has("pages/1/native.rm")).toBe(false);
    expect(files.has("sources/1/content")).toBe(false);
    expect((await downloadWith(ticket)).status).toBe(404);
    const revokedExport = await exportTicket();
    const makeTicket = async () => {
      const r = await call("/api/ws-ticket", recent, { method: "POST" });
      expect(r.status).toBe(200);
      return ((await r.json()) as { ticket: string }).ticket;
    };
    const first = await makeTicket();
    const stale = await makeTicket();
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?ticket=" + first);
    await new Promise<void>((ok, fail) => {
      ws.onopen = () => ok();
      ws.onerror = fail;
    });
    const closed = new Promise<void>(ok => { ws.onclose = () => ok(); });
    expect((await erase(recent)).status).toBe(202);
    await closed;
    expect(cloud.store.isAccountFenced(owner)).toBe(true);
    expect(cloud.store.getFile(owner, "own")).toBeNull();
    expect((await downloadWith(revokedExport)).status).toBe(404);
    expect((await startExport()).status).toBe(410);
    expect((await call("/api/documents", recent)).status).toBe(410);
    expect((await call("/ws?ticket=" + stale, recent)).status).toBe(410);
    expect((await fetch(base + "/api/documents", { headers: { "x-device-token": device.token } })).status).toBe(401);
    expect((await call("/api/documents", jwt(peer, 0))).status).toBe(200);
    expect(deleted).toEqual([]);
    cloud.stop();

    providerDown = false;
    cloud = startCloud({
      port: 0, db: join(root, "relay.sqlite"),
      testClerk: { jwtKey, retryMs: 10, deleteUser: async user => { deleted.push(user); } },
    });
    ({ call, erase } = calls());
    await waitFor(() => cloud.store.manualDeletionComplete(owner));
    expect((await erase(jwt(owner, 0))).status).toBe(204);
    expect(deleted).toEqual([owner]);
    expect((await call("/api/documents", jwt(owner, 0))).status).toBe(410);
    expect(await (await call("/api/documents", jwt(peer, 0))).json()).toEqual({ documents: [{ id: "peer" }] });
  } finally {
    cloud.stop();
    env.forEach((key, index) => {
      const value = oldEnv[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker finishes explicit fenced deletion after a lost provider response without a usable session", async () => {
  const root = mkdtempSync(join(tmpdir(), "weft-manual-deletion-restart-"));
  const keys = ["HOST", "CLERK_SECRET_KEY", "WEFT_ACCOUNT_SELF_SERVICE", "WEFT_ACCOUNT_AUTHORIZED_ORIGIN", "WEFT_PASSWORD"] as const;
  const savedEnv = keys.map(key => process.env[key]);
  process.env.HOST = "127.0.0.1";
  process.env.CLERK_SECRET_KEY = "sk_test_fixture";
  process.env.WEFT_ACCOUNT_SELF_SERVICE = "1";
  process.env.WEFT_ACCOUNT_AUTHORIZED_ORIGIN = "https://synthetic.example";
  delete process.env.WEFT_PASSWORD;
  const provider = new Set([owner, peer, "storage-only-fenced"]);
  const calls: string[] = [];
  const deleteUser = async (user: string) => {
    calls.push(user);
    if (!provider.delete(user)) throw Object.assign(new Error("already absent"), { status: 404 });
    throw new Error("transport disconnected after provider accepted deletion");
  };
  const db = join(root, "relay.sqlite");
  const start = (key: string, retryMs: number) => startCloud({
    port: 0, db, testClerk: { jwtKey: key, deleteUser, retryMs },
  });
  const cloud = start(jwtKey, 400);
  const oldSession = jwt(owner, 0);
  let restarted: ReturnType<typeof Bun.spawn> | undefined;
  const erase = (port: number) => fetch("http://127.0.0.1:" + port + "/api/account", {
    method: "DELETE", headers: { authorization: "Bearer " + oldSession },
    body: JSON.stringify({ confirm: "DELETE" }),
  });
  try {
    cloud.store.putDocuments(owner, '{"documents":[{"id":"owner"}]}');
    cloud.store.stageAccountPurge("storage-only-fenced");  // no manual intent
    expect((await erase(cloud.port)).status).toBe(202);
    expect(calls).toEqual([owner]);
    expect(provider.has(owner)).toBe(false); // provider accepted but lost ACK
    expect(cloud.store.manualDeletionComplete(owner)).toBe(false);
    expect(cloud.store.getDocuments(owner)).toBe('{"documents":[]}');
    cloud.stop();

    // Run a new relay process with a different public signer key. This
    // avoids Clerk SDK module-level JWKS caches in the old process.
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ type: "spki", format: "pem" }).toString();
    const ready = join(root, "ready"), retries = join(root, "retries");
    const script = `
      import { startCloud } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).pathname)};
      import { appendFileSync, writeFileSync } from "node:fs";
      const cloud = startCloud({ port: 0, db: ${JSON.stringify(db)}, testClerk: {
        jwtKey: ${JSON.stringify(rotated)}, retryMs: 10, deleteUser: async user => {
          appendFileSync(${JSON.stringify(retries)}, user + String.fromCharCode(10));
          throw Object.assign(new Error("already absent"), { status: 404 });
        }
      }});
      writeFileSync(${JSON.stringify(ready)}, String(cloud.port));
    `;
    restarted = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit", env: {
      HOST: "127.0.0.1", CLERK_SECRET_KEY: "sk_test_fixture", WEFT_ACCOUNT_SELF_SERVICE: "1",
      WEFT_ACCOUNT_AUTHORIZED_ORIGIN: "https://synthetic.example",
    } });
    await waitFor(() => existsSync(ready));
    expect((await erase(Number(readFileSync(ready, "utf8")))).status).toBe(401);
    const reopened = new Database(db, { readonly: true });
    try {
      await waitFor(() => !!reopened.query("SELECT 1 FROM account_manual_deletions WHERE user_id=? AND completed_at IS NOT NULL").get(owner));
      expect(readFileSync(retries, "utf8").trim().split("\n")).toEqual([owner]);
      expect(provider).toEqual(new Set([peer, "storage-only-fenced"]));
      await Bun.sleep(35);
      expect(readFileSync(retries, "utf8").trim().split("\n")).toEqual([owner]);
    } finally {
      reopened.close();
    }
  } finally {
    cloud.stop();
    if (restarted) { restarted.kill(); await restarted.exited; }
    keys.forEach((key, index) => {
      const value = savedEnv[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    rmSync(root, { recursive: true, force: true });
  }
});
