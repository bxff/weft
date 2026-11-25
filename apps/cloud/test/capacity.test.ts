/**
 * #58 global capacity watermark + per-user quota overrides. The "server never
 * goes poof" invariant: N accounts x quota can exceed any fixed disk, and a
 * runaway storage bug grows the total regardless of whose account it bills —
 * so a GLOBAL check bounds both. Pinned:
 *  - 85% of WEFT_CAPACITY_BYTES: every storage-growing write answers 507
 *    { reason: "capacity" } (distinct from a user's own quota 507) — while
 *    READS of existing data keep working;
 *  - 80%: users with ZERO stored bytes (new accounts) get 503 on their first
 *    storage write; existing users keep writing until 85%;
 *  - 0 / unset = disabled (self-host default);
 *  - per-user per-class quota override (user_quotas) beats the deployment
 *    default in both the guard and /api/usage reporting, settable over HTTP
 *    via the admin endpoint.
 */

import { afterEach, expect, test } from "bun:test";
import { startCloud, type CloudServer } from "../src/server";

let server: CloudServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  delete process.env.WEFT_CAPACITY_BYTES;
  delete process.env.WEFT_QUOTA_CREATED_BYTES;
  delete process.env.WEFT_QUOTA_SOURCES_BYTES;
});

const start = () => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  return `http://localhost:${server.port}`;
};

const h = (user: string) => ({
  authorization: `Bearer dev:${user}`,
  "content-type": "application/octet-stream",
});

/** PUT one page blob (a storage-growing CREATED write) and return the response. */
const putPage = (base: string, user: string, doc: string, bytes: number) =>
  fetch(`${base}/api/documents/${doc}/pages/p1/rm`, {
    method: "PUT",
    headers: h(user),
    body: new Uint8Array(bytes).fill(1),
  });

test("watermark disabled (default): huge totals never trip anything", async () => {
  delete process.env.WEFT_CAPACITY_BYTES;
  const base = start();
  expect((await putPage(base, "u1", "d1", 50_000)).status).toBe(200);
});

test("85%: growing writes 507 with reason=capacity for EVERYONE; reads keep working", async () => {
  process.env.WEFT_CAPACITY_BYTES = "100000"; // 100 KB provisioned
  const base = start();
  // u1 stores ~90 KB -> total >= 85%
  expect((await putPage(base, "u1", "d1", 90_000)).status).toBe(200);

  // u1's next growing write is refused as CAPACITY (not their quota)
  const grow = await putPage(base, "u1", "d2", 10_000);
  expect(grow.status).toBe(507);
  const body = (await grow.json()) as { reason?: string };
  expect(body.reason).toBe("capacity");

  // reads of existing data still work
  const read = await fetch(`${base}/api/documents/d1/pages/p1/rm`, {
    headers: { authorization: "Bearer dev:u1" },
  });
  expect(read.status).toBe(200);
  expect((await read.arrayBuffer()).byteLength).toBe(90_000);
});

test("80%: NEW users (zero stored bytes) get 503; existing users still write until 85%", async () => {
  process.env.WEFT_CAPACITY_BYTES = "100000";
  const base = start();
  // two existing users bring the total to ~82% (between the thresholds)
  expect((await putPage(base, "u1", "d1", 60_000)).status).toBe(200);
  expect((await putPage(base, "u2", "d1", 22_000)).status).toBe(200);

  // a brand-new user's FIRST storage write is refused 503 capacity
  const newcomer = await putPage(base, "u3", "d1", 1_000);
  expect(newcomer.status).toBe(503);
  expect(((await newcomer.json()) as { reason?: string }).reason).toBe(
    "capacity",
  );

  // an EXISTING user still writes fine below 85%
  expect((await putPage(base, "u1", "d2", 1_000)).status).toBe(200);
});

test("per-user quota override beats the deployment default (guard + /api/usage)", async () => {
  process.env.WEFT_QUOTA_CREATED_BYTES = "1000000"; // 1 MB default
  const base = start();
  // cap u1's created class to 10 KB via the override
  server!.store.setUserQuota("u1", "created", 10_000);

  const usage = await fetch(`${base}/api/usage`, {
    headers: { authorization: "Bearer dev:u1" },
  });
  expect(
    ((await usage.json()) as { created: { limit: number } }).created.limit,
  ).toBe(10_000);

  // writes beyond the OVERRIDE are refused as the user's own quota
  const over = await putPage(base, "u1", "d1", 20_000);
  expect(over.status).toBe(507);
  const body = (await over.json()) as {
    reason?: string;
    class?: string;
    limit?: number;
  };
  expect(body.reason).toBe("quota"); // quota, NOT capacity
  expect(body.class).toBe("created");
  expect(body.limit).toBe(10_000);

  // another user still has the 1 MB default
  expect((await putPage(base, "u2", "d1", 20_000)).status).toBe(200);
  // clearing the override restores the default
  server!.store.setUserQuota("u1", "created", null);
  expect((await putPage(base, "u1", "d1", 20_000)).status).toBe(200);
});

test("override 0 = explicitly unlimited for that user", async () => {
  process.env.WEFT_QUOTA_CREATED_BYTES = "10000"; // tiny default
  const base = start();
  server!.store.setUserQuota("vip", "created", 0);
  expect((await putPage(base, "vip", "d1", 50_000)).status).toBe(200);
  // and the tiny default still binds everyone else
  expect((await putPage(base, "other", "d1", 50_000)).status).toBe(507);
});

// ---------- #59 admin stats + the admin quota endpoint ----------

test("GET /api/admin/stats: admins see the numbers; everyone else gets an indistinguishable 404", async () => {
  process.env.WEFT_ADMIN_USERS = "owner, second-admin";
  process.env.WEFT_CAPACITY_BYTES = "1000000";
  try {
    const base = start();
    await putPage(base, "alice", "d1", 30_000);
    await putPage(base, "bob", "d1", 10_000);

    // a non-admin (and a non-user path probe) both see 404
    const alice = await fetch(`${base}/api/admin/stats`, {
      headers: { authorization: "Bearer dev:alice" },
    });
    expect(alice.status).toBe(404);

    const r = await fetch(`${base}/api/admin/stats`, {
      headers: { authorization: "Bearer dev:owner" },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      totalBytes: number;
      userCount: number;
      capacity: { bytes: number; usedFraction: number } | null;
      topUsers: { user: string; bytes: number }[];
      counters: { requests: number; rate429: number; quota507: number };
      uptimeSec: number;
    };
    expect(body.totalBytes).toBeGreaterThanOrEqual(40_000);
    expect(body.userCount).toBeGreaterThanOrEqual(2);
    expect(body.capacity!.bytes).toBe(1_000_000);
    expect(body.topUsers[0]!.user).toBe("alice"); // descending by bytes
    expect(body.counters.requests).toBeGreaterThan(0);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);

    // the comma-separated list admits the second admin too
    const second = await fetch(`${base}/api/admin/stats`, {
      headers: { authorization: "Bearer dev:second-admin" },
    });
    expect(second.status).toBe(200);
  } finally {
    delete process.env.WEFT_ADMIN_USERS;
  }
});

test("admin stats without WEFT_ADMIN_USERS set: the route does not exist for anyone", async () => {
  delete process.env.WEFT_ADMIN_USERS;
  const base = start();
  const r = await fetch(`${base}/api/admin/stats`, {
    headers: { authorization: "Bearer dev:owner" },
  });
  expect(r.status).toBe(404);
});

test("PUT /api/admin/quota sets, reports, and clears a per-class override over HTTP", async () => {
  process.env.WEFT_ADMIN_USERS = "owner";
  process.env.WEFT_QUOTA_SOURCES_BYTES = "50000";
  try {
    const base = start();
    const put = (body: unknown, as = "owner") =>
      fetch(`${base}/api/admin/quota`, {
        method: "PUT",
        headers: {
          authorization: `Bearer dev:${as}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    // non-admin: 404, and nothing is written
    expect(
      (await put({ userId: "u1", class: "sources", bytes: 1 }, "u1")).status,
    ).toBe(404);
    expect(server!.store.userQuotaOverride("u1", "sources")).toBe(null);

    // set: the override binds the guard immediately
    const set = await put({ userId: "u1", class: "sources", bytes: 10_000 });
    expect(set.status).toBe(200);
    expect(
      (await set.json()) as { limit: number; overridden: boolean },
    ).toMatchObject({ limit: 10_000, overridden: true });
    const over = await fetch(`${base}/api/documents/d1/file`, {
      method: "PUT",
      headers: h("u1"),
      body: new Uint8Array(20_000),
    });
    expect(over.status).toBe(507);
    expect(((await over.json()) as { class: string }).class).toBe("sources");

    // clear: back to the deployment default
    const clear = await put({ userId: "u1", class: "sources", bytes: null });
    expect(
      (await clear.json()) as { limit: number; overridden: boolean },
    ).toMatchObject({ limit: 50_000, overridden: false });

    // validation
    expect((await put({ userId: "u1", class: "bogus", bytes: 1 })).status).toBe(
      400,
    );
    expect(
      (await put({ userId: "u1", class: "sources", bytes: -5 })).status,
    ).toBe(400);
    expect((await put({ class: "sources", bytes: 1 })).status).toBe(400);
  } finally {
    delete process.env.WEFT_ADMIN_USERS;
  }
});
