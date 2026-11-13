import { describe, expect, it } from "vitest";
import { validateArgs } from "../src/validate.js";

const draft2020Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};

const draft07Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};

const draft201909Schema = {
  $schema: "https://json-schema.org/draft/2019-09/schema",
  type: "object",
  properties: { query: { type: "string" } },
};

describe("validateArgs", () => {
  it("accepts valid args against a schema without $schema", () => {
    expect(validateArgs({ type: "object", properties: { a: { type: "number" } } }, { a: 1 })).toEqual({
      ok: true,
    });
  });

  it("rejects invalid args with a detail message", () => {
    const result = validateArgs(
      { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
      {},
      "demo",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("demo");
  });

  it("compiles draft-07 schemas", () => {
    expect(validateArgs(draft07Schema, { query: "x" })).toEqual({ ok: true });
  });

  it("compiles draft 2019-09 schemas", () => {
    expect(validateArgs(draft201909Schema, { query: "x" })).toEqual({ ok: true });
  });

  it("compiles draft 2020-12 schemas", () => {
    expect(validateArgs(draft2020Schema, { query: "x" })).toEqual({ ok: true });
  });

  it("enforces draft 2020-12 only keywords", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        tags: { type: "array", prefixItems: [{ type: "string" }] },
      },
    };
    expect(validateArgs(schema, { tags: ["ok"] })).toEqual({ ok: true });
    const bad = validateArgs(schema, { tags: [123] });
    expect(bad.ok).toBe(false);
  });

  it("reports a schema error for unknown $schema", () => {
    const result = validateArgs(
      { $schema: "https://example.com/not-a-real-dialect", type: "object" },
      {},
      "mcp__context7__resolve_library_id",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("schema error");
  });

  it("rejects invalid args against draft 2020-12 schema", () => {
    const result = validateArgs(draft2020Schema, { query: 1 }, "ctx");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ctx");
  });
});
