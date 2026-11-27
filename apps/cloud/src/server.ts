/**
 * Weft cloud: hosted store speaking the same device-protocol API as rmsyncd,
 * so the web app is transport-agnostic (point HttpTransport at this origin).
 * Run: CLERK_SECRET_KEY=... bun src/server.ts [--port 8080] [--db path.db]
 * Dev: CLOUD_DEV_USER=1 accepts `Bearer dev:<user>`.
 */

import {
  BelowFloorError,
  CloudStore,
  type StorageClass,
  type StoredFailureReport,
} from "./store";
import {
  authenticate,
  selfHostEnabled,
  jwtSigningSecret,
  signSelfHostToken,
} from "./auth";
import { encodeSnapshot } from "@weft/sync-engine";
import { parseRecoveryImport, type RecoveryImport } from "./recovery-import";
import { builtinTemplate, builtinTemplateList } from "./builtin-templates";
import { installProcessHooks, reportError } from "./telemetry";
import { RmDocument, RootTextAuthorConflict } from "@weft/rm-format";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createBrotliCompress, createGzip, constants as zlib } from "node:zlib";
import Negotiator from "negotiator";
import type { ServerWebSocket } from "bun";

/** Per-connection WebSocket state: user plus whichever long-lived credential
 *  (if any) authenticated the socket, so a revoke can find and close it and
 *  its last_used stays fresh. Browser (session/ticket) sockets carry neither. */
type WSData = {
  userId: string;
  deviceToken: string | null;
  apiKey: string | null;
};

/**
 * Whitelist and clamp a client-supplied failure report: coerce/bound every
 * field so a hostile client can't store note content or unbounded blobs.
 * Returns null on non-object input.
 */
function sanitizeFailureReport(input: unknown): StoredFailureReport | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const str = (v: unknown, max: number, dflt = "") =>
    (typeof v === "string" ? v : dflt).slice(0, max);
  const kinds = ["engine", "codec", "reconcile", "guardrail"];
  const kind =
    typeof o.kind === "string" && kinds.includes(o.kind) ? o.kind : "engine";
  const source = o.source === "daemon" ? "daemon" : "web";
  let context: string | null = null;
  if (o.context && typeof o.context === "object") {
    // keep only primitive values; bound the serialized size
    const flat: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(o.context as Record<string, unknown>)) {
      if (typeof v === "string") flat[k.slice(0, 40)] = v.slice(0, 200);
      else if (typeof v === "number" || typeof v === "boolean")
        flat[k.slice(0, 40)] = v;
    }
    context = JSON.stringify(flat).slice(0, 2000);
  }
  return {
    id: str(o.id, 100) || crypto.randomUUID(),
    kind,
    tag: str(o.tag, 100, "Unknown"),
    message: str(o.message, 500),
    appVersion: str(o.appVersion, 50, "unknown"),
    source,
    docHash: o.docHash ? str(o.docHash, 128) : null,
    pageHash: o.pageHash ? str(o.pageHash, 128) : null,
    context,
    occurredAt:
      typeof o.occurredAt === "number" && isFinite(o.occurredAt)
        ? o.occurredAt
        : Date.now(),
  };
}

const args = process.argv.slice(2);
const argOf = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** RFC 7232 quoted-string ETag from a bare content hash. Quoted on both emit
 *  and compare so a proxy/CDN normalizing the header can't break If-None-Match. */
const quoteEtag = (hash: string) => `"${hash}"`;

/** Non-negative integer env var, falling back on unset/NaN/negative input
 *  (so a malformed WEFT_* value can't, e.g., busy-loop the backup timer). */
const envInt = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

export interface CloudServer {
  port: number;
  /** Backing store, exposed so tests can drive compaction/retention against
   *  the same store the routes read. */
  store: CloudStore;
  stop(): void;
}

// Page routes capture the document and page in their first two groups.
function pageParams(match: RegExpExecArray) {
  const [, doc, page] = match;
  if (!doc || !page) throw new Error("Page route is missing a document or page capture");
  return { doc, page };
}

/**
 * Parse a single `Range: bytes=a-b` request (the only form pdf.js sends) into
 * an inclusive [start, end] clamped to `total`. Returns null when absent or
 * unsatisfiable (caller answers 416). Supports open (`a-`) and suffix (`-N`).
 */
function parseByteRange(
  header: string | null,
  total: number,
): [number, number] | null {
  if (!header) return null;
  const spec = header.startsWith("bytes=") ? header.slice(6) : null;
  if (!spec || spec.includes(",")) return null;
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();
  if (total <= 0) return null;
  if (startStr === "") {
    // suffix: last N bytes
    const n = Number(endStr);
    if (!Number.isInteger(n) || n <= 0) return null;
    return [Math.max(0, total - n), total - 1];
  }
  const start = Number(startStr);
  if (!Number.isInteger(start) || start < 0 || start >= total) return null;
  const end = endStr === "" ? total - 1 : Math.min(Number(endStr), total - 1);
  if (!Number.isInteger(end) || end < start) return null;
  return [start, end];
}

function acceptedEncodings(req: Request, available?: string[], preferred?: string[]): string[] {
  const negotiator = new Negotiator({
    headers: { "accept-encoding": (req.headers.get("accept-encoding") ?? "").toLowerCase() },
  });
  // The installed Negotiator supports preferred; its type declarations omit it.
  // @ts-expect-error Negotiator's second encodings argument is missing in @types/negotiator.
  return negotiator.encodings(available, { preferred });
}

// These are the client-rendered routes and the paths for the two server-built
// shells. Keep request classification in sync with the Vercel routing rules.
const clientPage = /^\/(?:install|join|library|login|settings(?:\/keys)?)\/?$/;
const notebookPage = /^\/app\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/?$/;
const prerenderedPage = /^\/(?:docs(?:\/[a-zA-Z0-9_-]+)*|privacy|terms)\/?$/;
const acceptsHtml = /^(?:[^,]*,)*\s*text\/html\s*(?=[;,]|$)(?![^,]*;\s*q\s*=\s*0(?:\.0*)?\s*(?:[;,]|$))[^,]*(?:,.*)?$/i;

async function serveStatic(dir: string, pathname: string, req: Request): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return new Response("bad path", { status: 400 });
  let path = dir + rel;
  let file = Bun.file(path);
  const headers: Record<string, string> = { vary: "Accept-Encoding" };
  if (!(await file.exists())) {
    try { decodeURIComponent(rel); }
    catch { return new Response("bad path", { status: 400 }); }
    headers.vary += ", Accept, Sec-Fetch-Dest";
    headers["cache-control"] = "no-store";
    const destination = req.headers.get("sec-fetch-dest");
    if (
      !acceptsHtml.test(req.headers.get("accept") ?? "") ||
      (destination !== null && !["document", "iframe", "frame"].includes(destination))
    ) return new Response(null, { status: 404, headers });

    if (notebookPage.test(rel)) {
      const shell = dir + "/app/shell/shell.html";
      // A self-hosted relay may still be serving a previous web build.
      path = await Bun.file(shell).exists() ? shell : dir + "/index.html";
    } else if (clientPage.test(rel)) {
      path = dir + "/index.html";
    } else if (prerenderedPage.test(rel)) {
      path = dir + rel.replace(/\/$/, "") + ".html";
    } else {
      return new Response(null, { status: 404, headers });
    }
    file = Bun.file(path);
    if (!(await file.exists())) return new Response(null, { status: 404, headers });
  }

  headers["content-type"] = file.type;
  const encodings = acceptedEncodings(req, ["br", "gzip", "identity"]);
  if (encodings[0] === "gzip" && encodings[1] === "br") {
    const offered = acceptedEncodings(req);
    // Break an explicit tie without moving either coding past identity.
    if (offered.includes("gzip") && offered.includes("br") &&
      acceptedEncodings(req, ["br", "gzip"], ["br", "gzip"])[0] === "br") {
      encodings[0] = "br";
      encodings[1] = "gzip";
    }
  }
  for (const encoding of encodings) {
    if (encoding === "identity") return new Response(file, { headers });
    const encoded = Bun.file(path + (encoding === "br" ? ".br" : ".gz"));
    if (await encoded.exists()) {
      return new Response(encoded, { headers: { ...headers, "content-encoding": encoding } });
    }
  }
  return new Response(null, { status: 406, headers });
}

export function startCloud(
  opts: { port?: number; db?: string; staticDir?: string } = {},
): CloudServer {
  const staticDir = opts.staticDir;
  // One auth mode only: self-host (WEFT_PASSWORD) or hosted (CLERK_SECRET_KEY),
  // never both, else the self-host branch silently shadows Clerk.
  if (process.env.WEFT_PASSWORD && process.env.CLERK_SECRET_KEY) {
    throw new Error(
      "Set only one of WEFT_PASSWORD (self-host) or CLERK_SECRET_KEY (hosted), not both.",
    );
  }
  const store = new CloudStore(opts.db ?? ":memory:");
  // Drop pairing tokens unused for 30+ days (also pruned on device-list fetch)
  // so a leaked token can't live forever.
  store.pruneStaleDeviceTokens();

  // Opt-in periodic backups: WEFT_BACKUP_DIR enables a VACUUM-INTO DB snapshot
  // plus blob-tree copy every WEFT_BACKUP_INTERVAL_MIN (60), keeping
  // WEFT_BACKUP_KEEP (24). In-memory DBs are skipped.
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  const backupDir = process.env.WEFT_BACKUP_DIR;
  if (backupDir && (opts.db ?? ":memory:") !== ":memory:") {
    const intervalMin = envInt("WEFT_BACKUP_INTERVAL_MIN", 60);
    const keep = envInt("WEFT_BACKUP_KEEP", 24);
    const run = () => {
      try {
        store.backup(backupDir);
        store.pruneBackups(backupDir, keep);
      } catch (e) {
        console.error("weft-cloud: backup failed:", e);
      }
    };
    run(); // one at boot
    backupTimer = setInterval(run, Math.max(1, intervalMin) * 60_000);
    backupTimer.unref?.(); // never keep the process alive just for backups
  }

  // Change-feed retention: the `changes` table only drives daemon cursors, and
  // the revision sweep heals any cursor behind the window, so rows older than
  // WEFT_CHANGES_RETENTION_DAYS (30; 0 = keep-all) drop at boot and daily.
  // Otherwise the table grows forever (one row per edit per page).

  const changesRetentionDays = envInt("WEFT_CHANGES_RETENTION_DAYS", 30);
  let changesPruneTimer: ReturnType<typeof setInterval> | null = null;
  if (changesRetentionDays > 0) {
    const pruneChanges = () => {
      try {
        const n = store.pruneChanges(changesRetentionDays * 24 * 60 * 60_000);
        if (n > 0) console.log(`weft-cloud: pruned ${n} old change rows`);
      } catch (e) {
        console.error("weft-cloud: change prune failed:", e);
      }
    };
    pruneChanges();
    changesPruneTimer = setInterval(pruneChanges, 24 * 60 * 60_000);
    changesPruneTimer.unref?.();
  }
  // Per-user event fanout. Sockets hold their auth identity in `.data` so a
  // revoked credential's live connection can be found and closed.
  const sockets = new Map<string, Set<ServerWebSocket<WSData>>>();
  // Per-connection timers that keep a credential's last_used_at fresh and
  // re-validate it while its WS is open (clients authenticate once at connect).
  // Cleared on close.
  const wsTimers = new Map<object, ReturnType<typeof setInterval>>();
  // Single-use, short-lived WebSocket auth tickets: browsers can't set headers
  // on a WS upgrade, so rather than put the session JWT in ?token= (recoverable
  // from proxy/CDN logs), the browser POSTs /api/ws-ticket for an opaque nonce
  // and connects with ?ticket=. Nonces are consumed on use and expire fast.
  const wsTickets = new Map<string, { userId: string; expires: number }>();
  const WS_TICKET_TTL_MS = 30_000;
  // userId -> device -> last time that device's sync loop fetched exclusions.
  // In-memory: a restart reads as "no heartbeat yet" (web treats as unknown,
  // not offline).
  const syncHeartbeats = new Map<string, Map<string, number>>();

  /** Stable per-device identity for doc manifests: sha256 of the device token
   *  (never stored raw). Null when the header is absent. */
  const deviceKeyOf = (req: Request): string | null => {
    const t = req.headers.get("x-device-token");
    if (!t) return null;
    const h = new Bun.CryptoHasher("sha256");
    h.update(t);
    return h.digest("hex");
  };

  const emit = (userId: string, event: object) => {
    const set = sockets.get(userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const ws of set) ws.send(data);
  };

  // Close every live socket of `userId` whose auth identity matches `pred`:
  // drops a revoked device token / API key's stream now, not on the next tick.
  const closeSockets = (userId: string, pred: (d: WSData) => boolean) => {
    const set = sockets.get(userId);
    if (!set) return;
    for (const ws of [...set]) if (pred(ws.data)) ws.close();
  };

  // The API key on a request, mirroring authenticate(): x-api-key header or a
  // `Bearer chk_...`. Tags an api-key WS so revoke can find it.
  const apiKeyOf = (req: Request): string | null => {
    const headerKey = req.headers.get("x-api-key");
    if (headerKey) return headerKey;
    const authz = req.headers.get("authorization");
    const bearer = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
    return bearer?.startsWith("chk_") ? bearer : null;
  };

  const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...CORS, ...headers },
    });

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization, content-type, x-base-revision, x-client-id, x-device-token, x-api-key, range, if-none-match, x-if-snapshot-seq-gt, x-weft-recovery, x-weft-native-sha256",
    "access-control-allow-methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
    // headers pdf.js + client caches read cross-origin (Range, revalidation etags)
    "access-control-expose-headers":
      "x-rm-revision, content-range, accept-ranges, content-length, x-snapshot-seq, x-snapshot-op-seq, x-snapshot-revert, x-snapshot-complete, etag",
  };

  // Body caps (DoS guard). Assets keep their own 20MB cap below. Rejected early
  // on Content-Length, then re-checked on the materialized body (the header is
  // advisory: absent or lying on chunked uploads).
  const MAX_RM = 32 * 1024 * 1024;
  const MAX_RECOVERY_JSON = 16 * 1024 * 1024;
  const MAX_JSON = 16 * 1024 * 1024;

  // Per-user storage quotas, one per data class. Enforced as
  // usage + incoming > limit (conservative: an in-place overwrite near the
  // limit may be refused, so keep limits generous vs a single write).
  //  - created (pages/ops/snapshots/overlays/assets/thumbnails/templates): the
  //    user's own irreplaceable output. Default 1 GiB.
  //  - sources (PDF/EPUB): replaceable, the tablet holds the original. Default
  //    3 GiB; over-quota goes tablet-only-coldest-first, not an error (a steady
  //    state for sources).
  // 0 = unlimited (self-host convention). Per-user overrides (PUT
  // /api/admin/quota) take precedence over these defaults.
  const QUOTA_DEFAULTS: Record<StorageClass, number> = {
    created: envInt("WEFT_QUOTA_CREATED_BYTES", 1024 * 1024 * 1024),
    sources: envInt("WEFT_QUOTA_SOURCES_BYTES", 3 * 1024 * 1024 * 1024),
  };

  // Global capacity watermark. WEFT_CAPACITY_BYTES = storage provisioned for
  // user data on this box (0 = disabled, self-host default). Thresholds on the
  // total across all users:
  //  - 80%: stop admitting new users (a zero-byte user gets 503 on first write;
  //    existing users unaffected);
  //  - 85%: refuse all storage-growing writes with 507 (reads/deletes/
  //    non-growing sync keep working; nothing existing is lost).
  // Deliberately not per-user: N accounts x quota can exceed a fixed disk, and
  // a runaway storage bug grows the total regardless of account. The watermark
  // bounds both.
  const CAPACITY_BYTES = envInt("WEFT_CAPACITY_BYTES", 0);

  // WEFT_ADMIN_USERS = comma-separated user ids; /api/admin/* answers only for
  // those users (404 for everyone else, indistinguishable from a missing
  // route). Unset/empty = the endpoints don't exist.
  const ADMIN_USERS = new Set(
    (process.env.WEFT_ADMIN_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const isAdmin = (uid: string) => ADMIN_USERS.has(uid);
  const bootedAt = Date.now();
  // since-boot counters (in-memory, single-node)
  const counters = { requests: 0, rate429: 0, quota507: 0, capacity: 0 };

  // Token-bucket rate limiting, in-memory (single-node). Two buckets:
  //  - per authenticated user on every /api route (defaults far above real
  //    client behavior but stop sustained hammering);
  //  - per IP on /api/login (brute-forcing the self-host password).
  // 429 + Retry-After when exhausted. Lazy sweep bounds the map.
  const RATE_RPS = envInt("WEFT_RATE_RPS", 100);
  const RATE_BURST = envInt("WEFT_RATE_BURST", 500);
  const LOGIN_RATE_RPS = 0.5; // sustained: 1 attempt / 2s
  const LOGIN_RATE_BURST = envInt("WEFT_LOGIN_RATE_BURST", 10);
  /** Max ops per POST /ops batch: bounds per-request DB work independently of
   *  the byte cap. */
  const MAX_OPS_PER_POST = envInt("WEFT_MAX_OPS_PER_POST", 1000);
  /** Per-user cap on concurrently open WebSockets (tabs + daemon are ~5). */
  const MAX_WS_PER_USER = envInt("WEFT_MAX_WS_PER_USER", 32);
  interface Bucket {
    tokens: number;
    last: number;
  }
  const buckets = new Map<string, Bucket>();
  /** Consume one token from `key`'s bucket; null = allowed, else retry-after ms. */
  const rateLimited = (
    key: string,
    rps: number,
    burst: number,
  ): number | null => {
    if (rps <= 0) return null; // disabled
    const now = Date.now();
    if (buckets.size > 50_000) {
      // lazy sweep: drop fully-refilled (idle) buckets
      for (const [k, b] of buckets) {
        if (now - b.last > (burst / rps) * 1000) buckets.delete(k);
      }
    }
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: burst, last: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * rps);
    b.last = now;
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / rps) * 1000);
    b.tokens -= 1;
    return null;
  };
  const rateError = (retryMs: number) => {
    counters.rate429++;
    return new Response(
      JSON.stringify({ error: "rate limited", retryAfterMs: retryMs }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(Math.ceil(retryMs / 1000)),
          ...CORS,
        },
      },
    );
  };
  // A small overshoot is possible if two writes race the check (TOCTOU);
  // bounded by the per-route body caps.
  const quotaFor = (uid: string, cls: StorageClass) =>
    store.userQuotaOverride(uid, cls) ?? QUOTA_DEFAULTS[cls];
  const overQuota = (uid: string, cls: StorageClass, incoming: number) => {
    const limit = quotaFor(uid, cls);
    return limit > 0 && store.usageBytes(uid, cls) + incoming > limit;
  };
  /** Class-tagged 507. The daemon reads `class`: sources = stop pushing sources
   *  this tick (tablet-only, not an error); created should never fire in real use. */
  const quotaError = (uid: string, cls: StorageClass, usage = store.usageBytes(uid, cls)) => {
    counters.quota507++;
    return json(
      {
        error: "storage quota exceeded",
        reason: "quota",
        class: cls,
        usage,
        limit: quotaFor(uid, cls),
      },
      507,
    );
  };
  /** Watermark check for a storage-growing write; null = allowed. Runs before
   *  the per-user quota so a capacity refusal reports reason:"capacity", never
   *  misread as the user's own quota. */
  const atCapacity = (uid: string): Response | null => {
    if (CAPACITY_BYTES <= 0) return null;
    const total = store.totalUsageBytes();
    if (total >= CAPACITY_BYTES * 0.85) {
      counters.capacity++;
      return json(
        {
          error:
            "service is at capacity — new uploads are paused while we add storage; existing notes remain readable and synced",
          reason: "capacity",
        },
        507,
      );
    }
    if (total >= CAPACITY_BYTES * 0.8 && store.usageTotal(uid) === 0) {
      counters.capacity++;
      return json(
        {
          error:
            "the beta is at capacity for new accounts — please try again later",
          reason: "capacity",
        },
        503,
      );
    }
    return null;
  };
  /** Guards for every storage-growing write, in order: selective-sync
   *  exclusion (server-side backstop so a stale daemon can't leak an excluded
   *  doc), watermark, then the per-user quota of the write's class (files =
   *  sources, else created). */
  const uploadGuard = (uid: string, doc?: string): Response | null => {
    if (doc && store.isDocExcluded(uid, doc)) {
      return json(
        { error: "this document is excluded from sync", reason: "excluded" },
        403,
      );
    }
    return atCapacity(uid);
  };
  const storageGuard = (
    uid: string,
    incoming: number,
    doc?: string,
    cls: StorageClass = "created",
  ): Response | null =>
    uploadGuard(uid, doc) ??
    (overQuota(uid, cls, incoming) ? quotaError(uid, cls) : null);
  const overHeader = (req: Request, cap: number) =>
    Number(req.headers.get("content-length") ?? 0) > cap;

  // Streamed body read with an optional per-chunk callback: a big source push
  // is one request lasting minutes, so the callback keeps the device heartbeat
  // fresh mid-upload (an arrival-only heartbeat went stale during the upload).
  const readBytes = async (
    req: Request,
    cap: number,
    onChunk?: () => void,
  ): Promise<{ bytes: Uint8Array } | { error: Response }> => {
    if (overHeader(req, cap))
      return { error: json({ error: "too large" }, 413) };
    if (!req.body) {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > cap)
        return { error: json({ error: "too large" }, 413) };
      return { bytes };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > cap) {
        try {
          await reader.cancel();
        } catch {
          // already errored/closed: the 413 below answers either way
        }
        return { error: json({ error: "too large" }, 413) };
      }
      chunks.push(value);
      onChunk?.();
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      bytes.set(c, o);
      o += c.length;
    }
    return { bytes };
  };

  // Read a JSON body under `cap` and validate it parses (the cloud must not
  // store garbage the device would reject).
  const readJson = async (
    req: Request,
    cap: number,
    onChunk?: () => void,
  ): Promise<{ text: string } | { error: Response }> => {
    const body = await readBytes(req, cap, onChunk);
    if ("error" in body) return body;
    const text = new TextDecoder().decode(body.bytes);
    try {
      JSON.parse(text);
    } catch {
      return { error: json({ error: "invalid json" }, 400) };
    }
    return { text };
  };

  const server = Bun.serve<WSData>({
    port: opts.port ?? 8080,
    // Bind host. Set HOST=127.0.0.1 when a tunnel/proxy is the only public path
    // so the plaintext port never faces the internet. Default 0.0.0.0.
    ...(process.env.HOST ? { hostname: process.env.HOST } : {}),
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });
      if (path === "/api/health") {
        // Advertise the login mode so the web app shows the right door:
        // 'password' = self-host (shared password), else Clerk/hosted.
        const authMode = selfHostEnabled() ? "password" : "clerk";
        return json({
          daemon: "weft-cloud",
          version: "0.1.0",
          firmware: "",
          model: "cloud",
          authMode,
        });
      }


      // Self-host login: exchange the shared password for a session JWT.
      // Only enabled when WEFT_PASSWORD is set (i.e. self-host mode).
      if (path === "/api/login" && req.method === "POST") {
        if (!selfHostEnabled())
          return json({ error: "password login is disabled" }, 404);
        // brute-force guard: per-IP bucket (the shared password is the whole
        // self-host auth surface; 10 tries then 1 per 2s).
        const ip = srv.requestIP(req)?.address ?? "unknown";
        const loginRetry = rateLimited(
          `login:${ip}`,
          LOGIN_RATE_RPS,
          LOGIN_RATE_BURST,
        );
        if (loginRetry !== null) return rateError(loginRetry);
        const body = (await req.json().catch(() => ({}))) as {
          password?: string;
        };
        const expected = process.env.WEFT_PASSWORD ?? "";
        const given = typeof body.password === "string" ? body.password : "";
        // constant-time-ish compare
        let diff = given.length ^ expected.length;
        for (let i = 0; i < given.length; i++)
          diff |= given.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
        if (diff !== 0) return json({ error: "invalid password" }, 401);
        // sign with the dedicated JWT secret, never the password
        return json({
          token: await signSelfHostToken(jwtSigningSecret(store)),
        });
      }

      // Invite-link sign-up (private beta). One shareable link
      // (weft.page/join#<code>) lets friends in while the public waitlist
      // stays on: the join page POSTs {code, email} here, we mint a
      // single-use Clerk invitation (notify:false — the visitor is redirected
      // immediately, no email that could land in spam) and return the
      // ticketed portal sign-up URL. WEFT_INVITE_CODE unset = endpoint off.
      // Rotating the code kills the old link. Per-IP rate limited like login
      // (the code is guessable in principle; the bucket makes it not).
      if (path === "/api/invite" && req.method === "POST") {
        const inviteCode = process.env.WEFT_INVITE_CODE ?? "";
        const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
        const appUrl = process.env.WEFT_APP_URL;
        const portalUrl = process.env.WEFT_ACCOUNTS_URL;
        if (!inviteCode || !clerkKey || !appUrl || !portalUrl)
          return json({ error: "invites are disabled" }, 404);
        const ip = srv.requestIP(req)?.address ?? "unknown";
        const retry = rateLimited(
          `invite:${ip}`,
          LOGIN_RATE_RPS,
          LOGIN_RATE_BURST,
        );
        if (retry !== null) return rateError(retry);
        const body = (await req.json().catch(() => ({}))) as {
          code?: string;
          email?: string;
        };
        if ((body.code ?? "") !== inviteCode)
          return json({ error: "invalid invite code" }, 401);
        const email = typeof body.email === "string" ? body.email.trim() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          return json({ error: "enter a valid email address" }, 400);
        // Existing account? Point them at sign-in instead of minting a new
        // invitation — Clerk happily invites already-registered emails, and
        // the stray invitation then sits "pending" in the dashboard forever
        // (first outside user re-ran /join while his initial sync looked
        // stuck, 2026-07-08).
        const existing = await fetch(
          `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}&limit=1`,
          { headers: { authorization: `Bearer ${clerkKey}` } },
        );
        const existingUsers = (await existing.json().catch(() => [])) as unknown[];
        if (existing.ok && Array.isArray(existingUsers) && existingUsers.length > 0) {
          return json(
            { error: "this email already has an account. Sign in instead." },
            409,
          );
        }
        const r = await fetch("https://api.clerk.com/v1/invitations", {
          method: "POST",
          headers: {
            authorization: `Bearer ${clerkKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email_address: email,
            redirect_url: appUrl,
            notify: false,
          }),
        });
        const inv = (await r.json().catch(() => null)) as {
          url?: string;
          errors?: { code?: string; message?: string }[];
        } | null;
        if (!r.ok || !inv?.url) {
          const errCode = inv?.errors?.[0]?.code ?? "";
          if (
            errCode === "duplicate_record" ||
            errCode === "form_identifier_exists"
          )
            return json(
              {
                error:
                  "this email already has access or a pending invite. Try signing in.",
              },
              409,
            );
          return json({ error: inv?.errors?.[0]?.message ?? "invite failed" }, 502);
        }
        const ticket = new URL(inv.url).searchParams.get("ticket") ?? "";
        return json({
          url: `${portalUrl}/sign-up?__clerk_ticket=${encodeURIComponent(ticket)}`,
        });
      }

      // Static SPA (single-origin / e2e): anything not under /api or /ws,
      // served without auth (the app gates itself client-side).
      if (
        staticDir &&
        (req.method === "GET" || req.method === "HEAD") &&
        path !== "/api" &&
        !path.startsWith("/api/") &&
        path !== "/ws"
      ) {
        return serveStatic(staticDir, path, req);
      }

      let auth = await authenticate(req, store);
      // #70: a browser WS connects with a single-use ?ticket= instead of the
      // session JWT in the URL. Resolve it here (authenticate() only knows
      // headers/JWTs). Consume the nonce unconditionally — even an expired one
      // is spent, so a leaked ticket is never reusable.
      if (!auth && path === "/ws") {
        const ticket = url.searchParams.get("ticket");
        if (ticket) {
          const t = wsTickets.get(ticket);
          wsTickets.delete(ticket);
          if (t && t.expires > Date.now()) {
            auth = { userId: t.userId, via: "ticket" };
          }
        }
      }
      if (!auth) return json({ error: "unauthorized" }, 401);
      const user = auth.userId;
      // Tablet SYNC-LOOP heartbeat (per device — one live tablet must not
      // mask a dead sibling). Touched on EVERY device-authed request, not
      // just the 15s exclusions tick: during a big initial push the loop is
      // heads-down PUTting pages for minutes and never hits the tick, and
      // the old tick-only heartbeat showed "tablet offline" precisely while
      // the tablet worked hardest (first outside user, 2026-07-08). Stall
      // detection is preserved: only the sync loop makes HTTP requests, so
      // a stalled loop (the 53-min WS-alive-but-dead incident) still goes
      // stale — WS liveness never touches this.
      let touchDevice: (() => void) | undefined;
      if (auth.via === "device") {
        const k = deviceKeyOf(req);
        if (k) {
          let m = syncHeartbeats.get(user);
          if (!m) syncHeartbeats.set(user, (m = new Map()));
          m.set(k, Date.now());
          // handed to streamed body reads: a minutes-long upload keeps the
          // heartbeat fresh per chunk, not just at request arrival
          touchDevice = () => m.set(k, Date.now());
        }
      }

      // per-user rate limit on every authenticated /api route (free service —
      // stop sustained hammering; defaults never touch real client behavior).
      counters.requests++;
      const retryMs = rateLimited(`u:${user}`, RATE_RPS, RATE_BURST);
      if (retryMs !== null) return rateError(retryMs);

      // Admin quota control (STORAGE-PLAN §1): set/clear one user's per-class
      // override without ssh+sqlite. Body: { userId, class, bytes } — bytes
      // null clears back to the deployment default, 0 = unlimited. Same
      // gating as stats: non-admins see a 404 identical to a missing route.
      if (path === "/api/admin/quota" && req.method === "PUT") {
        if (!isAdmin(user)) return json({ error: "not found" }, 404);
        const body = (await req.json().catch(() => ({}))) as {
          userId?: unknown;
          class?: unknown;
          bytes?: unknown;
        };
        const target = typeof body.userId === "string" ? body.userId : "";
        const cls = body.class;
        if (!target || (cls !== "created" && cls !== "sources")) {
          return json(
            { error: "userId and class ('created' | 'sources') required" },
            400,
          );
        }
        let bytes: number | null;
        if (body.bytes === null || body.bytes === undefined) bytes = null;
        else if (
          typeof body.bytes === "number" &&
          Number.isInteger(body.bytes) &&
          body.bytes >= 0
        )
          bytes = body.bytes;
        else return json({ error: "bytes must be a non-negative integer or null" }, 400);
        store.setUserQuota(target, cls, bytes);
        return json({
          userId: target,
          class: cls,
          limit: quotaFor(target, cls),
          overridden: store.userQuotaOverride(target, cls) !== null,
        });
      }

      // #59: owner-only ops stats. Requires WEFT_ADMIN_USERS to include the
      // caller — everyone else sees a 404 identical to a route that doesn't
      // exist.
      if (path === "/api/admin/stats" && req.method === "GET") {
        if (!isAdmin(user)) {
          return json({ error: "not found" }, 404);
        }
        const total = store.totalUsageBytes();
        const users = store.usageAllUsers();
        return json({
          uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
          totalBytes: total,
          userCount: users.length,
          capacity:
            CAPACITY_BYTES > 0
              ? {
                  bytes: CAPACITY_BYTES,
                  usedFraction: total / CAPACITY_BYTES,
                  newUserStopFraction: 0.8,
                  writeStopFraction: 0.85,
                }
              : null,
          topUsers: users.slice(0, 20),
          counters,
        });
      }

      // #70: mint a single-use WS auth ticket. Any authenticated caller can mint
      // one for THEMSELVES; the browser uses it to open /ws?ticket= without ever
      // putting its session JWT in a URL. Lazy-sweep expired nonces on mint.
      if (path === "/api/ws-ticket" && req.method === "POST") {
        if (wsTickets.size > 10_000) {
          const now = Date.now();
          for (const [k, v] of wsTickets) if (v.expires <= now) wsTickets.delete(k);
        }
        const ticket = crypto.randomUUID();
        wsTickets.set(ticket, {
          userId: user,
          expires: Date.now() + WS_TICKET_TTL_MS,
        });
        return json({ ticket });
      }

      if (path === "/ws") {
        // Tag the socket with whichever long-lived credential authenticated it
        // (if any) so its last_used stays fresh while held open (#52/#66) and a
        // revoke can find + close it (#65). Browser (session/ticket) sockets
        // carry neither.
        const deviceToken =
          auth.via === "device" ? req.headers.get("x-device-token") : null;
        const apiKey = auth.via === "apikey" ? apiKeyOf(req) : null;
        if (srv.upgrade(req, { data: { userId: user, deviceToken, apiKey } }))
          return undefined as never;
        return new Response("upgrade failed", { status: 400 });
      }

      // pairing: browser (Clerk/session) mints a token the tablet daemon uses.
      // Minting a device credential requires a SESSION login — an api-key or
      // device-token caller must NOT mint (durable, revocation-proof) device
      // tokens. Same containment as /api/keys and /api/devices; without this an
      // api key silently upgrades to a device token that outlives its revocation.
      if (path === "/api/pair" && req.method === "POST") {
        if (auth.via === "apikey" || auth.via === "device") {
          return json({ error: "pairing requires sign-in" }, 403);
        }
        const body = (await req.json().catch(() => ({}))) as { label?: string };
        const token = store.mintDeviceToken(user, body.label ?? "tablet");
        return json({ token });
      }

      // API keys: third-party clients act on THIS user's notes. Key
      // management requires a session/SSO login — an API key cannot
      // mint or list keys (containment).
      if (path === "/api/keys") {
        if (auth.via === "apikey" || auth.via === "device") {
          return json({ error: "key management requires sign-in" }, 403);
        }
        if (req.method === "GET")
          return json({ keys: store.listApiKeys(user) });
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            label?: string;
          };
          const { id, key } = store.mintApiKey(user, body.label ?? "api key");
          // the secret is returned ONCE, on creation
          return json({ id, key });
        }
      }
      const keyMatch = /^\/api\/keys\/([A-Za-z0-9-]+)$/.exec(path);
      if (keyMatch && req.method === "DELETE") {
        if (auth.via === "apikey" || auth.via === "device") {
          return json({ error: "key management requires sign-in" }, 403);
        }
        const revoked = store.revokeApiKey(user, keyMatch[1]!);
        // #65: drop any live event-stream socket still holding this key NOW,
        // not just on its next re-validation tick.
        if (revoked) closeSockets(user, (d) => d.apiKey === revoked);
        return json({ ok: revoked !== null }, revoked !== null ? 200 : 404);
      }

      // Paired devices (tablet pairing tokens): list + revoke. Like key
      // management, this requires a session — a device/api-key caller
      // cannot enumerate or revoke devices (containment). Lets a user
      // kill a lost or leaked pairing token and see when it was last used.
      if (path === "/api/devices") {
        if (auth.via === "apikey" || auth.via === "device") {
          return json({ error: "device management requires sign-in" }, 403);
        }
        if (req.method === "GET") {
          store.pruneStaleDeviceTokens();
          return json({ devices: store.listDeviceTokens(user) });
        }
      }
      const deviceMatch = /^\/api\/devices\/([A-Za-z0-9-]+)$/.exec(path);
      if (deviceMatch && req.method === "DELETE") {
        if (auth.via === "apikey" || auth.via === "device") {
          return json({ error: "device management requires sign-in" }, 403);
        }
        const revoked = store.revokeDeviceToken(user, deviceMatch[1]!);
        // #65: drop the tablet's live event-stream socket NOW on revoke.
        if (revoked) {
          closeSockets(user, (d) => d.deviceToken === revoked);
          // an unpaired device must not pin state forever: its doc manifest
          // (deletion authority), excluded-present rows (ghost-exclusion
          // pruning) and heartbeat all die with the token
          const h = new Bun.CryptoHasher("sha256");
          h.update(revoked);
          const key = h.digest("hex");
          store.dropDeviceState(user, key);
          syncHeartbeats.get(user)?.delete(key);
        }
        return json({ ok: revoked !== null }, revoked !== null ? 200 : 404);
      }

      // opt-in failure reports (telemetry). Bound to the caller's user,
      // so per-user isolation holds: one user can never read another's.
      if (path === "/api/telemetry/failures") {
        if (req.method === "POST") {
          const body = await readJson(req, 256 * 1024);
          if ("error" in body) return body.error;
          const report = sanitizeFailureReport(JSON.parse(body.text));
          if (!report) return json({ error: "bad report" }, 400);
          store.putFailureReport(user, report);
          return json({ ok: true });
        }
        if (req.method === "GET")
          return json({ reports: store.listFailureReports(user) });
        if (req.method === "DELETE")
          return json({ cleared: store.clearFailureReports(user) });
      }

      if (path === "/api/documents" && req.method === "GET") {
        // The DAEMON (device) needs the full authoritative tree (it manages it);
        // every other caller (the web app) gets the excluded docs filtered OUT
        // server-side, so an excluded doc is hidden IMMEDIATELY and stays hidden
        // even while the tablet is offline — not dependent on the daemon pushing
        // a filtered list (which never happens if it's off).
        if (auth.via === "device") {
          // MULTI-TABLET: annotate docs THIS device has never reported with
          // create:true so its daemon materializes sibling-tablet notebooks
          // and folders (same flag the web-create path uses; the daemon's
          // create is idempotent). Tombstoned (deleted) docs are served so
          // the daemon can move its local copy to trash; excluded docs are
          // never marked for creation. pdf/epub docs are NOT annotated - a
          // shell without its source would break; they stay cloud-visible
          // until source transfer exists for the device-ward direction.
          const key = deviceKeyOf(req);
          const manifest = key ? store.deviceManifest(user, key) : new Set();
          const excluded = new Set(store.getSyncExclusions(user));
          const parsed = JSON.parse(store.getDocuments(user)) as {
            documents?: Record<string, unknown>[];
          };
          const docs = Array.isArray(parsed.documents) ? parsed.documents : [];
          for (const d of docs) {
            const id = typeof d.id === "string" ? d.id : "";
            const kind = d.type;
            if (
              id &&
              !manifest.has(id) &&
              d.deleted !== true &&
              d.create !== true &&
              !excluded.has(id) &&
              (kind === "notebook" || kind === "folder") &&
              // only DEVICE-BACKED docs materialize on siblings: a legacy
              // pre-manifest doc (backed by nothing) must never re-appear
              // on a tablet that deleted it during the upgrade window
              store.docKnownToSomeDevice(user, id)
            ) {
              d.create = true;
            }
          }
          return json({ documents: docs });
        }
        const parsed = JSON.parse(store.visibleDocuments(user)) as {
          documents?: { deleted?: unknown }[];
        };
        const docs = Array.isArray(parsed.documents) ? parsed.documents : [];
        return json({ documents: docs.filter((d) => d.deleted !== true) });
      }
      if (path === "/api/documents" && req.method === "PUT") {
        const body = await readJson(req, MAX_JSON, touchDevice);
        if ("error" in body) return body.error;
        // Per-doc LWW merge (#50-lite, D11), not a blind swap: newer
        // lastModified wins per doc, so a web rename and a daemon push in the
        // same window can't erase each other. Only the daemon (device token —
        // its list is the device's complete tree) removes docs by absence,
        // preserving today's tablet-delete propagation; browser/API-key
        // writers merge only and can never wipe the library.
        store.mergeDocuments(
          user,
          body.text,
          auth.via === "device" ? deviceKeyOf(req) : null,
        );
        // #83: the daemon FILTERS excluded docs out of the list, so a doc
        // excluded before the name-capture fix kept a null name forever (the
        // settings UI showed a raw uuid). The daemon now attaches a
        // names-only identity sidecar for the docs it filtered; backfill the
        // exclusion rows from it (device pushes only — the daemon is the
        // authority on tablet-side names).
        if (auth.via === "device") {
          try {
            const parsed = JSON.parse(body.text) as {
              excludedInfo?: {
                id?: unknown;
                name?: unknown;
                type?: unknown;
                parent?: unknown;
              }[];
            };
            if (Array.isArray(parsed.excludedInfo)) {
              const entries = parsed.excludedInfo.filter(
                (e): e is { id: string; name: string; type?: string; parent?: string } =>
                  typeof e?.id === "string" && typeof e?.name === "string",
              );
              store.backfillExclusionInfo(user, entries);
              // the sidecar is also the authoritative "which excluded docs
              // does this device still HAVE" - prune ghost exclusion rows
              // (doc deleted on-tablet while excluded showed as an unticked
              // settings entry forever)
              const key = deviceKeyOf(req);
              if (key) {
                store.reconcileExcludedPresence(
                  user,
                  key,
                  entries.map((e) => e.id),
                );
              }
            }
          } catch {
            // sidecar is best-effort; the doc list already merged
          }
        }
        emit(user, { type: "doc.list.changed" });
        return json({ ok: true });
      }

      if (path === "/api/recovery/notebook" && req.method === "POST") {
        if (auth.via === "device") return json({ error: "restore requires an account credential" }, 403);
        const body = await readJson(req, MAX_JSON);
        if ("error" in body) return body.error;
        let data: RecoveryImport;
        try {
          data = parseRecoveryImport(JSON.parse(body.text));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "invalid recovery bundle" }, 400);
        }
        const digest = new Bun.CryptoHasher("sha256").update(body.text).digest("hex");
        let result: ReturnType<typeof store.restoreRecoveryNotebook>;
        try {
          result = store.restoreRecoveryNotebook(user, data, digest, (stage) => {
            if (stage === "before") {
              const guard = uploadGuard(user, data.notebook.id);
              if (guard) throw guard;
              return;
            }
            // Check the actual amount committed, including any additional
            // snapshot generated by reconciliation, before releasing the lock.
            const limit = quotaFor(user, "created");
            if (limit > 0 && store.usageBytes(user, "created") > limit) {
              throw quotaError(user, "created");
            }
            const capacity = atCapacity(user);
            if (capacity) throw capacity;
          });
        } catch (error) {
          if (error instanceof Response) return error;
          throw error;
        }
        if (result === "unverified") {
          return json({ error: "existing recovery cannot be verified; no data was changed" }, 503);
        }
        if (result === "not-empty") {
          return json({ error: "restore requires an empty account without paired devices" }, 409);
        }
        if (result === "created") emit(user, { type: "doc.list.changed" });
        return json({ ok: true, notebookId: data.notebook.id }, result === "created" ? 201 : 200);
      }

      // #54: create a brand-new empty notebook or folder from the web. Adds a
      // doc-list entry stamped `create: true`; the daemon materializes the
      // valid xochitl files (create_notebook/create_folder) on the tablet. For
      // a notebook we also seed an empty first-page .rm so the daemon pulls a
      // real page. Session/ticket only — a device/api-key caller must not
      // originate docs through the cloud (containment; the tablet makes its own).
      if (path === "/api/documents/new" && req.method === "POST") {
        if (auth.via === "apikey" || auth.via === "device") {
          return json({ error: "creating documents requires sign-in" }, 403);
        }
        const body = (await req.json().catch(() => ({}))) as {
          name?: unknown;
          parent?: unknown;
          kind?: unknown;
        };
        const kind = body.kind === "folder" ? "folder" : "notebook";
        const name =
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 256)
            : kind === "folder"
              ? "New folder"
              : "Untitled";
        const parent = typeof body.parent === "string" ? body.parent : "";
        const docId = crypto.randomUUID();
        const now = Date.now();
        const doc: Record<string, unknown> = {
          id: docId,
          type: kind,
          name,
          parent,
          lastModified: now,
          createdTime: now,
          lastOpened: now,
          create: true,
          pages: [] as unknown[],
        };
        if (kind === "notebook") {
          const pageId = crypto.randomUUID();
          doc.pages = [{ id: pageId, template: "Blank" }];
          // seed the empty first page (a valid .rm v6) so the daemon's page
          // pull writes a real first page, not a 404
          const bytes = RmDocument.empty(crypto.randomUUID()).serialize();
          store.putPage(user, docId, pageId, "", bytes, "web-new");
        }
        store.mergeDocuments(user, JSON.stringify({ documents: [doc] }), null);
        emit(user, { type: "doc.list.changed" });
        return json({ id: docId, doc });
      }

      // Import a .rm file dropped on the web library. Body = raw .rm v6
      // bytes; it becomes a new one-page notebook (create: true, same
      // materialization path as /new). Parse-validated up front — the tablet
      // must never be handed bytes xochitl could choke on. Session/ticket
      // only, same containment as /new.
      if (path === "/api/documents/import" && req.method === "POST") {
        if (auth.via === "apikey" || auth.via === "device") {
          return json({ error: "importing documents requires sign-in" }, 403);
        }
        const body = await readBytes(req, MAX_RM, touchDevice);
        if ("error" in body) return body.error;
        { const g = storageGuard(user, body.bytes.length); if (g) return g; }
        try {
          RmDocument.parse(body.bytes);
        } catch {
          return json({ error: "not a valid .rm v6 file" }, 422);
        }
        const rawName = url.searchParams.get("name") ?? "";
        const name = rawName.trim() ? rawName.trim().slice(0, 256) : "Imported";
        const parent = url.searchParams.get("parent") ?? "";
        const docId = crypto.randomUUID();
        const pageId = crypto.randomUUID();
        const now = Date.now();
        const doc = {
          id: docId,
          type: "notebook",
          name,
          parent,
          lastModified: now,
          createdTime: now,
          lastOpened: now,
          create: true,
          pages: [{ id: pageId, template: "Blank" }],
        };
        store.putPage(user, docId, pageId, "", body.bytes, "web-import");
        store.mergeDocuments(user, JSON.stringify({ documents: [doc] }), null);
        emit(user, { type: "doc.list.changed" });
        return json({ id: docId });
      }

      // Which source files are RESIDENT on the cloud right now. The daemon
      // diffs this against its own push-dedup cache to detect server-side LRU
      // eviction (#81): a source it pushed but the cloud has since evicted must
      // be re-pushed once it's hot again (re-opened). Device-facing.
      if (path === "/api/sources" && req.method === "GET") {
        return json({ docs: store.residentSources(user) });
      }

      if (path === "/api/changes" && req.method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return json({ changes: store.changesSince(user, since) });
      }

      // Daemon auto-update (#82). Ops opt in by pointing WEFT_DAEMON_RELEASE
      // at the release binary; the daemon polls with If-None-Match set to the
      // sha256 of its OWN running binary. 304 = already current (header-only,
      // the steady state); 200 = the new binary, ETag = its sha256 so the
      // daemon can verify the download before swapping itself.
      if (path === "/api/daemon/release" && req.method === "GET") {
        // Per-arch releases: ?arch=armv7 (rM1/rM2) vs default aarch64 (Paper
        // Pro; also what pre-arch daemons request). Serving the wrong ELF
        // would crash-loop a tablet, so an arch with no configured release is
        // a 404, never a fallback to the other file.
        const arch = url.searchParams.get("arch") ?? "aarch64";
        const releasePath =
          arch === "armv7"
            ? process.env.WEFT_DAEMON_RELEASE_ARMV7
            : process.env.WEFT_DAEMON_RELEASE;
        if (!releasePath) return json({ error: "no release configured" }, 404);
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(readFileSync(releasePath));
        } catch {
          return json({ error: "release unreadable" }, 404);
        }
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(bytes);
        const etag = `"${hasher.digest("hex")}"`;
        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag, ...CORS } });
        }
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            "content-type": "application/octet-stream",
            etag,
            ...CORS,
          },
        });
      }

      // Every page's current device-facing revision in one call — the
      // daemon's reconcile sweep compares these against its remembered
      // revisions and re-pulls any mismatch, so a change row that was
      // missed or wrongly skipped self-heals instead of diverging forever
      // (the weft-cal15 class: text-edit snapshots skipped by the old
      // op-head-only marker were unrecoverable — nothing ever re-pulled).
      //
      // ETag = the user's newest change seq: every content mutation writes a
      // change row, so an unchanged seq proves the whole map is unchanged.
      // The steady-state sweep is then one conditional GET answered 304 with
      // ZERO body — the tablet never re-downloads markers it already acted
      // on (owner requirement: the sweep must not weigh on the device).
      if (path === "/api/revisions" && req.method === "GET") {
        const ifNoneMatch = req.headers.get("if-none-match");
        if (auth.via === "device" && req.headers.get("x-weft-recovery") === "1") {
          const recovery = store.readRecoveryRevisions(user, ifNoneMatch);
          const headers = {
            etag: recovery.etag, "cache-control": "private, no-store", vary: "X-Weft-Recovery",
          };
          if (!recovery.body) return new Response(null, {
            status: 304, headers: { ...CORS, ...headers },
          });
          const body = JSON.stringify(recovery.body);
          if (Buffer.byteLength(body) > MAX_RECOVERY_JSON) {
            return json({ error: "Recovery inventory exceeds size limit" }, 413, headers);
          }
          return new Response(body, {
            headers: { ...CORS, ...headers, "content-type": "application/json" },
          });
        }
        const etag = quoteEtag(String(store.latestChangeSeq(user)));
        if (ifNoneMatch === etag) return new Response(null, {
          status: 304, headers: { etag, ...CORS },
        });
        return json({ pages: store.pageRevisions(user) }, 200, { etag });
      }

      // Current storage usage + quota per class (limit 0 = unlimited).
      if (path === "/api/usage" && req.method === "GET") {
        return json({
          created: {
            bytes: store.usageBytes(user, "created"),
            limit: quotaFor(user, "created"),
          },
          sources: {
            bytes: store.usageBytes(user, "sources"),
            limit: quotaFor(user, "sources"),
          },
        });
      }

      // The web-open map for the daemon's lastOpened backflow (STORAGE-PLAN
      // §3): docId -> { page, at }. The daemon max-register-merges `at` into
      // each doc's .metadata lastOpened so the tablet's library reflects web
      // reading too.
      if (path === "/api/last-opened" && req.method === "GET") {
        const docs: Record<string, { page: string; at: number }> = {};
        for (const o of store.webOpens(user)) {
          docs[o.doc] = { page: o.page, at: o.at };
        }
        return json({ docs });
      }

      // Selective sync (#54 phase 1): doc/folder ids the user keeps OFF the
      // cloud. The daemon reads this each tick and skips them (+descendants);
      // the storageGuard 403 is the server-side backstop. Phase 1 covers
      // not-yet-pushed content; purging ALREADY-synced bytes is #50-full.
      // The tablet's SYNC-LOOP heartbeat (not WS liveness): ms since the
      // daemon's tick last fetched exclusions, or null before the first tick
      // this server lifetime. The web shows "tablet offline" from this.
      if (path === "/api/sync-heartbeat" && req.method === "GET") {
        // PER DEVICE (multi-tablet): one live tablet must not mask a dead
        // sibling. msAgo = freshest (back-compat); devices = every age.
        const m = syncHeartbeats.get(user);
        const ages = m ? [...m.values()].map((t) => Date.now() - t) : [];
        return json({
          msAgo: ages.length ? Math.min(...ages) : null,
          devices: ages,
        });
      }

      if (path === "/api/sync-exclusions") {
        if (req.method === "GET") {
          // (The sync-loop heartbeat is touched centrally in the auth layer
          // for every device request — this tick is just one of them.)
          // `docs` (ids) is what the daemon reads; `info` carries the remembered
          // name/type/parent so the settings UI can re-include a doc even after
          // it's been dropped from the cloud list (#54-exclusion re-tick fix).
          return json({
            docs: store.getSyncExclusions(user),
            info: store.getExcludedDocInfo(user),
          });
        }
        if (req.method === "PUT") {
          const body = await readJson(req, MAX_JSON, touchDevice);
          if ("error" in body) return body.error;
          let docs: unknown;
          try {
            docs = (JSON.parse(body.text) as { docs?: unknown }).docs;
          } catch {
            return json({ error: "bad json" }, 400);
          }
          if (
            !Array.isArray(docs) ||
            docs.length > 10_000 ||
            docs.some(
              (d) =>
                typeof d !== "string" ||
                d.length === 0 ||
                d.length > 128 ||
                d.includes("/"),
            )
          ) {
            return json({ error: "docs must be an array of ids" }, 400);
          }
          store.setSyncExclusions(user, docs as string[]);
          // Wake the daemon NOW so it re-fetches exclusions and pushes the
          // filtered list this WS tick, instead of waiting for its ~15s poll —
          // the exclusion (or re-inclusion) reflects on the web in ~1s not ~15s.
          emit(user, { type: "doc.list.changed" });
          return json({ ok: true });
        }
      }

      // Per-doc storage breakdown (#55): which documents the bytes belong
      // to (blob/ops/snapshots/source) — the "why is my storage full"
      // answer, and (via sourceBytes) the residency signal for the settings
      // tree's "tablet only" chip.
      if (path === "/api/usage/breakdown" && req.method === "GET") {
        return json({
          docs: store.usageByDoc(user),
          created: {
            bytes: store.usageBytes(user, "created"),
            limit: quotaFor(user, "created"),
          },
          sources: {
            bytes: store.usageBytes(user, "sources"),
            limit: quotaFor(user, "sources"),
          },
        });
      }

      // Template LIST with display metadata (name/orientation/categories
      // read from inside each JSON template) — feeds the web picker (#60).
      if (path === "/api/templates" && req.method === "GET") {
        // built-ins (procedural xochitl templates, no device file) appear in
        // the picker too; user-synced templates of the same name win
        const synced = store.listTemplates(user);
        const have = new Set(synced.map((t) => t.name));
        return json({
          templates: [
            ...synced,
            ...builtinTemplateList().filter((t) => !have.has(t.name)),
          ],
        });
      }

      // Page templates (line/grid backgrounds). Per-user; daemon PUTs the
      // ones its notebooks reference, clients GET them for the underlay.
      const templateMatch = /^\/api\/templates\/([^/]+)$/.exec(path);
      if (templateMatch) {
        let name: string;
        try {
          name = decodeURIComponent(templateMatch[1]!);
        } catch {
          return json({ error: "bad template name" }, 400);
        }
        if (name.includes("/") || name.includes("..") || name.length > 128) {
          return json({ error: "bad template name" }, 400);
        }
        if (req.method === "PUT") {
          const mime =
            req.headers.get("content-type") ?? "application/octet-stream";
          const body = await readBytes(req, 4 * 1024 * 1024, touchDevice);
          if ("error" in body) return body.error;
          // templates are per-user (no doc scope for the exclusion guard)
          { const g = storageGuard(user, body.bytes.length); if (g) return g; }
          store.putTemplate(user, name, mime, body.bytes);
          return json({ ok: true });
        }
        if (req.method === "GET") {
          const tpl = store.getTemplate(user, name);
          if (!tpl) {
            // xochitl draws some templates PROCEDURALLY (Hexagon,
            // Calligraphy): the device has no file to push, so a page using
            // one showed a blank underlay. Serve the weft-authored DSL.
            const builtin = builtinTemplate(name);
            if (builtin) return json(builtin);
            return new Response(null, { status: 404, headers: CORS });
          }
          return new Response(tpl.bytes as unknown as BodyInit, {
            headers: { "content-type": tpl.mime, ...CORS },
          });
        }
      }

      const assetListMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/assets$/.exec(path);
      if (assetListMatch && req.method === "GET") {
        const [, doc, page] = assetListMatch as unknown as [
          string,
          string,
          string,
        ];
        return json({ files: store.listAssets(user, doc, page) });
      }

      const assetMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/assets\/([^/]+)$/.exec(
          path,
        );
      if (assetMatch?.[3]) {
        const { doc, page } = pageParams(assetMatch);
        const file = assetMatch[3];
        if (!/^[A-Za-z0-9_-]{1,64}\.(png|jpe?g)$/.test(file)) {
          return json({ error: "bad asset filename" }, 400);
        }
        if (req.method === "PUT") {
          const body = await readBytes(req, 20 * 1024 * 1024, touchDevice);
          if ("error" in body) return body.error;
          { const g = storageGuard(user, body.bytes.length, doc); if (g) return g; }
          store.putAsset(user, doc, page, file, body.bytes);
          emit(user, { type: "page.asset.changed", doc, page, file });
          return json({ ok: true });
        }
        if (req.method === "GET") {
          const bytes = store.getAsset(user, doc, page, file);
          if (!bytes) return new Response(null, { status: 404, headers: CORS });
          // Tablet updates and history restores can replace bytes under the
          // same filename. The validator identifies the bytes we return.
          const assetEtag = quoteEtag(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
          const cache = {
            etag: assetEtag,
            "cache-control": "private, no-store",
            vary: "Authorization",
          };
          if (req.headers.get("if-none-match") === assetEtag) {
            return new Response(null, { status: 304, headers: { ...cache, ...CORS } });
          }
          const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
          return new Response(bytes as unknown as BodyInit, {
            headers: { "content-type": mime, ...cache, ...CORS },
          });
        }
      }

      // Page thumbnail (xochitl's rendered PNG). The daemon PUTs it; the
      // hosted library GETs it to show the same preview as the tablet.
      const thumbMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/thumbnail$/.exec(path);
      if (thumbMatch) {
        const { doc, page } = pageParams(thumbMatch);
        if (req.method === "PUT") {
          const body = await readBytes(req, 5 * 1024 * 1024, touchDevice);
          if ("error" in body) return body.error;
          { const g = storageGuard(user, body.bytes.length, doc); if (g) return g; }
          store.putThumbnail(user, doc, page, body.bytes);
          return json({ ok: true });
        }
        if (req.method === "GET") {
          const thumb = store.getThumbnail(user, doc, page);
          // 204, not 404: "no thumbnail yet" is normal (daemon hasn't pushed
          // one) and the browser logs every 404 as a console error — a
          // library full of fresh docs spammed the console (owner report)
          if (!thumb) return new Response(null, { status: 204, headers: CORS });
          // ETag + 304 back the client's stale-while-revalidate cache: the
          // library renders from its own store instantly and revalidates for
          // free instead of re-downloading every PNG on every visit.
          const thumbEtag = quoteEtag(thumb.etag);
          if (req.headers.get("if-none-match") === thumbEtag) {
            return new Response(null, {
              status: 304,
              headers: { etag: thumbEtag, ...CORS },
            });
          }
          return new Response(thumb.bytes as unknown as BodyInit, {
            headers: {
              "content-type": "image/png",
              etag: thumbEtag,
              "cache-control": "private, no-cache",
              ...CORS,
            },
          });
        }
      }

      // Document source file (PDF / converted EPUB): the underlay the
      // editor renders behind the ink. Daemon PUTs it; clients GET it.
      const fileMatch = /^\/api\/documents\/([^/]+)\/file$/.exec(path);
      if (fileMatch?.[1]) {
        const doc = fileMatch[1];
        if (req.method === "PUT") {
          const body = await readBytes(req, 128 * 1024 * 1024, touchDevice);
          if ("error" in body) return body.error;
          const mime = req.headers.get("content-type") ?? "application/pdf";
          // source files bill the SOURCES class (their own quota). Exclusion +
          // global-capacity guards first (LRU eviction below can't relieve
          // those); an excluded doc 403s, a service-wide capacity stop 507s.
          if (doc && store.isDocExcluded(user, doc)) {
            return json(
              { error: "this document is excluded from sync", reason: "excluded" },
              403,
            );
          }
          {
            const cap = atCapacity(user);
            if (cap) return cap;
          }
          // Per-user PDF space WITH LRU eviction (#81): if this source would
          // exceed the user's sources quota, evict their COLDEST resident
          // sources (opened less recently than THIS doc) to make room, so the
          // most-recently-opened PDFs stay resident. Only 507 (tablet-only) if
          // it still doesn't fit — i.e. this doc is the coldest of all. Evicted
          // bytes stay on the tablet and re-push when hot again (the daemon
          // learns of eviction via GET /api/sources).
          {
            const limit = quotaFor(user, "sources");
            const incoming = body.bytes.length;
            // Projected usage AFTER this write. Subtract the doc's OWN existing
            // source bytes: putFile is INSERT-OR-REPLACE, so re-importing a
            // resident PDF nets (new - old), NOT (usage + new). Without this a
            // near-quota re-import over-computes the need, evicts a colder source
            // for nothing, then 507s the legit re-import -> stale bytes kept.
            const existing = store.getFileRef(user, doc)?.size ?? 0;
            const projected = store.usageBytes(user, "sources") - existing + incoming;
            if (limit > 0 && projected > limit) {
              store.evictColderSources(user, projected - limit, doc);
              const after = store.usageBytes(user, "sources") - existing + incoming;
              if (after > limit) {
                return quotaError(user, "sources");
              }
            }
          }
          store.putFile(user, doc, body.bytes, mime);
          return json({ ok: true });
        }
        if (req.method === "GET") {
          const privateHeaders = { ...CORS, "cache-control": "private, no-store", vary: "Authorization" };
          const ref = store.getFileRef(user, doc);
          // 204, not 404: "source not resident" is a NORMAL state (the doc is
          // tablet-only, STORAGE-PLAN §2) — the client shows the cold-doc
          // banner, and the browser doesn't log a console error per open.
          if (!ref) return new Response(null, { status: 204, headers: privateHeaders });
          // The etag IS the file's revision (sha256; a re-import is a new
          // one): the browser's Cache API layer revalidates with
          // If-None-Match instead of re-downloading tens of MB per open.
          const fileEtag = quoteEtag(ref.etag);
          if (req.headers.get("if-none-match") === fileEtag) {
            return new Response(null, {
              status: 304,
              headers: {
                etag: fileEtag,
                "accept-ranges": "bytes",
                ...privateHeaders,
              },
            });
          }
          const file = Bun.file(ref.path);
          const range = parseByteRange(req.headers.get("range"), ref.size);
          if (range) {
            // 206 Partial Content: pdf.js fetches only the bytes for
            // the page it's rendering instead of the whole document.
            const [start, end] = range;
            return new Response(file.slice(start, end + 1), {
              status: 206,
              headers: {
                "content-type": ref.mime,
                "accept-ranges": "bytes",
                "content-range": `bytes ${start}-${end}/${ref.size}`,
                etag: fileEtag,
                ...privateHeaders,
              },
            });
          }
          if (req.headers.get("range")) {
            // a Range was sent but unsatisfiable
            return new Response(null, {
              status: 416,
              headers: {
                "content-type": ref.mime,
                "accept-ranges": "bytes",
                "content-range": `bytes */${ref.size}`,
                ...privateHeaders,
              },
            });
          }
          // full file: Bun.file streams from disk (no heap buffering)
          return new Response(file, {
            headers: {
              "content-type": ref.mime,
              "accept-ranges": "bytes",
              etag: fileEtag,
              ...privateHeaders,
            },
          });
        }
      }

      // Op channel (#45): append + stream opaque op blobs for a page. The
      // cloud relays bytes; it never parses them (merge is client-side).
      // Set one page's template (#60: the web picker's write path). Updates
      // the stored doc list (bumps the doc's lastModified so D11 LWW carries
      // it) and notifies clients; the daemon applies it on-device from its
      // doc-list pull.
      // Record a web open (STORAGE-PLAN §3): the app pings this when a page
      // opens; the daemon folds it into the tablet's lastOpened. Body:
      // { page }. Also the recency bump that warms a cold doc (§2).
      const openMatch = /^\/api\/documents\/([^/]+)\/open$/.exec(path);
      if (openMatch && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          page?: unknown;
        };
        const page = typeof body.page === "string" ? body.page : "";
        if (!page || page.length > 128 || page.includes("/")) {
          return json({ error: "page required" }, 400);
        }
        store.recordWebOpen(user, openMatch[1]!, page);
        // Poke the daemon over its WebSocket so the tablet's lastOpened
        // reflects this open in ~300ms (its wake_docs handler pulls
        // /api/last-opened) instead of waiting for the fallback poll.
        emit(user, { type: "doc.list.changed" });
        return json({ ok: true });
      }

      const pageMetaMatch = /^\/api\/documents\/([^/]+)\/pages\/([^/]+)$/.exec(
        path,
      );
      if (pageMetaMatch && req.method === "PATCH") {
        const body = await readJson(req, MAX_JSON, touchDevice);
        if ("error" in body) return body.error;
        let template: unknown;
        try {
          template = (JSON.parse(body.text) as { template?: unknown })
            .template;
        } catch {
          return json({ error: "bad json" }, 400);
        }
        if (
          typeof template !== "string" ||
          template.length === 0 ||
          template.length > 128 ||
          template.includes("/") ||
          template.includes("..")
        ) {
          return json({ error: "bad template name" }, 400);
        }
        const ok = store.setPageTemplate(
          user,
          pageMetaMatch[1]!,
          pageMetaMatch[2]!,
          template,
        );
        if (!ok) return json({ error: "unknown doc/page" }, 404);
        emit(user, { type: "doc.list.changed" });
        return json({ ok: true });
      }

      const opsMatch = /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/ops$/.exec(
        path,
      );
      if (opsMatch) {
        const { doc, page } = pageParams(opsMatch);
        if (req.method === "POST") {
          const body = await readJson(req, MAX_RM, touchDevice);
          if ("error" in body) return body.error;
          const parsed = JSON.parse(body.text) as {
            ops?: unknown;
            author?: unknown;
          };
          if (!Array.isArray(parsed.ops))
            return json({ error: "ops must be an array" }, 400);
          if (parsed.ops.length > MAX_OPS_PER_POST)
            return json(
              {
                error: `too many ops in one batch (max ${MAX_OPS_PER_POST})`,
              },
              400,
            );
          const ops: Uint8Array[] = [];
          for (const b of parsed.ops) {
            if (typeof b !== "string")
              return json({ error: "op must be base64" }, 400);
            ops.push(new Uint8Array(Buffer.from(b, "base64")));
          }
          const author =
            typeof parsed.author === "string" ? parsed.author : null;
          const range = store.publishPage(user, doc, page, () => {
            store.seedSnapshotFromBlob(user, doc, page);
            {
              const g = storageGuard(
                user,
                ops.reduce((n, o) => n + o.length, 0),
                doc,
              );
              if (g) return g;
            }
            const range = store.appendOps(user, doc, page, ops, author);
            if (ops.length > 0) {
              // record a change row so the codec-dumb daemon pulls these
              // ops down to the tablet (it GETs /rm = reconstructed).
              // origin 'web' (never 'rmsyncd') so the daemon doesn't skip.
              store.recordOpChange(user, doc, page, "web");
            }
            return range;
          });
          if (range instanceof Response) return range;
          emit(user, {
            type: "ops.appended",
            doc,
            page,
            lastSeq: range.lastSeq,
          });
          return json(range);
        }
        if (req.method === "GET") {
          store.seedSnapshotFromBlob(user, doc, page);
          const since = Number(url.searchParams.get("since") ?? 0);
          // Truncation-gap signal (#52): a cursor below the page's floor (the
          // highest op seq retention deleted) predates the retained log — a
          // normal 200 would hand back a GAPPED log and the client would
          // silently diverge. 410 tells it to re-bootstrap from the latest
          // snapshot instead. Keep-all pages have floor 0 and never hit this.
          const range = store.readOpPage(user, doc, page, since);
          if (range.truncated) {
            return json(
              {
                error:
                  "cursor predates the retained op log (truncated); re-bootstrap from the latest snapshot",
                floorSeq: range.floor,
              },
              410,
            );
          }
          return json({
            ops: range.ops.map((r) => ({
              seq: r.seq,
              op: Buffer.from(r.op).toString("base64"),
              author: r.author,
              ts: r.ts,
            })),
            head: range.head,
            snapshotSeq: range.snapshotSeq,
            floor: range.floor,
          });
        }
      }

      // Snapshot channel (#45): whole-page compacted .rm at a version.
      const snapMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/snapshot$/.exec(path);
      if (snapMatch) {
        const { doc, page } = pageParams(snapMatch);
        if (req.method === "PUT") {
          const body = await readBytes(req, MAX_RM, touchDevice);
          if ("error" in body) return body.error;
          { const g = storageGuard(user, body.bytes.length, doc); if (g) return g; }
          // merge-published: concurrent tablet edits (text/anchors) that this
          // client has not seen union in instead of being clobbered
          const { seq, merged } = store.publishPage(user, doc, page, () => {
            const result = store.putSnapshotMerged(user, doc, page, body.bytes);
            store.recordOpChange(user, doc, page, "web");
            return result;
          });
          emit(user, {
            type: "page.changed",
            doc,
            page,
            revision: `snap:${seq}`,
            origin: "client",
            originClientId: req.headers.get("x-client-id"),
          });
          // merged: the stored snapshot is a SUPERSET of what this client
          // sent (concurrent tablet content union-merged in) — the client
          // must pull it back or its replica misses that content.
          return json({ seq, merged });
        }
        if (req.method === "GET") {
          // lazy blob->snapshot migration (5d): an op-mode client bootstrapping
          // a legacy blob page must receive its content, not a 404-empty page.
          store.seedSnapshotFromBlob(user, doc, page);
          const snap = store.latestSnapshotReference(user, doc, page);
          // 204, not 404: "no snapshot yet" is the NORMAL bootstrap answer
          // for ops-only and empty pages — a 404 makes the browser log a
          // console error on every page open (owner-reported noise)
          const privateHeaders = { ...CORS, "cache-control": "private, no-store", vary: "Accept-Encoding" };
          if (!snap) return new Response(null, { status: 204, headers: privateHeaders });
          // conditional GET: every client reconcile polls this endpoint, and
          // unconditionally shipping the full bytes re-downloaded megabytes
          // of snapshot the client already held on EVERY tick/echo (a real
          // slow-link saturator). Not newer than the client's seq -> 304.
          const headers = {
            "x-snapshot-seq": String(snap.seq),
            "x-snapshot-op-seq": String(snap.opSeq),
            "x-snapshot-revert": snap.revert ? "1" : "0",
            "x-snapshot-complete": snap.complete ? "1" : "0",
            ...privateHeaders,
          };
          const ifSeqGt = Number(req.headers.get("x-if-snapshot-seq-gt"));
          if (Number.isFinite(ifSeqGt) && snap.seq <= ifSeqGt) {
            return new Response(null, { status: 304, headers });
          }
          const [encoding] = acceptedEncodings(req, ["br", "gzip", "identity"], ["br", "gzip"]);
          if (!encoding) return new Response(null, { status: 406, headers });
          const bytes = snap.readBytes();
          const responseHeaders = { "content-type": "application/octet-stream", ...headers };
          if (encoding === "identity") return new Response(bytes as unknown as BodyInit, { headers: responseHeaders });
          // Compress off the event loop; avoid buffering a second full snapshot.
          // Keep the faster Brotli setting for larger snapshots to bound compression work.
          const brotliQuality = bytes.byteLength <= 2 * 1024 * 1024 ? 5 : 2;
          const compressor = encoding === "br"
            ? createBrotliCompress({ params: { [zlib.BROTLI_PARAM_QUALITY]: brotliQuality } })
            : createGzip({ level: zlib.Z_BEST_SPEED });
          const stream = Readable.from([bytes]).pipe(compressor);
          return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
            headers: { ...responseHeaders, "content-encoding": encoding },
          });
        }
      }

      // History + time-travel + revert (#51, D3). Built on the same op log
      // + snapshots — no separate history store. Per-user scoped (the `user`
      // from auth), so one user can never read/revert another's timeline.
      const historyMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/history$/.exec(path);
      if (historyMatch && req.method === "GET") {
        const { doc, page } = pageParams(historyMatch);
        store.seedSnapshotFromBlob(user, doc, page); // 5d: legacy blob = base
        // bounded response (keep-all logs grow forever): newest `limit` ops,
        // ascending; ?limit= clamped to [1, 5000], default 1000.
        const rawLimit = Number(url.searchParams.get("limit") ?? 1000);
        const limit = Number.isInteger(rawLimit)
          ? Math.max(1, Math.min(5000, rawLimit))
          : 1000;
        // `floor` (#52): points below it are unreachable (their ops were
        // truncated by retention) — a UI can grey out / hide restore for
        // them. 0 (keep-all, the default) = every point is reachable.
        return json({
          points: store.historyPoints(user, doc, page, limit),
          head: store.latestOpSeq(user, doc, page),
          floor: store.truncationFloor(user, doc, page),
        });
      }

      // State at a past op seq: the reconstructed .rm (+ overlay) at `seq`.
      // DELIBERATE public API surface (documented in docs/api-reference.md)
      // for third-party/api-key tooling — no first-party client calls it.
      const atMatch = /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/at$/.exec(
        path,
      );
      if (atMatch && req.method === "GET") {
        const { doc, page } = pageParams(atMatch);
        store.seedSnapshotFromBlob(user, doc, page); // 5d: legacy blob = base
        const seqParam = url.searchParams.get("seq");
        const seq = Number(seqParam);
        if (seqParam === null || !Number.isInteger(seq) || seq < 0) {
          return json({ error: "seq must be a non-negative integer" }, 400);
        }
        let state: ReturnType<typeof store.stateAt>;
        try {
          state = store.stateAt(user, doc, page, seq);
        } catch (e) {
          // Below the truncation floor (#52): the ops to rebuild this point
          // were deleted by retention — refuse rather than answer with a
          // wrong reconstruct.
          if (e instanceof BelowFloorError) {
            return json(
              {
                error:
                  "seq predates the retained history (ops truncated by retention)",
                floorSeq: e.floorSeq,
              },
              410,
            );
          }
          throw e;
        }
        // Return the framed snapshot container (rm + overlay), matching the
        // /snapshot channel's opaque layout, plus the op seq it reflects.
        // stateAt clamps seq>head to head, so report the EFFECTIVE seq — a
        // header advertising a seq that doesn't exist would mislead a
        // time-travel UI using it as a cursor.
        const effectiveSeq = Math.min(seq, store.latestOpSeq(user, doc, page));
        return new Response(
          encodeSnapshot(state.rm, state.overlay) as unknown as BodyInit,
          {
            headers: {
              "content-type": "application/octet-stream",
              "x-snapshot-op-seq": String(effectiveSeq),
              ...CORS,
            },
          },
        );
      }

      // Clear one page's edit history (#56): raises the truncation floor to
      // just below the head and drops the unreachable ops + snapshots. Live
      // bytes are untouched; storage frees immediately; lagging clients
      // re-bootstrap via the #52 410/OpsTruncated path. Irreversible.
      const clearMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/clear-history$/.exec(path);
      if (clearMatch && req.method === "POST") {
        const { doc, page } = pageParams(clearMatch);
        const result = store.clearPageHistory(user, doc, page);
        return json(result);
      }

      // Revert the live head to a past op seq (appends a no-op revert marker
      // then pins a checkpoint of that past state at the new head; keeps the
      // full log — the revert is itself revertible). Body: { toSeq }.
      const revertMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/revert$/.exec(path);
      if (revertMatch && req.method === "POST") {
        const { doc, page } = pageParams(revertMatch);
        const body = (await req.json().catch(() => ({}))) as {
          toSeq?: unknown;
          toSnapshot?: unknown;
        };
        const result = store.publishPage(user, doc, page, () => {
          store.seedSnapshotFromBlob(user, doc, page);
          // Restore to a stored CHECKPOINT by its snapshot seq. Op seqs cannot
          // address tablet-authored history (every daemon push folds a snapshot
          // at the same op head, typically 0), so checkpoint rows restore via
          // this branch; { toSeq } below stays for edit-run rows.
          if (body.toSnapshot !== undefined) {
            const snapSeq = Number(body.toSnapshot);
            if (!Number.isInteger(snapSeq) || snapSeq < 0) {
              return json(
                { error: "toSnapshot must be a non-negative integer" },
                400,
              );
            }
            const bytes = store.getSnapshotBytes(user, doc, page, snapSeq);
            if (!bytes) {
              return json(
                { error: "snapshot not found (it may have been pruned)" },
                404,
              );
            }
            {
              const g = storageGuard(user, bytes.length);
              if (g) return g;
            }
            const result = store.revertToSnapshot(user, doc, page, snapSeq);
            if (!result) return json({ error: "snapshot not found" }, 404);
            store.recordOpChange(user, doc, page, "web");
            return result;
          }
          const toSeq = Number(body.toSeq);
          if (!Number.isInteger(toSeq) || toSeq < 0) {
            return json({ error: "toSeq must be a non-negative integer" }, 400);
          }
          // A revert republishes the past state as a snapshot (~1 page of
          // .rm + overlay); budget it against quota like other snapshot writes.
          // Below the truncation floor (#52) stateAt refuses — map to 410 (the
          // point is unreachable; reverting to it would restore wrong bytes).
          let past: ReturnType<typeof store.stateAt>;
          try {
            past = store.stateAt(user, doc, page, toSeq);
          } catch (e) {
            if (e instanceof BelowFloorError) {
              return json(
                {
                  error:
                    "toSeq predates the retained history (ops truncated by retention)",
                  floorSeq: e.floorSeq,
                },
                410,
              );
            }
            throw e;
          }
          {
            const g = storageGuard(
              user,
              past.rm.length + JSON.stringify(past.overlay).length,
            );
            if (g) return g;
          }
          const result = store.revertTo(user, doc, page, toSeq);
          store.recordOpChange(user, doc, page, "web");
          return result;
        });
        if (result instanceof Response) return result;
        emit(user, {
          type: "page.changed",
          doc,
          page,
          revision: `ops:${result.newHead}`,
          origin: "client",
          originClientId: null,
        });
        return json({ snapshotSeq: result.snapshotSeq, opHead: result.opHead });
      }

      const pageMatch =
        /^\/api\/documents\/([^/]+)\/pages\/([^/]+)\/(rm|overlay)$/.exec(path);
      if (pageMatch?.[3]) {
        const { doc, page } = pageParams(pageMatch);
        const kind = pageMatch[3];
        if (kind === "rm") {
          if (req.method === "GET") {
            if (req.headers.get("x-weft-recovery") === "1" && auth.via === "device") {
              const recovery = store.readRecoveryPage(user, doc, page,
                req.headers.get("x-weft-native-sha256"), req.headers.get("if-none-match"));
              if (!recovery) return json({ error: "page not found" }, 404);
              const headers = {
                etag: recovery.etag, "cache-control": "private, no-store",
                vary: "X-Weft-Recovery, X-Weft-Native-Sha256, Accept-Encoding",
              };
              if (!recovery.body) return new Response(null, {
                status: 304, headers: { ...CORS, ...headers },
              });
              const body = JSON.stringify(recovery.body);
              if (Buffer.byteLength(body) > MAX_RECOVERY_JSON) {
                return json({ error: "Recovery page exceeds size limit" }, 413, headers);
              }
              const [encoding] = acceptedEncodings(req, ["gzip", "identity"], ["gzip"]);
              if (!encoding) return new Response(null, { status: 406, headers });
              if (encoding === "gzip") {
                const compressed = Readable.from([body])
                  .pipe(createGzip({ level: zlib.Z_BEST_SPEED }));
                return new Response(Readable.toWeb(compressed) as unknown as ConstructorParameters<typeof Response>[0], {
                  headers: { ...CORS, ...headers, "content-type": "application/json", "content-encoding": "gzip" },
                });
              }
              return new Response(body, {
                headers: { ...CORS, ...headers, "content-type": "application/json" },
              });
            }
            // op-mode page (#45): materialize .rm from the op log for
            // the codec-dumb daemon; legacy pages serve the blob.
            if (store.isOpModePage(user, doc, page)) {
              const recon = store.reconstructDevicePage(user, doc, page);
              return new Response(recon.bytes as unknown as BodyInit, {
                headers: {
                  "content-type": "application/octet-stream",
                  "x-rm-revision": recon.revision,
                  ...CORS,
                },
              });
            }
            const stored = store.getPage(user, doc, page);
            if (!stored)
              return new Response(null, { status: 404, headers: CORS });
            return new Response(stored.bytes as unknown as BodyInit, {
              headers: {
                "content-type": "application/octet-stream",
                "x-rm-revision": stored.revision,
                ...CORS,
              },
            });
          }
          if (req.method === "PUT") {
            const base = req.headers.get("x-base-revision") ?? "";
            const client = req.headers.get("x-client-id") ?? "unknown";
            const body = await readBytes(req, MAX_RM, touchDevice);
            if ("error" in body) return body.error;
            if (store.isOpModePage(user, doc, page)) {
              const guard = uploadGuard(user, doc);
              if (guard) return guard;
              const limit = quotaFor(user, "created");
              let result;
              try {
                result = store.applyDevicePut(user, doc, page, body.bytes, base, client, (before, after) => {
                  if (limit > 0 && after > before && after > limit) {
                    throw quotaError(user, "created", before);
                  }
                });
              } catch (error) {
                if (error instanceof Response) return error;
                throw error;
              }
              if (result.changed) {
                emit(user, {
                  type: "page.changed",
                  doc,
                  page,
                  revision: result.revision,
                  origin: auth.via === "device" ? "xochitl" : "client",
                  originClientId: auth.via === "device" ? null : client,
                });
                emit(user, {
                  type: "ops.appended",
                  doc,
                  page,
                  lastSeq: store.latestOpSeq(user, doc, page),
                });
              }
              // merged: the stored state holds content the tablet's bytes
              // lack (server-side union of concurrent web edits) — the
              // daemon pulls right back so the tablet converges now.
              return json({ revision: result.revision, merged: result.merged });
            }
            const guard = storageGuard(user, body.bytes.length, doc);
            if (guard) return guard;
            const result = store.putPage(
              user,
              doc,
              page,
              base,
              body.bytes,
              client,
            );
            if ("conflict" in result) {
              return json(
                { error: "stale-revision", currentRevision: result.conflict },
                409,
              );
            }
            emit(user, {
              type: "page.changed",
              doc,
              page,
              revision: result.revision,
              origin: auth.via === "device" ? "xochitl" : "client",
              originClientId: auth.via === "device" ? null : client,
            });
            return json({ revision: result.revision });
          }
        }
        if (kind === "overlay") {
          if (req.method === "GET") {
            // op-mode page (#45): the authoritative overlay lives in the
            // op/snapshot channel, not the legacy sidecar (op clients never
            // call putOverlay). Reconstruct it from the log at the current
            // head — mirroring how GET /rm materializes op-mode .rm. Legacy
            // blob pages still serve the sidecar. (Detach is a client-local
            // reconcile decision that is never shipped, so it is correctly
            // absent here.)
            if (store.isOpModePage(user, doc, page)) {
              return json(store.overlayAtHead(user, doc, page));
            }
            const stored = store.getOverlay(user, doc, page);
            return new Response(stored ?? '{"shapes":[]}', {
              headers: { "content-type": "application/json", ...CORS },
            });
          }
          if (req.method === "PUT") {
            const body = await readJson(req, MAX_JSON, touchDevice);
            if ("error" in body) return body.error;
            { const g = storageGuard(user, body.text.length, doc); if (g) return g; }
            store.putOverlay(user, doc, page, body.text);
            return json({ ok: true });
          }
        }
      }

      return new Response("not found", { status: 404, headers: CORS });
    },
    // Route-level crash reporting: any exception thrown while handling a
    // request lands here — report to GlitchTip (telemetry.ts) and answer a
    // clean 500 instead of Bun's default HTML error page.
    error(err) {
      if (err instanceof RootTextAuthorConflict) {
        // A legacy tablet treats 409 as permission to fetch a different page.
        return json({ error: "unresolved-text-author" }, 422);
      }
      reportError(err, { origin: "route" });
      console.error("weft-cloud: route error:", err);
      return new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
    websocket: {
      open(ws) {
        const set = sockets.get(ws.data.userId) ?? new Set();
        // Per-user connection cap (abuse guard): sockets hold server memory
        // and fanout work, and nothing else bounded how many one account
        // could open. Real usage is a handful (tabs + the daemon); the
        // default cap is far above that. Newest-in loses: the client sees a
        // policy close code and can back off; existing sessions are never
        // dropped in favor of a flood.
        if (set.size >= MAX_WS_PER_USER) {
          counters.rate429++;
          ws.close(4429, "too many connections for this account");
          return;
        }
        set.add(ws);
        sockets.set(ws.data.userId, set);
        // While the connection is held open, periodically (a) refresh the
        // credential's last_used — the client authenticates ONCE at connect, so
        // an idle-but-connected tablet (#52) or API client (#66) would otherwise
        // read "days ago"; and (b) re-validate it: userForDeviceToken/
        // userForApiKey return null once the row is deleted (revoke or stale
        // prune), so we close the socket — a backstop to the immediate
        // close-on-revoke above (#65). Browser sockets have neither credential.
        const dt = ws.data.deviceToken;
        const ak = ws.data.apiKey;
        const refresh = dt
          ? () => {
              if (!store.userForDeviceToken(dt)) ws.close();
            }
          : ak
            ? () => {
                if (!store.userForApiKey(ak)) ws.close();
              }
            : null;
        if (refresh) {
          refresh();
          wsTimers.set(ws, setInterval(refresh, 60_000));
        }
      },
      message() {},
      close(ws) {
        sockets.get(ws.data.userId)?.delete(ws);
        const t = wsTimers.get(ws);
        if (t) {
          clearInterval(t);
          wsTimers.delete(ws);
        }
      },
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("Cloud relay requires a TCP listener");
  console.log(`weft-cloud listening on :${port}`);
  if (selfHostEnabled()) {
    console.log(
      "weft-cloud: self-host mode (shared-password login via WEFT_PASSWORD)",
    );
  } else if (!process.env.CLERK_SECRET_KEY && !process.env.CLOUD_DEV_USER) {
    console.warn(
      "weft-cloud: no auth configured. Set WEFT_PASSWORD (self-host) or CLERK_SECRET_KEY (hosted).",
    );
  }
  return {
    port,
    store,
    stop: () => {
      if (backupTimer) clearInterval(backupTimer);
      if (changesPruneTimer) clearInterval(changesPruneTimer);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const staticDir = argOf("static-dir") ?? process.env.CLOUD_STATIC_DIR;
  startCloud({
    port: Number(argOf("port") ?? process.env.PORT ?? 8080),
    db: argOf("db") ?? process.env.CLOUD_DB ?? "weft.db",
    ...(staticDir ? { staticDir } : {}),
  });
  installProcessHooks();
}
