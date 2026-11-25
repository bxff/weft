// Same SDK, records, camera and viewport; only DrawShapeUtil differs.
import { installVisibleInkProbe } from "./visible-ink";
installVisibleInkProbe();
import React from "react";
import { createRoot } from "react-dom/client";
import { getAssetUrls } from "@tldraw/assets/selfHosted";
import {
  Tldraw,
  createShapeId,
  getIndices,
  setUserPreferences,
  type Editor,
  type TLShapePartial,
  type TLDrawShape,
} from "tldraw";
import "tldraw/tldraw.css";
import { RmDrawShapeUtil } from "../src/lib/tldraw/RmDrawShapeUtil";
import { lineToDrawShape } from "../../../packages/rm-ink/src/render-tldraw";
import {
  Pen,
  PenColor,
  END_MARKER,
} from "../../../packages/rm-format/src/index";

setUserPreferences({
  id: "ink-benchmark",
  name: "Local",
  color: "#008080",
  locale: "en",
  colorScheme: "light",
});
const frame = () =>
  new Promise<number>((resolve) => requestAnimationFrame(resolve));
const paint = async () => {
  await frame();
  await document.fonts.ready;
  await frame();
  await frame();
};
export type Renderer = "stock" | "weft";
export type Scene = "plain" | "native";
// SDK fractional indices use random jitter; fix only fixture construction.
const indices = (() => {
  const random = Math.random;
  let seed = 539211;
  Math.random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  try {
    return getIndices(999);
  } finally {
    Math.random = random;
  }
})();
const records = indices.map((index, i) => ({
  ...lineToDrawShape(createShapeId(`ink${i}`), {
    kind: "line",
    tool: [
      Pen.FINELINER_2,
      Pen.MECHANICAL_PENCIL_2,
      Pen.BALLPOINT_2,
      Pen.HIGHLIGHTER_2,
    ][i % 4]!,
    color: i % 4 === 3 ? PenColor.YELLOW : PenColor.BLACK,
    thicknessScale: 2,
    startingLength: 0,
    timestamp: END_MARKER,
    moveId: null,
    points: Array.from({ length: 80 }, (_, n) => ({
      x: (i % 40) * 70 + n * 0.7,
      y: Math.floor(i / 40) * 35 + Math.sin(n / 8) * 8,
      width: 16,
      pressure: 30 + n * 2.5,
      speed: 4,
      direction: 0,
    })),
  }),
  index,
})) as TLShapePartial<TLDrawShape>[];

async function run(renderer: Renderer, scene: Scene) {
  const root = createRoot(document.querySelector("#app")!);
  const begin = performance.now();
  const editor = await new Promise<Editor>((resolve) =>
    root.render(
      <Tldraw
        assetUrls={getAssetUrls({ baseUrl: "/sdk" })}
        shapeUtils={renderer === "weft" ? [RmDrawShapeUtil] : []}
        onMount={resolve}
      />,
    ),
  );
  editor.createShapes(
    records.map((record) =>
      scene === "native" ? record : { ...record, meta: {} },
    ),
  );
  editor.setCamera({ x: 40, y: 40, z: 1 }, { immediate: true });
  await paint();
  if (!window.benchHasVisibleInk()) throw Error("No visible viewport ink");
  const openMs = performance.now() - begin;
  const fingerprint = JSON.stringify([
    editor.getCamera(),
    editor.getCurrentPageShapes().map(({ id, props, meta, x, y, index }) => ({
      id,
      props,
      meta,
      x,
      y,
      index,
    })),
  ]);
  const counts = {
    shapes: editor.getCurrentPageShapeIds().size,
    rendered: document.querySelectorAll(".tl-shape").length,
    paths: document.querySelectorAll(
      ".tl-shape path,.tl-shape polyline,.tl-shape circle",
    ).length,
  };
  if (!counts.rendered || !counts.paths) throw Error("No rendered ink");
  const frames: number[] = [];
  let last = await frame();
  for (let i = 0; i < 48; i++) {
    editor.setCamera(
      { x: 40 + 120 * Math.sin((i * Math.PI) / 24), y: 40, z: 1 },
      { immediate: true },
    );
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  const moveStart = performance.now();
  editor.updateShapes(
    editor
      .getCurrentPageShapes()
      .map((s) => ({ id: s.id, type: s.type, x: s.x + 3 })),
  );
  await paint();
  const moveMs = performance.now() - moveStart;
  frames.sort((a, b) => a - b);
  root.unmount();
  return {
    openMs,
    moveMs,
    panP95Ms: frames[Math.ceil(frames.length * 0.95) - 1]!,
    ...counts,
    fingerprint,
  };
}
window.inkBench = { run };
declare global {
  interface Window {
    inkBench: { run: typeof run };
  }
}
