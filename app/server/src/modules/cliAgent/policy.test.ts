import { describe, expect, test } from "bun:test";
import { validateAgentCommand } from "./index.js";

describe("CLI agent command policy", () => {
  test("accepts known agents and bounded flags", () => {
    expect(validateAgentCommand("claude --print")).toEqual({ agent: "claude", tokens: ["claude", "--print"] });
    expect(validateAgentCommand("agy --effort low -p")).toEqual({
      agent: "agy",
      tokens: ["agy", "--effort", "low", "-p"],
    });
  });

  test("rejects paths, shell syntax, and unsupported flags", () => {
    expect(() => validateAgentCommand("path/to/agent.exe")).toThrow();
    expect(() => validateAgentCommand("claude --print && whoami")).toThrow();
    expect(() => validateAgentCommand("agy --effort extreme")).toThrow();
    expect(() => validateAgentCommand("other-agent --print")).toThrow();
  });
});
