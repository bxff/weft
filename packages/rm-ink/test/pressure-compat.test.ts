import { test, expect } from "bun:test";
import { decodeRmPointData, encodeRmPointData } from "../src/render-tldraw";
import { isRmBrush } from "../src/pen";

test("invalid cached pressure data falls back to the original stroke", () => {
  const point = { speed: 3, direction: 4, width: 5, pressure: 6 };
  expect(decodeRmPointData(encodeRmPointData([point]))).toEqual([point]);
  for (const invalid of [
    "%%%",
    "AAAAAA==",
    encodeRmPointData([{ ...point, width: NaN }]),
  ]) {
    expect(decodeRmPointData(invalid)).toEqual([]);
  }
});

test("only imported pen names select tablet rendering", () => {
  expect(isRmBrush("mechanicalPencil")).toBe(true);
  for (const unknown of [
    undefined,
    5,
    "missing",
    "__proto__",
    "constructor",
    "toString",
  ]) {
    expect(isRmBrush(unknown)).toBe(false);
  }
});
