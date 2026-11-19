import { describe, expect, it } from "vitest";
import {
  agentTemplate,
  resolveEditorCommand,
  validateAgentName,
} from "../src/agents-manager.js";
import { parseFrontmatter } from "../src/resources/skills.js";
import { builtinAgents } from "../src/resources/agents.js";

describe("agents manager helpers", () => {
  it("validates agent names", () => {
    expect(validateAgentName("reviewer")).toBe(true);
    expect(validateAgentName("code_review-2")).toBe(true);
    expect(validateAgentName("../evil")).toBe(false);
    expect(validateAgentName("a b")).toBe(false);
    expect(validateAgentName("")).toBe(false);
    expect(validateAgentName("a/b")).toBe(false);
  });

  it("generates a loadable TODO template for a plain new agent", () => {
    const text = agentTemplate({ name: "reviewer" });
    expect(text).toContain("name: reviewer");
    expect(text.trimEnd().endsWith("You are the reviewer agent. TODO: define this role.")).toBe(true);
    // The template must round-trip through the real frontmatter parser:
    // an unquoted "TODO: …" is invalid YAML and the loader would skip it.
    const { meta, body } = parseFrontmatter(text);
    expect(meta["description"]).toBe("TODO: describe when to delegate to this agent");
    expect(body.trim()).toBe("You are the reviewer agent. TODO: define this role.");
  });

  it("builtin override templates round-trip through the loader parser", () => {
    for (const def of builtinAgents()) {
      const { meta } = parseFrontmatter(agentTemplate(def));
      expect(meta["description"]).toBe(def.description);
      expect(meta["name"]).toBe(def.name);
    }
  });

  it("pre-fills builtin fields when overriding", () => {
    const text = agentTemplate({
      name: "explore",
      description: "Read-only exploration",
      tools: ["read", "grep"],
      model: "anthropic/claude",
      prompt: "You are a read-only exploration agent.",
    });
    const { meta } = parseFrontmatter(text);
    expect(meta["description"]).toBe("Read-only exploration");
    expect(meta["tools"]).toEqual(["read", "grep"]);
    expect(meta["model"]).toBe("anthropic/claude");
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
