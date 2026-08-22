import { expect, test } from "bun:test";
import { compileMathExpr } from "./index.js";

test("evaluates supported trajectory expressions", () => {
  const evaluate = compileMathExpr("Math.sin(PI / 2) + pow(t, 2)");

  expect(evaluate({ t: 3 })).toBe(10);
});

test("keeps exponentiation right-associative", () => {
  const evaluate = compileMathExpr("2 ^ 3 ^ 2");

  expect(evaluate({})).toBe(512);
});

test("rejects globals outside the formula allowlist", () => {
  expect(() => compileMathExpr("process.exit()")).toThrow();
});
