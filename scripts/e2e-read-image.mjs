// End-to-end: fake OpenAI server that asserts the image actually arrives.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PNG = Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52,
  0,0,0x05,0, 0,0,0,0x03,0, 8,2,0,0,0,
]);

const temp = await mkdtemp(join(tmpdir(), "e2e-img-"));
const home = join(temp, "home");
const cwd = join(temp, "work");
await mkdir(home, { recursive: true });
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, "shot.png"), PNG);

let sawImage = false;
let sawToolMsg = false;
let sawContiguous = false;
let turn = 0;

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    const msgs = body.messages ?? [];
    // Assert shape every request once a tool result exists.
    const toolIdx = msgs.findIndex((m) => m.role === "tool");
    if (toolIdx >= 0) {
      const after = msgs.slice(toolIdx);
      const firstNonTool = after.findIndex((m) => m.role !== "tool");
      const tools = firstNonTool < 0 ? after : after.slice(0, firstNonTool);
      const contiguous = tools.every((m) => m.role === "tool");
      const userAfter = firstNonTool < 0 ? undefined : after[firstNonTool];
      console.log("SHAPE tool_msgs=" + tools.length +
        " contiguous=" + contiguous +
        " next_role=" + (userAfter?.role ?? "none"));
      if (!contiguous) { console.log("FAIL: tool messages not contiguous"); process.exit(3); }
      sawContiguous = true;
      if (userAfter?.role === "user") {
        const parts = userAfter.content;
        if (Array.isArray(parts)) {
          const img = parts.find((p) => p.type === "image_url");
          if (img?.image_url?.url?.startsWith("data:image/png;base64,")) {
            sawImage = true;
            console.log("OK: image arrived as data url, base64 len=" +
              img.image_url.url.split(",")[1].length);
          }
        }
      }
      sawToolMsg = true;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    if (turn === 0) {
      turn = 1;
      res.write('data: {"choices":[{"delta":{"content":"let me look","finish_reason":null}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"shot.png\\"}"}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    } else {
      res.write('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n');
    }
    res.end("data: [DONE]\n\n");
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const config = {
  providers: { openai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "E2E_KEY" } },
  models: [
    {
      provider: "openai",
      id: "fake",
      ref: "openai/fake",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: "E2E_KEY",
      contextWindow: 100000,
      maxOutputTokens: 1000,
    },
  ],
  defaultModel: "openai/fake",
  compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
  webSearch: { enabled: false, order: [], timeoutSeconds: 5 },
  permissions: { allowWrite: [] },
  tui: { showThinking: true, theme: "dark", keybindings: {} },
};
await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2));

const cli = resolve("packages/coding-agent/dist/cli.js");
const child = spawn(process.execPath, ["--experimental-ffi", cli, "-p", "what is in shot.png?"], {
  cwd,
  env: { ...process.env, CLETUS_HOME: home, E2E_KEY: "k", HOME: temp, CLETUS_MODEL: "openai/fake" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "", err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
await new Promise((r) => child.on("exit", r));
server.close();

console.log("--- stdout ---"); console.log(out.trim().slice(0, 300));
console.log("--- stderr ---"); console.log(err.trim().slice(0, 800));
if (!sawToolMsg) { console.log("FAIL: no tool result ever reached the provider"); process.exit(2); }
if (!sawImage) { console.log("FAIL: image never reached the provider"); process.exit(1); }
if (!sawContiguous) { console.log("FAIL: tool messages were not contiguous"); process.exit(1); }
console.log("PASS: read returned the image and it arrived at the provider");
