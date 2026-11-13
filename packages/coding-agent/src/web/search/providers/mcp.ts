import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function callMcpTool(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(signal ? { requestInit: { signal } } : {}),
  });
  const client = new Client(
    { name: "cletus", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError === true) {
      throw new Error(`MCP search tool ${tool} returned an error`);
    }
    const parts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    return parts.join("\n");
  } finally {
    await client.close().catch(() => undefined);
  }
}
