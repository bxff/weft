/**
 * Abuse limits for the free public service: per-user request rate limiting
 * (429 + Retry-After, token bucket), per-IP /api/login brute-force bucket,
 * a per-batch cap on POST /ops, a default (non-zero) storage quota, and a
 * bounded /history response.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudStore } from "../src/store";
import { startCloud, type CloudServer } from "../src/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- rate limiting (tiny limits via env, own server) ----------

let rlServer: CloudServer;
let rlBase: string;
const H = { authorization: "Bearer dev:ratelimited" };

beforeAll(() => {
  process.env.CLOUD_DEV_USER = "1";
  process.env.WEFT_RATE_RPS = "2";
  process.env.WEFT_RATE_BURST = "3";
  rlServer = startCloud({ port: 0 });
  rlBase = `http://localhost:${rlServer.port}`;
});
afterAll(() => {
  rlServer.stop();
  delete process.env.WEFT_RATE_RPS;
  delete process.env.WEFT_RATE_BURST;
});

test("a user burst beyond the bucket gets 429 + Retry-After; tokens refill", async () => {
  // burst=3: three requests pass, the fourth is limited
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${rlBase}/api/documents`, { headers: H });
    expect(r.status).toBe(200);
  }
  const limited = await fetch(`${rlBase}/api/documents`, { headers: H });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  const body = (await limited.json()) as { retryAfterMs: number };
  expect(body.retryAfterMs).toBeGreaterThan(0);

  // rps=2 -> ~500ms buys a token back
  await sleep(700);
  const again = await fetch(`${rlBase}/api/documents`, { headers: H });
  expect(again.status).toBe(200);
});

test("rate limits are per USER (another user is unaffected by the burst)", async () => {
  // exhaust user A
  for (let i = 0; i < 5; i++)
    await fetch(`${rlBase}/api/documents`, {
      headers: { authorization: "Bearer dev:hammer" },
    });
  const a = await fetch(`${rlBase}/api/documents`, {
    headers: { authorization: "Bearer dev:hammer" },
  });
  expect(a.status).toBe(429);
  // user B sails through
  const b = await fetch(`${rlBase}/api/documents`, {
    headers: { authorization: "Bearer dev:bystander" },
  });
  expect(b.status).toBe(200);
});

test("/api/health is NOT rate limited (unauthenticated liveness probe)", async () => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${rlBase}/api/health`);
    expect(r.status).toBe(200);
  }
});

test("POST /ops rejects an oversized batch with 400 (per-batch op cap)", async () => {
  // MAX_OPS_PER_POST default is 1000; this server has default (env unset)
  const tiny = Buffer.from('{"noop":1}').toString("base64");
  const r = await fetch(`${rlBase}/api/documents/d/pages/p/ops`, {
    method: "POST",
    headers: {
      authorization: "Bearer dev:batcher",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ops: Array(1001).fill(tiny), author: null }),
  });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toContain(
    "too many ops",
  );
});

// ---------- login brute-force bucket (self-host mode, own server) ----------

test("/api/login brute force trips the per-IP bucket (429 after the burst)", async () => {
  process.env.WEFT_PASSWORD = "hunter2-correct";
  delete process.env.CLOUD_DEV_USER;
  const s = startCloud({ port: 0 });
  const base = `http://localhost:${s.port}`;
  try {
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: `wrong-${i}` }),
      });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(saw429).toBe(true); // burst is 10: attempt <=12 must trip it
  } finally {
    s.stop();
    delete process.env.WEFT_PASSWORD;
    process.env.CLOUD_DEV_USER = "1";
  }
});

// ---------- default storage quotas (STORAGE-PLAN §1) ----------

test("quotas default to 1 GiB created / 3 GiB sources when the envs are unset", async () => {
  delete process.env.WEFT_QUOTA_CREATED_BYTES;
  delete process.env.WEFT_QUOTA_SOURCES_BYTES;
  const s = startCloud({ port: 0 });
  try {
    const r = await fetch(`http://localhost:${s.port}/api/usage`, {
      headers: { authorization: "Bearer dev:quotadefault" },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      created: { limit: number };
      sources: { limit: number };
    };
    expect(body.created.limit).toBe(1024 * 1024 * 1024);
    expect(body.sources.limit).toBe(3 * 1024 * 1024 * 1024);
  } finally {
    s.stop();
  }
});

test("WEFT_QUOTA_*_BYTES=0 still means explicitly unlimited (self-host)", async () => {
  process.env.WEFT_QUOTA_CREATED_BYTES = "0";
  process.env.WEFT_QUOTA_SOURCES_BYTES = "0";
  const s = startCloud({ port: 0 });
  try {
    const r = await fetch(`http://localhost:${s.port}/api/usage`, {
      headers: { authorization: "Bearer dev:quotaunlimited" },
    });
    const body = (await r.json()) as {
      created: { limit: number };
      sources: { limit: number };
    };
    expect(body.created.limit).toBe(0);
    expect(body.sources.limit).toBe(0);
  } finally {
    s.stop();
    delete process.env.WEFT_QUOTA_CREATED_BYTES;
    delete process.env.WEFT_QUOTA_SOURCES_BYTES;
  }
});

// ---------- bounded history ----------

test("historyPoints caps at the newest `limit` ops, still ascending", () => {
  const s = new CloudStore(
    join(mkdtempSync(join(tmpdir(), "weft-histcap-")), "t.db"),
  );
  for (let i = 0; i < 12; i++) {
    s.appendOps(
      "u",
      "d",
      "p",
      [new TextEncoder().encode(JSON.stringify({ noop: i }))],
      "web",
    );
  }
  const all = s.historyPoints("u", "d", "p");
  expect(all.filter((x) => x.kind === "op").length).toBe(12);
  const capped = s.historyPoints("u", "d", "p", 5);
  const seqs = capped.filter((x) => x.kind === "op").map((x) => x.seq);
  expect(seqs.length).toBe(5);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // ascending
  // and they are the NEWEST five
  expect(seqs[seqs.length - 1]).toBe(s.latestOpSeq("u", "d", "p"));
});

// ---------- #55: per-doc usage breakdown ----------

test("GET /api/usage/breakdown groups a user's bytes by document, source split out", async () => {
  process.env.CLOUD_DEV_USER = "1";
  // this file's beforeAll pins a tiny rate bucket for the 429 tests; this
  // test makes 4 requests as one user, so give ITS server a normal bucket
  const priorRps = process.env.WEFT_RATE_RPS;
  const priorBurst = process.env.WEFT_RATE_BURST;
  delete process.env.WEFT_RATE_RPS;
  delete process.env.WEFT_RATE_BURST;
  const s = startCloud({ port: 0 });
  if (priorRps !== undefined) process.env.WEFT_RATE_RPS = priorRps;
  if (priorBurst !== undefined) process.env.WEFT_RATE_BURST = priorBurst;
  try {
    const base = `http://localhost:${s.port}`;
    const h = {
      authorization: "Bearer dev:breakdown",
      "content-type": "application/octet-stream",
    };
    // two docs: fat blob doc vs small one; fat also has a source PDF
    await fetch(`${base}/api/documents/fat/pages/p1/rm`, {
      method: "PUT",
      headers: h,
      body: new Uint8Array(50_000).fill(1),
    });
    await fetch(`${base}/api/documents/fat/file`, {
      method: "PUT",
      headers: { ...h, "content-type": "application/pdf" },
      body: new Uint8Array(20_000).fill(1),
    });
    await fetch(`${base}/api/documents/thin/pages/p1/rm`, {
      method: "PUT",
      headers: h,
      body: new Uint8Array(1_000).fill(1),
    });
    const r = await fetch(`${base}/api/usage/breakdown`, {
      headers: { authorization: "Bearer dev:breakdown" },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      docs: {
        doc: string;
        blobBytes: number;
        sourceBytes: number;
        totalBytes: number;
      }[];
      created: { bytes: number; limit: number };
      sources: { bytes: number; limit: number };
    };
    // descending by total, both docs present, blob bytes attributed
    expect(body.docs[0]!.doc).toBe("fat");
    expect(body.docs[0]!.blobBytes).toBeGreaterThanOrEqual(50_000);
    // the source file is split out of blob (the residency signal)
    expect(body.docs[0]!.sourceBytes).toBe(20_000);
    const thin = body.docs.find((d) => d.doc === "thin")!;
    expect(thin.blobBytes).toBeGreaterThanOrEqual(1_000);
    expect(thin.sourceBytes).toBe(0);
    // per-doc totals never exceed the account total
    const sum = body.docs.reduce((a, d) => a + d.totalBytes, 0);
    expect(sum).toBeLessThanOrEqual(body.created.bytes + body.sources.bytes);
    expect(body.created.limit).toBeGreaterThan(0);
    expect(body.sources.bytes).toBe(20_000);
  } finally {
    s.stop();
  }
});
