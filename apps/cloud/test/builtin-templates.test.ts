/**
 * The weft-authored fallbacks for xochitl's PROCEDURAL templates must render
 * through the same DSL interpreter the web underlay uses, at the geometry
 * measured from a real device render (WTT page thumbnail, 2026-07-07):
 * hexagon vertical-edge columns exactly sqrt(3)*64 ink units apart.
 */
import { describe, expect, test } from "bun:test";
import { renderTemplateSvg, type RmTemplate } from "@weft/rm-ink";
import { builtinTemplate, builtinTemplateList } from "../src/builtin-templates";

describe("builtin templates", () => {
  test("every builtin renders to a non-trivial SVG", () => {
    for (const entry of builtinTemplateList()) {
      const tpl = builtinTemplate(entry.name) as RmTemplate;
      const svg = renderTemplateSvg(tpl, { width: 1404, height: 1872 });
      const paths = (svg.match(/<path /g) ?? []).length;
      expect(paths).toBeGreaterThan(20);
    }
  });

  test("P Hexagon large matches the device-measured column pitch", () => {
    const tpl = builtinTemplate("P Hexagon large") as RmTemplate;
    const svg = renderTemplateSvg(tpl, { width: 1404, height: 1872 });
    // cell translates step by the cell width = sqrt(3) * 64 = 110.85
    const xs = [...svg.matchAll(/translate\((-?[\d.]+) /g)]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const uniq = [...new Set(xs)];
    expect(uniq.length).toBeGreaterThan(8);
    for (let i = 1; i < uniq.length; i++) {
      const gap = uniq[i]! - uniq[i - 1]!;
      if (gap < 1) continue; // same column
      expect(Math.abs(gap - 64 * Math.sqrt(3))).toBeLessThan(0.5);
    }
  });
});
