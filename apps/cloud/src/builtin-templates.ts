/**
 * Fallback DSL for templates xochitl draws procedurally (no file to sync, so a
 * page using one otherwise renders a blank web underlay). Hexagon geometry is
 * device-measured: large side = 64 ink units (columns sqrt(3)*64 apart);
 * calligraphy is approximate. Same JSON dialect as on-device .template files
 * (rm-ink template.ts): group boundingBox is the repeat cell, paths in
 * cell-local coords, parentWidth/parentHeight in scope.
 */

/** Pointy-top hexagon grid, side `s` ink units. Cell = (sqrt(3)s x 3s), two
 *  hexagons; shared edges overdraw exactly, page-edge partials clip. */
function hexagon(name: string, s: number, orientation: "portrait" | "landscape") {
  const W = "cellW";
  return {
    name,
    author: "weft-builtin",
    templateVersion: "1.0.0",
    formatVersion: 1,
    categories: ["Grids"],
    orientation,
    constants: [{ hexSide: s }, { cellW: s * Math.sqrt(3) }],
    items: [
      {
        id: "hexes",
        type: "group",
        boundingBox: { x: 0, y: 0, width: W, height: "hexSide * 3" },
        repeat: { rows: "infinite", columns: "infinite" },
        children: [
          {
            id: "hexA",
            type: "path",
            data: [
              "M", "parentWidth / 2", 0,
              "L", "parentWidth", "hexSide / 2",
              "L", "parentWidth", "hexSide * 1.5",
              "L", "parentWidth / 2", "hexSide * 2",
              "L", 0, "hexSide * 1.5",
              "L", 0, "hexSide / 2",
              "Z",
            ],
          },
          {
            id: "hexB",
            type: "path",
            data: [
              "M", 0, "hexSide * 1.5",
              "L", "parentWidth / 2", "hexSide * 2",
              "L", "parentWidth / 2", "hexSide * 3",
              "L", 0, "hexSide * 3.5",
              "L", "0 - parentWidth / 2", "hexSide * 3",
              "L", "0 - parentWidth / 2", "hexSide * 2",
              "Z",
            ],
          },
        ],
      },
    ],
  };
}

/** Calligraphy practice rules: baseline/x-height/cap triplets with slant
 *  guides. Approximate (no device render to measure against yet). */
function calligraphy(name: string, stride: number, orientation: "portrait" | "landscape") {
  const x = stride * 0.5; // x-height above baseline
  const cap = stride * 0.75; // cap/ascender above baseline
  return {
    name,
    author: "weft-builtin",
    templateVersion: "1.0.0",
    formatVersion: 1,
    categories: ["Lines"],
    orientation,
    constants: [{ stride }, { xh: x }, { cap }],
    items: [
      {
        id: "rules",
        type: "group",
        boundingBox: { x: 0, y: 0, width: "templateWidth", height: "stride * 1.5" },
        repeat: { rows: "infinite" },
        children: [
          { id: "cap", type: "path", data: ["M", 0, "cap - cap", "L", "parentWidth", "cap - cap"] },
          { id: "xh", type: "path", data: ["M", 0, "cap - xh", "L", "parentWidth", "cap - xh"] },
          { id: "base", type: "path", data: ["M", 0, "cap", "L", "parentWidth", "cap"] },
        ],
      },
      {
        id: "slants",
        type: "group",
        boundingBox: { x: 0, y: 0, width: "stride * 2", height: "templateHeight" },
        repeat: { columns: "infinite" },
        children: [
          {
            id: "slant",
            type: "path",
            // ~52 degrees from horizontal: dx = h / tan(52deg) = h * 0.781
            data: ["M", "parentHeight * 0.781", 0, "L", 0, "parentHeight"],
          },
        ],
      },
    ],
  };
}

const BUILTINS: Record<string, object> = {
  "P Hexagon large": hexagon("Hexagon large", 64, "portrait"),
  "P Hexagon medium": hexagon("Hexagon medium", 48, "portrait"),
  "P Hexagon small": hexagon("Hexagon small", 32, "portrait"),
  "LS Hexagon large": hexagon("Hexagon large", 64, "landscape"),
  "LS Hexagon medium": hexagon("Hexagon medium", 48, "landscape"),
  "LS Hexagon small": hexagon("Hexagon small", 32, "landscape"),
  "P Calligraphy large": calligraphy("Calligraphy large", 104, "portrait"),
  "P Calligraphy medium": calligraphy("Calligraphy medium", 78, "portrait"),
  "LS Calligraphy large": calligraphy("Calligraphy large", 104, "landscape"),
  "LS Calligraphy medium": calligraphy("Calligraphy medium", 78, "landscape"),
};

/** The fallback DSL for a fileless built-in, or null. */
export function builtinTemplate(name: string): object | null {
  return BUILTINS[name] ?? null;
}

/** Picker entries for the built-ins, shaped like store.listTemplates rows. */
export function builtinTemplateList(): {
  name: string;
  kind: "json";
  displayName: string;
  orientation: string | null;
  categories: string[];
}[] {
  return Object.entries(BUILTINS).map(([name, t]) => {
    const v = t as { name?: string; orientation?: string; categories?: string[] };
    return {
      name,
      kind: "json" as const,
      displayName: v.name ?? name,
      orientation: v.orientation ?? null,
      categories: v.categories ?? [],
    };
  });
}
