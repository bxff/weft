// bun apps/web/bench/ink.ts; synthetic only, no application/account/tablet access.
import { join } from "node:path";
import { chromium } from "playwright";
import type { Renderer, Scene } from "./ink-renderer";
const runs = Number(process.env.WEFT_BENCH_RUNS ?? 10);
if (!Number.isInteger(runs) || runs < 1)
  throw Error("WEFT_BENCH_RUNS must be positive");
const bundle = await Bun.build({
  entrypoints: ["apps/web/bench/ink-renderer.tsx"],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!bundle.success) throw Error(bundle.logs.join("\n"));
const files = new Map(
  bundle.outputs.map((file) => ["/" + file.path.split("/").at(-1), file]),
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/")
      return new Response(
        '<meta charset="utf-8"><link rel="stylesheet" href="/ink-renderer.css"><style>.tl-shape:has(.weft-highlighter){mix-blend-mode:darken}</style><div id="app" style="position:fixed;inset:0"></div><script type="module" src="/ink-renderer.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    if (files.has(path)) return new Response(files.get(path));
    const asset = path.match(
      /^\/sdk\/((?:fonts|translations|embed-icons)\/[a-zA-Z0-9_.-]+\.(?:woff2|json|png|svg)|icons\/icon\/0_merged\.svg)$/,
    )?.[1];
    return asset
      ? new Response(
          Bun.file(join("apps/web/node_modules/@tldraw/assets", asset)),
        )
      : new Response(null, { status: 404 });
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    channel: process.env.WEFT_BENCH_CHANNEL ?? "chromium",
  });
  const sdk = await Bun.file(
    "apps/web/node_modules/tldraw/package.json",
  ).json();
  console.log(
    JSON.stringify({
      sdk: sdk.version,
      bundleSHA256: new Bun.CryptoHasher("sha256")
        .update(
          await bundle.outputs
            .find((f) => f.path.endsWith(".js"))!
            .arrayBuffer(),
        )
        .digest("hex"),
      browser: browser.version(),
      platform: process.platform,
      arch: process.arch,
      viewport: [1280, 800],
      runs,
      note: "Native scene compares identical records; stock paint does not preserve tablet pressure/brush appearance.",
    }),
  );
  const rows: {
    scene: Scene;
    renderer: Renderer;
    run: number;
    openMs: number;
    moveMs: number;
    panP95Ms: number;
  }[] = [];
  for (const scene of ["plain", "native"] as const) {
    let expected: string | undefined;
    for (let run = 0; run < runs; run++)
      for (const renderer of (run % 2
        ? ["weft", "stock"]
        : ["stock", "weft"]) as Renderer[]) {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
          serviceWorkers: "block",
        });
        try {
          await context.route("**/*", (route) =>
            new URL(route.request().url()).origin === server.url.origin
              ? route.continue()
              : route.abort(),
          );
          const page = await context.newPage();
          await page.goto(server.url.origin);
          await page.waitForFunction(() => !!window.inkBench);
          const { fingerprint, ...metrics } = await page.evaluate(
            ({ renderer, scene }) => window.inkBench.run(renderer, scene),
            { renderer, scene },
          );
          if (expected !== undefined && fingerprint !== expected)
            throw Error("Unmatched input records");
          expected = fingerprint;
          const row = { scene, renderer, run, ...metrics };
          rows.push(row);
          console.log(JSON.stringify(row));
        } finally {
          await context.close();
        }
      }
  }
  for (const scene of ["plain", "native"])
    for (const renderer of ["stock", "weft"]) {
      const samples = rows.filter(
        (r) => r.scene === scene && r.renderer === renderer,
      );
      const medians = Object.fromEntries(
        (["openMs", "moveMs", "panP95Ms"] as const).map((key) => {
          const sorted = samples.map((r) => r[key]).sort((a, b) => a - b);
          return [
            key,
            (sorted[Math.floor((sorted.length - 1) / 2)]! +
              sorted[Math.floor(sorted.length / 2)]!) /
              2,
          ];
        }),
      );
      console.log(
        JSON.stringify({
          summary: true,
          scene,
          renderer,
          runs: samples.length,
          ...medians,
        }),
      );
    }
} finally {
  await browser?.close();
  await server.stop(true);
}
