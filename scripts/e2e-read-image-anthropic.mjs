// Verify the Anthropic path end-to-end: read returns an image -> tool_result
// carries a real image block (not a placeholder).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PNG = (() => {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13,0); ihdr.write("IHDR",4,"ascii");
  ihdr.writeUInt32BE(1,8); ihdr.writeUInt32BE(1,12); ihdr[16]=8; ihdr[17]=2;
  const idat = Buffer.alloc(21); idat.writeUInt32BE(9,0); idat.write("IDAT",4,"ascii");
  const iend = Buffer.alloc(12); iend.write("IEND",4,"ascii");
  return Buffer.concat([sig, ihdr, idat, iend]);
})();

const temp = await mkdtemp(join(tmpdir(), "anth-"));
const home = join(temp, "home"), cwd = join(temp, "work");
await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, "shot.png"), PNG);

let turn = 0;
let sawImageBlock = false, sawToolResult = false;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", c => raw += c);
  req.on("end", () => {
    const body = JSON.parse(raw);
    for (const m of body.messages ?? []) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "tool_result") {
          sawToolResult = true;
          for (const inner of b.content ?? []) {
            if (inner.type === "image" && inner.source?.type === "base64") sawImageBlock = true;
          }
        }
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ type: "message_start", message: { usage: { input_tokens: 10 } } }));
    if (turn === 0) {
      turn = 1;
      res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "read" } }));
      res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"shot.png"}' } }));
      res.write(sse({ type: "content_block_stop", index: 0 }));
      res.write(sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }));
    } else {
      res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } }));
      res.write(sse({ type: "content_block_stop", index: 0 }));
      res.write(sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }));
    }
    res.write(sse({ type: "message_stop" }));
    res.end();
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

await writeFile(join(home, "config.json"), JSON.stringify({
  defaultModel: "anthropic/fake",
  providers: { anthropic: { baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "AK" } },
  models: [{ provider: "anthropic", id: "fake", ref: "anthropic/fake", baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "AK", contextWindow: 100000, maxOutputTokens: 1000 }],
  compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
  permissions: { allowWrite: [] },
  tui: { showThinking: true, theme: "dark", keybindings: {} },
}, null, 2));

const child = spawn(process.execPath, ["--experimental-ffi", resolve("packages/coding-agent/dist/cli.js"), "-p", "read shot.png"], {
  cwd, env: { ...process.env, CLETUS_HOME: home, AK: "k", HOME: temp, CLETUS_MODEL: "anthropic/fake" },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise(r => child.on("exit", r));
server.close();
console.log("tool_result seen:", sawToolResult, "| image block inside it:", sawImageBlock);
console.log(sawImageBlock ? "PASS anthropic image block" : "FAIL anthropic image block");
