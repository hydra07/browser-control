import { describe, expect, test } from "bun:test";
import { applyEasing, distance, generateStraightPath } from "./index.js";

describe("geometry", () => {
  test("calculates Euclidean distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  test("clamps and applies easing", () => {
    expect(applyEasing(-1)).toBe(0);
    expect(applyEasing(2)).toBe(1);
    expect(applyEasing(0.5, "easeInOut")).toBe(0.5);
  });

  test("generates an inclusive straight path", () => {
    expect(generateStraightPath({ x: 0, y: 0 }, { x: 10, y: 10 }, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
    ]);
  });
});
