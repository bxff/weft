import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { startCloud } from "../src/server";

test("direct notebook links use a shared public shell with the generic fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-notebook-shell-"));
  const server = startCloud({ port: 0, staticDir: dir });
  try {
    const read = async (path: string) => (await fetch(`http://localhost:${server.port}${path}`, { headers: { accept: "text/html" } })).text();
    writeFileSync(join(dir, "index.html"), "generic shell");
    expect(await read("/app/notebook/sheet")).toBe("generic shell");
    writeFileSync(join(dir, "200.html"), "new generic shell");
    writeFileSync(join(dir, "index.html"), "homepage");
    expect(await read("/")).toBe("homepage");
    expect(await read("/app/notebook/sheet")).toBe("new generic shell");

    mkdirSync(join(dir, "app/shell"), { recursive: true });
    writeFileSync(join(dir, "app/shell/shell.html"), "public notebook shell");
    writeFileSync(join(dir, "app/shell/shell.html.gz"), gzipSync("public notebook shell"));
    const compressed = await fetch(`http://localhost:${server.port}/app/notebook/sheet`, {
      headers: { accept: "text/html", "accept-encoding": "gzip" },
    });
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(await compressed.text()).toBe("public notebook shell");
    expect(await read("/app/notebook/sheet")).toBe("public notebook shell");
    expect(await read("/app/another/notebook")).toBe("public notebook shell");
    expect(await read("/app/notebook/sheet/")).toBe("public notebook shell");
    expect((await fetch(`http://localhost:${server.port}/app/notebook/asset.svg`, { headers: { accept: "text/html" } })).status).toBe(404);
    expect(await read("/library")).toBe("new generic shell");
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bun static delivery matches the hosted rules for a built site", async () => {
  const { routes } = await import("../../../vercel.json");
  const dir = mkdtempSync(join(tmpdir(), "weft-routing-parity-"));
  const server = startCloud({ port: 0, staticDir: dir });
  try {
    const files = {
      "/index.html": "entry",
      "/200.html": "client shell",
      "/app/shell/shell.html": "notebook shell",
      "/docs.html": "documentation",
      "/docs/setup.html": "setup documentation",
      "/docs/__data.json": "docs data",
      "/assets/download": "extensionless asset",
    };
    for (const [path, content] of Object.entries(files)) {
      const filename = join(dir, path);
      mkdirSync(join(filename, ".."), { recursive: true });
      writeFileSync(filename, content);
    }
    const nav = { accept: "application/xhtml+xml,text/html;q=0.8,*/*;q=0.1", "sec-fetch-dest": "document" };
    const cases = [
      ["/", nav, "entry"],
      ["/docs/", nav, "documentation"],
      ["/docs/setup", nav, "setup documentation"],
      ["/docs/__data.json", { accept: "application/json" }, "docs data"],
      ["/docs/missing", nav, null],
      ["/docs/missing", { ...nav, "sec-fetch-dest": "empty" }, null],
      ["/library", nav, "client shell"],
      ["/login/", nav, "client shell"],
      ["/join", nav, "client shell"],
      ["/install", nav, "client shell"],
      ["/settings", nav, "client shell"],
      ["/settings/keys", nav, "client shell"],
      ["/app/book/page", nav, "notebook shell"],
      ["/app/book/page/", { accept: "TEXT/HTML" }, "notebook shell"],
      ["/app/book/page", { ...nav, "sec-fetch-dest": "empty" }, null],
      ["/app/book/page", { ...nav, accept: "text/html;q=0.000, */*;q=1" }, null],
      ["/app/book/page", { accept: "*/*" }, null],
      ["/app/book/main.js", nav, null],
      ["/app/book/main%2Ejs", nav, null],
      ["/app/book/page/asset", nav, null],
      ["/assets/download", { accept: "*/*", "sec-fetch-dest": "empty" }, "extensionless asset"],
      ["/assets/extensionless", nav, null],
      ["/missing", nav, null],
    ] as const;
    const available = new Map(Object.entries(files));
    const headerMatches = (value: string, input: string) => {
      const ignoreCase = value.startsWith("(?i)");
      return new RegExp(ignoreCase ? value.slice(4) : value, ignoreCase ? "i" : "").test(input);
    };
    for (const [path, headers, expected] of cases) {
      const request = new Headers(headers);
      let hosted: string | null = null;
      for (const route of routes) {
        if (route.handle === "filesystem") {
          const existing = available.get(path === "/" ? "/index.html" : path);
          if (existing === undefined) continue;
          hosted = existing;
          break;
        }
        if (!route.src || !new RegExp(route.src).test(path)) continue;
        if (route.has?.some(({ key, value }) => {
          const input = request.get(key);
          return input === null || !headerMatches(value, input);
        })) continue;
        if (route.missing?.some(({ key, value }) => {
          const input = request.get(key);
          return input !== null && headerMatches(value, input);
        })) continue;
        if (route.dest) hosted = available.get(path.replace(new RegExp(route.src), route.dest)) ?? null;
        break;
      }
      expect(hosted).toBe(expected);
      const response = await fetch(`http://localhost:${server.port}${path}`, { headers: request });
      expect(response.status).toBe(expected === null ? 404 : 200);
      expect(await response.text()).toBe(expected ?? "");
    }
    const head = await fetch(`http://localhost:${server.port}/app/book/page`, { method: "HEAD", headers: nav });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
