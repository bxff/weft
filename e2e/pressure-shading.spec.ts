/**
 * Pencil pressure must render as per-point grayness: a stroke ramping
 * pressure 30->250 paints a smooth light->dark gradient (many distinct gray
 * levels, no white tears), while a constant-pressure pen stays one path.
 */

import { test, expect } from "@playwright/test";
import { useCloudMode } from "./cloud-mode";
import { deviceToken, devicePut } from "./device-blob";

useCloudMode();

const NOTEBOOK = "22222222-2222-4222-a222-222222222222";
const PAGE = "a0b1c2d3-0000-4000-a000-00000000ab77";
const DEVICE_AUTHOR = "f73f497f-0000-4000-a000-000000000000";

async function rampRm(): Promise<Uint8Array> {
  const { RmDocument, Pen, PenColor } = await import("../packages/rm-format/src/index");
  const doc = RmDocument.empty(DEVICE_AUTHOR);
  const N = 60;
  const points = Array.from({ length: N }, (_, i) => ({
    x: -500 + (1000 * i) / (N - 1),
    y: 600,
    speed: 4,
    direction: 0,
    width: 16,
    pressure: Math.round(30 + (220 * i) / (N - 1)), // ramp 30 -> 250
  }));
  doc.appendLine(
    {
      kind: "line",
      tool: Pen.MECHANICAL_PENCIL_2,
      color: PenColor.BLACK,
      thicknessScale: 2,
      startingLength: 0,
      timestamp: { part1: 0, part2: 1 },
      moveId: null,
      points,
    },
    { authorUuid: DEVICE_AUTHOR },
  );
  // thick curvy paintbrush with swinging pressure: must render smooth,
  // no polygonal shade patches
  doc.appendLine(
    {
      kind: "line",
      tool: Pen.PAINTBRUSH_2,
      color: PenColor.BLACK,
      thicknessScale: 3,
      startingLength: 0,
      timestamp: { part1: 0, part2: 1 },
      moveId: null,
      points: Array.from({ length: 80 }, (_, i) => ({
        x: -500 + (1000 * i) / 79,
        y: 850 + Math.sin(i / 6) * 80,
        speed: 4,
        direction: 0,
        width: 60,
        pressure: Math.round(140 + Math.sin(i / 4) * 100),
      })),
    },
    { authorUuid: DEVICE_AUTHOR },
  );
  // constant-pressure ballpoint reference below
  doc.appendLine(
    {
      kind: "line",
      tool: Pen.BALLPOINT_2,
      color: PenColor.BLACK,
      thicknessScale: 2,
      startingLength: 0,
      timestamp: { part1: 0, part2: 1 },
      moveId: null,
      points: points.map((p) => ({ ...p, y: 700, width: 60, pressure: 128 })),
    },
    { authorUuid: DEVICE_AUTHOR },
  );
  doc.appendLine({
    kind: "line", tool: Pen.HIGHLIGHTER_2, color: PenColor.YELLOW, thicknessScale: 2,
    startingLength: 0, timestamp: { part1: 0, part2: 1 }, moveId: null,
    points: points.map((p, i) => ({ ...p, y: 670 + i })),
  }, { authorUuid: DEVICE_AUTHOR });
  doc.normalizeLayout();
  return doc.serialize();
}

test("pencil pressure ramp renders as a smooth multi-level gray gradient", async ({ page }) => {
  const token = await deviceToken();
  await devicePut(token, NOTEBOOK, PAGE, await rampRm());

  await page.goto(`/app/${NOTEBOOK}/${PAGE}`);
  await expect(page.getByTestId("sync-status")).toHaveText("synced", { timeout: 30_000 });
  await expect
    .poll(async () => page.locator(".tl-shape svg path").count(), { timeout: 20_000 })
    .toBeGreaterThan(0);

  const analysis = await page.evaluate(() => {
    const shapes = [...document.querySelectorAll(".tl-shape")].filter((el) =>
      el.querySelector("svg path"),
    );
    return shapes.map((el) => {
      const fills = [...el.querySelectorAll("svg path")].map(
        (p) =>
          (p.getAttribute("stroke") && p.getAttribute("stroke") !== "none"
            ? p.getAttribute("stroke")
            : p.getAttribute("fill")) ?? "",
      );
      const grays = fills
        .map((c) => /rgb\((\d+),(\d+),(\d+)\)/.exec(c))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3);
      return { paths: fills.length, grays };
    });
  });

  // the ramp stroke: a real gradient (several shade levels, light -> dark)
  // yet HARD-BOUNDED node count (the perf contract: <= ~40 paths per stroke
  // no matter its length)
  const ramp = analysis.find((a) => a.paths >= 5)!;
  expect(ramp).toBeTruthy();
  const span = Math.max(...ramp.grays) - Math.min(...ramp.grays);
  expect(ramp.grays.length).toBeGreaterThanOrEqual(5); // gradient, not 2 bands
  expect(span).toBeGreaterThan(80); // light graphite -> near black
  expect(ramp.paths).toBeLessThanOrEqual(40); // bounded DOM (perf)

  // the constant-pressure ballpoint: a handful of paths at most
  const flat = analysis.find((a) => a.paths <= 4 && a !== ramp);
  expect(flat).toBeTruthy();

  await page.screenshot({
    path: "e2e/artifacts/pressure-shading.png",
    clip: { x: 0, y: 0, width: 1280, height: 900 }, fullPage: false,
  });
});

test("SDK export preserves displayed pencil pressure and highlighter ink", async ({ page }) => {
  const sheet = crypto.randomUUID();
  await devicePut(await deviceToken(), NOTEBOOK, sheet, await rampRm());
  await page.goto(`/app/${NOTEBOOK}/${sheet}`);
  await expect(page.locator(".tl-shape svg polyline")).toBeVisible();
  const ink = await page.evaluate(async () => {
    const ed = window.__weftEditor;
    const marks = (root: Element) => [...root.querySelectorAll("path[stroke],polyline")].map(node =>
      ["d", "points", "stroke", "fill", "stroke-width", "opacity", "stroke-linecap", "stroke-linejoin"].map(name => node.getAttribute(name)));
    const result = [];
    for (const brush of ["mechanicalPencil", "highlighter"]) {
      const shape = ed.getCurrentPageShapes().find(s => s.meta.rmBrush === brush)!;
      const canvas = document.querySelector(`.tl-shape[data-shape-id="${shape.id}"]`)!;
      const { svg } = (await ed.getSvgString([shape.id]))!;
      const exported = new DOMParser().parseFromString(svg, "image/svg+xml");
      result.push({ brush, canvas: marks(canvas), exported: marks(exported.documentElement) });
    }
    return result;
  });
  for (const row of ink) {
    expect(row.canvas.length).toBeGreaterThan(0);
    expect(row.exported, row.brush).toEqual(row.canvas);
  }

  // Sample the black ballpoint at the crossing and the highlighter a little before it.
  const [crossing, band] = await page.evaluate(() => {
    const line = document.querySelector<SVGPolylineElement>(".tl-shape svg polyline")!;
    return [30, 12].map(i => {
      const point = line.points.getItem(i).matrixTransform(line.getScreenCTM()!);
      return { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 };
    });
  });
  const black = await page.screenshot({ clip: crossing });
  const yellow = await page.screenshot({ clip: band });
  await page.addStyleTag({ content: ".tl-shape svg polyline { visibility: hidden }" });
  expect(await page.screenshot({ clip: band })).not.toEqual(yellow);
  expect(await page.screenshot({ clip: crossing })).toEqual(black);
});

test("SVG export includes both round caps and edges of resized tablet ink", async ({ page }) => {
  const { RmDocument, Pen, PenColor, END_MARKER } = await import("../packages/rm-format/src/index");
  const sheet = crypto.randomUUID(), native = RmDocument.empty(DEVICE_AUTHOR);
  native.appendLine({
    kind: "line", tool: Pen.HIGHLIGHTER_2, color: PenColor.YELLOW, thicknessScale: 2,
    startingLength: 0, timestamp: END_MARKER, moveId: null,
    points: [0, 80, 160, 240].map(x => ({x, y: 0, width: 240, pressure: 128, speed: 4, direction: 0})),
  }, {authorUuid: DEVICE_AUTHOR});
  native.normalizeLayout();
  await devicePut(await deviceToken(), NOTEBOOK, sheet, native.serialize());
  await page.goto(`/app/${NOTEBOOK}/${sheet}`);
  await page.locator(".tl-shape svg polyline").waitFor({state: "attached"});

  const results = await page.evaluate(async () => {
    const ed = window.__weftEditor;
    const stroke = ed.getCurrentPageShapes().find(s => s.meta.rmBrush === "highlighter")!;
    const rows = [];
    for (const [scaleX, scaleY, rotation] of [[4, 4, 0], [-4, 2, -Math.PI / 4]] as const) {
      ed.updateShape({id: stroke.id, type: "draw", rotation, props: {scale: 2, scaleX, scaleY}});
      const {svg} = (await ed.getSvgString([stroke.id], {background: false}))!;
      const url = URL.createObjectURL(new Blob([svg], {type: "image/svg+xml"}));
      const image = new Image();
      try {
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        const {width, height} = canvas, pixels = ctx.getImageData(0, 0, width, height).data;
        let edgeInk = 0, ink = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (pixels[4 * (y * width + x) + 3] === 0) continue;
          ink++;
          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgeInk++;
        }
        rows.push({ink, edgeInk});
      } finally { URL.revokeObjectURL(url); }
    }
    return rows;
  });
  for (const {ink, edgeInk} of results) {
    expect(ink).toBeGreaterThan(10_000);
    expect(edgeInk).toBe(0);
  }
});

test("short tablet strokes keep their native paint bounds and color", async ({ page }) => {
  const { RmDocument, Pen, PenColor, END_MARKER } = await import("../packages/rm-format/src/index");
  const native = RmDocument.empty(DEVICE_AUTHOR), sheet = crypto.randomUUID();
  for (const [tool, color, xs] of [[Pen.HIGHLIGHTER_2, PenColor.GREEN, [0, 1]], [Pen.BALLPOINT_2, PenColor.PINK, [100]], [Pen.FINELINER_2, PenColor.BLACK, [200, 210]], [Pen.MECHANICAL_PENCIL_2, PenColor.BLACK, [300, 310]]] as const) {
    const thin = tool === Pen.FINELINER_2 || tool === Pen.MECHANICAL_PENCIL_2;
    native.appendLine({kind: "line", tool, color, thicknessScale: 2, startingLength: 0,
      timestamp: END_MARKER, moveId: null,
      points: xs.map((x, i) => ({x, y: 0, width: thin ? 0 : 240, pressure: thin ? i * 255 : 255, speed: 4, direction: 0})),
    }, {authorUuid: DEVICE_AUTHOR});
  }
  native.normalizeLayout();
  await devicePut(await deviceToken(), NOTEBOOK, sheet, native.serialize());
  await page.goto(`/app/${NOTEBOOK}/${sheet}`);
  await page.locator(".tl-shape svg polyline").waitFor({state: "attached"});
  const strokes = await page.evaluate(async () => {
    const editor = window.__weftEditor;
    return Promise.all(editor.getCurrentPageShapes().filter(s => s.type === "draw").map(async shape => {
      const {bounds, boundsVertices} = editor.getShapeGeometry(shape);
      const extents = (values: number[]) => Math.max(...values) - Math.min(...values);
      const canvas = document.querySelector(`.tl-shape[data-shape-id="${shape.id}"]`)!;
      const {svg} = (await editor.getSvgString([shape.id]))!;
      const exported = new DOMParser().parseFromString(svg, "image/svg+xml");
      const selector = shape.meta.rmBrush === "highlighter" ? "polyline" : shape.meta.rmBrush === "ballpoint" ? "circle" : "path";
      const attr = selector === "circle" ? "fill" : "stroke";
      return { brush: shape.meta.rmBrush, size: [bounds.width, bounds.height],
        vertexSize: [extents(boundsVertices.map(p => p.x)), extents(boundsVertices.map(p => p.y))],
        paintWidth: canvas.querySelector(selector)?.getAttribute("stroke-width"),
        live: canvas.querySelector(selector)?.getAttribute(attr), exported: exported.querySelector(selector)?.getAttribute(attr) };
    }));
  });
  expect(strokes).toHaveLength(4);
  for (const stroke of strokes) {
    expect(stroke.size).toEqual(stroke.vertexSize);
    if (stroke.brush === "fineliner" || stroke.brush === "mechanicalPencil") {
      expect(stroke.paintWidth).toBe("0.25");
      expect(stroke.size[1]).toBeCloseTo(0.25, 4);
      expect(stroke.exported).toBe(stroke.live);
      continue;
    }
    expect(stroke.size[1]).toBeCloseTo(240 / 4 * 144 / 226, 4);
    expect(stroke.live).toBe(stroke.brush === "highlighter" ? "rgb(0,255,0)" : "rgb(255,192,203)");
    expect(stroke.exported).toBe(stroke.live);
  }
});

test("tablet paint is reused across transforms and invalidated by native metadata", async ({ page }) => {
  const sheet = crypto.randomUUID();
  await devicePut(await deviceToken(), NOTEBOOK, sheet, await rampRm());
  await page.goto(`/app/${NOTEBOOK}/${sheet}`);
  await expect(page.locator(".tl-shape svg polyline")).toBeVisible();
  const result = await page.evaluate(() => {
    const editor = window.__weftEditor;
    const stroke = editor.getCurrentPageShapes().find(s => s.type === "draw" && s.meta.rmBrush === "highlighter")!;
    const util = editor.getShapeUtil(stroke);
    const paint = util.component(stroke);
    const bounds = editor.getShapeGeometry(stroke).bounds;
    editor.updateShape({id: stroke.id, type: "draw", x: stroke.x + 100, rotation: .4});
    const moved = editor.getShape(stroke.id)!;
    const reused = util.component(moved) === paint;
    const sameBounds = editor.getShapeGeometry(moved).bounds === bounds;
    editor.updateShape({id: stroke.id, type: "draw", meta: {...moved.meta, rmColor: "pink"}});
    const changed = editor.getShape(stroke.id)!;
    const invalidated = util.component(changed) !== paint;
    const bad = {...changed, meta: {...changed.meta, rmBrush: "constructor", rmPointData: "invalid!"}};
    // Invalid imported metadata must delegate to the SDK without crashing.
    const fallback = !!util.component(bad);
    return {reused, sameBounds, invalidated, fallback};
  });
  expect(result).toEqual({reused: true, sameBounds: true, invalidated: true, fallback: true});
});
