/**
 * Minimal crash reporter for GlitchTip (Sentry-compatible store API). The store
 * endpoint accepts a plain JSON event, so this posts one directly instead of
 * pulling in the Sentry SDK: parse the DSN once, fire-and-forget, never throw,
 * drop everything when SENTRY_DSN is unset.
 */

const dsn = process.env.SENTRY_DSN;

const target = (() => {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !projectId) return null;
    return {
      url: `${u.protocol}//${u.host}/api/${projectId}/store/`,
      auth: `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=weft-cloud/1`,
    };
  } catch {
    return null;
  }
})();

/** Report an exception (fire-and-forget; a broken telemetry sink must never
 *  affect serving). `context` is small structured metadata — never note
 *  content. */
export function reportError(e: unknown, context: Record<string, string> = {}): void {
  if (!target) return;
  const err = e instanceof Error ? e : new Error(String(e));
  const event = {
    platform: "javascript",
    level: "error",
    logger: "weft-cloud",
    exception: {
      values: [
        {
          type: err.name,
          value: err.message,
          stacktrace: {
            frames: (err.stack ?? "")
              .split("\n")
              .slice(1, 21)
              .map((l) => ({ function: l.trim() }))
              .reverse(),
          },
        },
      ],
    },
    tags: context,
    timestamp: Date.now() / 1000,
  };
  void fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sentry-auth": target.auth,
    },
    body: JSON.stringify(event),
  }).catch(() => {});
}

/** Process-level backstops: report before the default crash logging. */
export function installProcessHooks(): void {
  process.on("uncaughtException", (e) => {
    reportError(e, { origin: "uncaughtException" });
    console.error("weft-cloud: uncaught exception:", e);
  });
  process.on("unhandledRejection", (e) => {
    reportError(e, { origin: "unhandledRejection" });
    console.error("weft-cloud: unhandled rejection:", e);
  });
}
