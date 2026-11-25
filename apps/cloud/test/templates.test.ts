/**
 * #60/C: template list + set-page-template. Pinned:
 *  - GET /api/templates returns the picker metadata parsed from inside each
 *    JSON template (displayName/orientation/categories); legacy image
 *    templates degrade to kind "image"; garbage bytes never 500.
 *  - PATCH /api/documents/:doc/pages/:page {template} updates the stored doc
 *    list, bumps the doc's lastModified (so D11 LWW carries it device-ward),
 *    emits doc.list.changed semantics (stored list changes), and validates
 *    input (bad names 400, unknown doc/page 404).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCloud, type CloudServer } from "../src/server";

let server: CloudServer;
let base: string;
const USER = "tpl";
const h = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer dev:${USER}`,
  ...extra,
});

const TPL = {
  name: "Grid bottom",
  categories: ["Grids"],
  orientation: "landscape",
  constants: [{ size: 54 }],
  items: [],
};

beforeAll(async () => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  base = `http://localhost:${server.port}`;
  // seed: one JSON template, one legacy image, one garbage-bytes "json"
  await fetch(`${base}/api/templates/LS%20Grid%20bottom`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify(TPL),
  });
  await fetch(`${base}/api/templates/OldPng`, {
    method: "PUT",
    headers: h({ "content-type": "image/png" }),
    body: new Uint8Array([137, 80, 78, 71]),
  });
  await fetch(`${base}/api/templates/Broken`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: "{not json",
  });
  // seed a doc list with one doc/page (device push = authoritative)
  const dev = server.store.mintDeviceToken(USER, "t");
  await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { "x-device-token": dev, "content-type": "application/json" },
    body: JSON.stringify({
      documents: [
        {
          id: "doc1",
          name: "Doc",
          parent: "",
          lastModified: 1000,
          pages: [{ id: "p1", template: "Blank" }],
        },
      ],
    }),
  });
});
afterAll(() => server.stop());

test("GET /api/templates: picker metadata from inside the JSON; image/garbage degrade safely", async () => {
  const r = await fetch(`${base}/api/templates`, { headers: h() });
  expect(r.status).toBe(200);
  const { templates } = (await r.json()) as {
    templates: {
      name: string;
      kind: string;
      displayName: string;
      orientation: string | null;
      categories: string[];
    }[];
  };
  const grid = templates.find((t) => t.name === "LS Grid bottom")!;
  expect(grid.kind).toBe("json");
  expect(grid.displayName).toBe("Grid bottom");
  expect(grid.orientation).toBe("landscape");
  expect(grid.categories).toEqual(["Grids"]);
  expect(templates.find((t) => t.name === "OldPng")!.kind).toBe("image");
  expect(templates.find((t) => t.name === "Broken")!.kind).toBe("image");
});

test("PATCH page template: updates the list, bumps doc lastModified, survives a stale daemon re-push", async () => {
  const before = JSON.parse(server.store.getDocuments(USER)) as {
    documents: { id: string; lastModified: number; pages: { id: string; template?: string }[] }[];
  };
  const r = await fetch(`${base}/api/documents/doc1/pages/p1`, {
    method: "PATCH",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ template: "LS Grid bottom" }),
  });
  expect(r.status).toBe(200);
  const after = JSON.parse(server.store.getDocuments(USER)) as typeof before;
  const doc = after.documents.find((d) => d.id === "doc1")!;
  expect(doc.pages.find((p) => p.id === "p1")!.template).toBe("LS Grid bottom");
  expect(doc.lastModified).toBeGreaterThan(
    before.documents.find((d) => d.id === "doc1")!.lastModified,
  );

  // D11: a STALE daemon re-push (old lastModified) must not revert the pick
  const dev = server.store.mintDeviceToken(USER, "t2");
  await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { "x-device-token": dev, "content-type": "application/json" },
    body: JSON.stringify({
      documents: [
        {
          id: "doc1",
          name: "Doc",
          parent: "",
          lastModified: 1000,
          pages: [{ id: "p1", template: "Blank" }],
        },
      ],
    }),
  });
  const merged = JSON.parse(server.store.getDocuments(USER)) as typeof before;
  expect(
    merged.documents.find((d) => d.id === "doc1")!.pages.find((p) => p.id === "p1")!.template,
  ).toBe("LS Grid bottom");
});

test("PATCH validation: bad names 400, unknown doc/page 404", async () => {
  for (const bad of ["", "a/b", "..", "x".repeat(200)]) {
    const r = await fetch(`${base}/api/documents/doc1/pages/p1`, {
      method: "PATCH",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify({ template: bad }),
    });
    expect(r.status).toBe(400);
  }
  const r404 = await fetch(`${base}/api/documents/doc1/pages/nope`, {
    method: "PATCH",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ template: "LS Grid bottom" }),
  });
  expect(r404.status).toBe(404);
});
