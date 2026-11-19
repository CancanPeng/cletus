import { describe, expect, it } from "vitest";
import {
  agentTemplate,
  resolveEditorCommand,
  validateAgentName,
} from "../src/agents-manager.js";

describe("agents manager helpers", () => {
  it("validates agent names", () => {
    expect(validateAgentName("reviewer")).toBe(true);
    expect(validateAgentName("code_review-2")).toBe(true);
    expect(validateAgentName("../evil")).toBe(false);
    expect(validateAgentName("a b")).toBe(false);
    expect(validateAgentName("")).toBe(false);
    expect(validateAgentName("a/b")).toBe(false);
  });

  it("generates the TODO template for a plain new agent", () => {
    expect(agentTemplate({ name: "reviewer" })).toBe(
      `---\nname: reviewer\ndescription: TODO: describe when to delegate to this agent\n---\nYou are the reviewer agent. TODO: define this role.\n`,
    );
  });

  it("pre-fills builtin fields when overriding", () => {
    const text = agentTemplate({
      name: "explore",
      description: "Read-only exploration",
      tools: ["read", "grep"],
      model: "anthropic/claude",
      prompt: "You are a read-only exploration agent.",
    });
    expect(text).toContain("description: Read-only exploration");
    expect(text).toContain("tools: [read, grep]");
    expect(text).toContain("model: anthropic/claude");
    expect(text.trimEnd().endsWith("You are a read-only exploration agent.")).toBe(true);
    expect(text).not.toContain("TODO");
  });

  it("resolves the editor command chain", () => {
    expect(resolveEditorCommand({ EDITOR: "nvim" }, () => false)).toBe("nvim");
    expect(resolveEditorCommand({ VISUAL: "code -w" }, () => false)).toBe("code -w");
    expect(resolveEditorCommand({ EDITOR: "nvim", VISUAL: "vim" }, () => false)).toBe("nvim");
    expect(resolveEditorCommand({}, (cmd) => cmd === "vim")).toBe("vim");
    expect(resolveEditorCommand({}, () => false)).toBeUndefined();
  });
});
