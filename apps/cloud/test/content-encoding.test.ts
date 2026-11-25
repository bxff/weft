import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { get as httpGet } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants as zlib, gunzipSync, gzipSync } from "node:zlib";
import { startCloud, type CloudServer } from "../src/server";
import { encodeSnapshot } from "@weft/sync-engine";

let dir: string;
let cloud: CloudServer;
const sdk = "export const editor = 'native';\n".repeat(500);
const nativePage = new Uint8Array(readFileSync(join(import.meta.dir, "../../../fixtures/mako-p1.rm")));
const snapshot = encodeSnapshot(nativePage, { shapes: [] });
const doc = "55555555-5555-4555-a555-555555555555";
const page = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const endpoint = `/api/documents/${doc}/pages/${page}/snapshot`;
let seq: number;
const previousDevUser = process.env.CLOUD_DEV_USER;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "weft-precompressed-"));
  writeFileSync(join(dir, "sdk.js"), sdk);
  writeFileSync(join(dir, "sdk.js.gz"), gzipSync(sdk));
  writeFileSync(join(dir, "sdk.js.br"), brotliCompressSync(Buffer.from(sdk)));
  writeFileSync(join(dir, "gzip-only.js"), sdk);
  writeFileSync(join(dir, "gzip-only.js.gz"), gzipSync(sdk));
  writeFileSync(join(dir, "brotli-only.js"), sdk);
  writeFileSync(join(dir, "brotli-only.js.br"), brotliCompressSync(Buffer.from(sdk)));
  writeFileSync(join(dir, "index.html"), "<html>editor</html>");
  mkdirSync(join(dir, "_app"));
  mkdirSync(join(dir, "fonts"));
  writeFileSync(join(dir, "_app/existing.js"), sdk);
  writeFileSync(join(dir, "fonts/existing.woff2"), "font fixture");
  process.env.CLOUD_DEV_USER = "1";
  cloud = startCloud({ port: 0, staticDir: dir });
  seq = cloud.store.putSnapshot("reader", doc, page, snapshot);
});
afterAll(() => {
  cloud.stop();
  rmSync(dir, { recursive: true, force: true });
  if (previousDevUser === undefined) delete process.env.CLOUD_DEV_USER;
  else process.env.CLOUD_DEV_USER = previousDevUser;
});

const get = (path: string, enc: string, extra: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${cloud.port}${path}`, { headers: { accept: "text/html", "accept-encoding": enc, ...extra } });

test("static builds serve the negotiated encoding with the original MIME type", async () => {
  for (const [offer, expected] of [
    ["gzip, deflate, br, zstd", "br"], ["br;q=1,gzip;q=0.5", "br"], ["gzip", "gzip"], ["br;q=0, gzip;q=0, *;q=1", null],
    ["br;q=0.3,gzip;q=0.8", "gzip"], ["", null],
  ] as const) {
    const r = await get("/sdk.js", offer);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(r.headers.get("content-encoding")).toBe(expected);
    expect(r.headers.get("vary")).toContain("Accept-Encoding");
    expect(await r.text()).toBe(sdk);
  }
  // Older builds have no compressed SPA fallback.
  expect(await (await get("/app/book/page", "gzip")).text()).toBe("<html>editor</html>");
  expect((await get("/app/book/page", "gzip, identity;q=0")).status).toBe(406);
  expect((await get("/sdk.js", "*;q=0")).status).toBe(406);
  expect((await get("/sdk.js", "br;Q=0, gzip;Q=0, identity;Q=0")).status).toBe(406);
});

test("static encoding ties preserve explicit identity and wildcard order", async () => {
  const responses = await Promise.all([
    get("/sdk.js", "identity,gzip,br"), get("/sdk.js", "gzip,*;q=1"),
    get("/sdk.js", "gzip, identity, br"), get("/brotli-only.js", "gzip, identity, br"),
  ]);
  expect(responses.map((response) => response.headers.get("content-encoding"))).toEqual([null, "gzip", "gzip", null]);
  for (const response of responses) {
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.text()).toBe(sdk);
  }
});

test("the Chromium offer falls back to the available static sidecar", async () => {
  for (const [path, expected] of [["/gzip-only.js", "gzip"], ["/brotli-only.js", "br"]] as const) {
    const response = await get(path, "gzip, deflate, br, zstd");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe(expected);
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.text()).toBe(sdk);
  }
});

test("missing assets anywhere return 404 while HTML page navigation keeps its shell", async () => {
  for (const path of [
    "/_app/immutable/missing.js", "/fonts/missing.woff2", "/images/missing.png",
    "/styles/missing.css", "/missing.js.map", "/manifest.webmanifest", "/favicon.ico",
    "/service-worker.js", "/data.json", "/missing.html", "/assets/missing.custom",
    "/images/missing%2Epng", "/images/missing.png/", "/assets/extensionless",
    "/docs/introduction", "/fonts/extensionless", "/_app/extensionless", "/unknown",
  ]) {
    for (const offer of ["identity", "gzip", "br, gzip, identity;q=0"]) {
      const response = await get(path, offer);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect(response.headers.get("content-encoding")).toBeNull();
    }
  }
  for (const path of ["/app/book/page", "/library", "/settings/keys"]) {
    const navigation = await get(path, "gzip", { "sec-fetch-dest": "document" });
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toBe("<html>editor</html>");
    expect(navigation.headers.get("vary")).toBe("Accept-Encoding, Accept, Sec-Fetch-Dest");
  }
  for (const headers of [
    { accept: "*/*" },
    { accept: "application/json" },
    { accept: "text/html;q=0, */*;q=1" },
    { accept: "text/html", "sec-fetch-dest": "image" },
    { accept: "text/html", "sec-fetch-dest": "script" },
    { accept: "text/html", "sec-fetch-dest": "empty" },
  ]) {
    const response = await get("/app/book/page", "gzip", headers);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Accept, Sec-Fetch-Dest");
  }
  expect((await get("/missing%zz", "identity")).status).toBe(400);
  for (const [path, body] of [["/_app/existing.js", sdk], ["/fonts/existing.woff2", "font fixture"]]) {
    const response = await get(path!, "identity");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  }
});

test("authenticated snapshot representations preserve the exact bytes and checkpoint", async () => {
  for (const [offer, encoding] of [
    ["gzip, deflate, br, zstd", "br"], ["gzip", "gzip"], ["identity", null], ["gzip;q=0", null],
    ["br;q=0,gzip;q=0.5", "gzip"], ["br;q=0.3,gzip;q=0.8", "gzip"],
    ["*;q=1", "br"], ["br;q=0,gzip;q=0,*;q=1", null],
  ] as const) {
    const r = await get(endpoint, offer, { authorization: "Bearer dev:reader" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-snapshot-seq")).toBe(String(seq));
    expect(r.headers.get("x-snapshot-op-seq")).toBe("0");
    expect(r.headers.get("x-snapshot-revert")).toBe("0");
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(r.headers.get("vary")).toContain("Accept-Encoding");
    expect(r.headers.get("content-encoding")).toBe(encoding);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(snapshot);
  }
  const unchanged = await get(endpoint, "gzip", {
    authorization: "Bearer dev:reader", "x-if-snapshot-seq-gt": String(seq),
  });
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get("content-encoding")).toBeNull();
  expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
  expect((await get(endpoint, "gzip", { authorization: "Bearer dev:other" })).status).toBe(204);
});

// Node HTTP does not transparently decompress the body like fetch does.
function raw(path: string, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    httpGet(`http://127.0.0.1:${cloud.port}${path}`, {
      headers: { authorization: "Bearer dev:reader", "accept-encoding": encoding },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    }).on("error", reject);
  });
}

test("compressed snapshot transfers fewer bytes and decodes to the exact stored data", async () => {
  const [gzip, brotli] = await Promise.all([raw(endpoint, "gzip"), raw(endpoint, "br")]);
  expect(gzip.length).toBeLessThan(snapshot.length);
  expect(brotli.length).toBeLessThan(gzip.length);
  expect(new Uint8Array(gunzipSync(gzip))).toEqual(snapshot);
  expect(new Uint8Array(brotliDecompressSync(brotli))).toEqual(snapshot);
});

test("Brotli keeps the faster compression setting above 2 MiB", async () => {
  const boundaryPage = "ffffffff-ffff-4fff-afff-ffffffffffff";
  const path = `/api/documents/${doc}/pages/${boundaryPage}/snapshot`;
  const overlay = { shapes: [], padding: "" };
  const paddingStart = encodeSnapshot(nativePage, overlay).byteLength;
  const limit = 2 * 1024 * 1024;
  for (const [size, quality] of [[limit, 5], [limit + 1, 2]] as const) {
    overlay.padding = "x".repeat(size - paddingStart);
    const bytes = encodeSnapshot(nativePage, overlay);
    expect(bytes.byteLength).toBe(size);
    cloud.store.putSnapshot("reader", doc, boundaryPage, bytes);
    const compressed = await raw(path, "br");
    expect(compressed.equals(brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: quality } }))).toBe(true);
    expect(brotliDecompressSync(compressed).equals(bytes)).toBe(true);
  }
});

test("unchanged and unacceptable snapshot responses do not read the snapshot file", async () => {
  const readFile = spyOn(fs, "readFileSync");
  try {
    const auth = { authorization: "Bearer dev:reader" };
    const unchanged = await get(endpoint, "gzip", { ...auth, "x-if-snapshot-seq-gt": String(seq) });
    expect(unchanged.status).toBe(304);
    const refused = await get(endpoint, "br;q=0, gzip;Q=0, identity;q=0", auth);
    expect(refused.status).toBe(406);
    expect((await refused.arrayBuffer()).byteLength).toBe(0);
    expect(readFile).not.toHaveBeenCalled();
  } finally {
    readFile.mockRestore();
  }
});
