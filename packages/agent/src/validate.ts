import { Ajv, type ValidateFunction } from "ajv";
import type { JsonSchema } from "@cletus/ai";

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction>();

export function validateArgs(
  schema: JsonSchema,
  args: unknown,
  toolName = "tool",
): { ok: true } | { ok: false; message: string } {
  const key = JSON.stringify(schema);
  let validate = cache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
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