/**
 * #82 daemon auto-update wire: GET /api/daemon/release serves the configured
 * binary with ETag = sha256; If-None-Match with the daemon's own sha answers
 * 304 header-only (the steady state); unset env answers 404 (feature inert).
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloud, type CloudServer } from "../src/server";

let server: CloudServer;
let base: string;
const auth = { authorization: "Bearer dev:updater" };

beforeAll(() => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop());
afterEach(() => {
  delete process.env.WEFT_DAEMON_RELEASE;
});

test("404 when no release is configured (feature inert)", async () => {
  const r = await fetch(`${base}/api/daemon/release`, { headers: auth });
  expect(r.status).toBe(404);
});

test("serves the binary with a sha256 ETag; own-sha If-None-Match gets 304", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-release-"));
  const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
  const path = join(dir, "rmsyncd");
  writeFileSync(path, binary);
  process.env.WEFT_DAEMON_RELEASE = path;

  const r = await fetch(`${base}/api/daemon/release`, { headers: auth });
  expect(r.status).toBe(200);
  const etag = r.headers.get("etag")!;
  expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  const got = new Uint8Array(await r.arrayBuffer());
  expect([...got]).toEqual([...binary]);
  // the declared sha really is the body's sha (the daemon verifies this)
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(got);
  expect(etag).toBe(`"${hasher.digest("hex")}"`);

  // a daemon already running this binary: header-only 304
  const cached = await fetch(`${base}/api/daemon/release`, {
    headers: { ...auth, "if-none-match": etag },
  });
  expect(cached.status).toBe(304);
  expect((await cached.arrayBuffer()).byteLength).toBe(0);

  // a daemon running something OLDER: full body again
  const stale = await fetch(`${base}/api/daemon/release`, {
    headers: { ...auth, "if-none-match": '"' + "0".repeat(64) + '"' },
  });
  expect(stale.status).toBe(200);
});

test("auth required", async () => {
  const r = await fetch(`${base}/api/daemon/release`);
  expect([401, 403]).toContain(r.status);
});
