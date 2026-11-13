import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonSchema } from "@cletus/ai";

/**
 * Tool schemas arrive from many sources (built-ins, MCP servers), and they do not
 * agree on a JSON Schema dialect. MCP servers in particular ship draft 2020-12
 * schemas, which a plain `Ajv` instance rejects because it only bundles the
 * draft-07 meta-schema. Pick a validator per dialect so every common one compiles.
 */
type Draft = "2019-09" | "2020-12" | "draft-07";

type Compiler = { compile(schema: unknown): ValidateFunction };

const MAX_CACHE_ENTRIES = 256;
const cache = new Map<string, ValidateFunction>();
const compilers = new Map<Draft, Compiler>();

function draftOf(schema: JsonSchema): Draft {
  const declared = schema["$schema"];
  const dialect = typeof declared === "string" ? declared.toLowerCase() : "";
  if (dialect.includes("2020-12")) return "2020-12";
  if (dialect.includes("2019-09")) return "2019-09";
  return "draft-07";
}

function compilerFor(draft: Draft): Compiler {
  const cached = compilers.get(draft);
  if (cached) return cached;
  const options = { allErrors: true, strict: false } as const;
  const created: Compiler =
    draft === "2020-12" ? new Ajv2020(options) : draft === "2019-09" ? new Ajv2019(options) : new Ajv(options);
  compilers.set(draft, created);
  return created;
}

export function validateArgs(
  schema: JsonSchema,
  args: unknown,
  toolName = "tool",
): { ok: true } | { ok: false; message: string } {
  const key = JSON.stringify(schema);
  let validate = cache.get(key);
  if (validate) {
    // Refresh recency (Map iterates in insertion order).
    cache.delete(key);
    cache.set(key, validate);
  } else {
    try {
      validate = compilerFor(draftOf(schema)).compile(schema);
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, validate);
    } catch (error) {
      return {
        ok: false,
        message: `Invalid arguments for ${toolName}: schema error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  if (validate(args)) return { ok: true };
  const detail = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"}: ${error.message ?? error.keyword}`)
    .join("; ");
  return { ok: false, message: `Invalid arguments for ${toolName}: ${detail}` };
}
