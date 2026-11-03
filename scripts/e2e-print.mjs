import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function waitForPort(proc) {
  return new Promise((resolvePort, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("fake server timeout")), 10000);
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = /PORT (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake server exited ${code}`));
    });
  });
}

const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "cletus-e2e-"));
const home = join(temp, "home");
const cwd = join(temp, "work");
await mkdir(home, { recursive: true });
await mkdir(cwd, { recursive: true });

const server = spawn(process.execPath, [join(root, "scripts/fake-openai.mjs"), "--port", "0"], {
  stdio: ["ignore", "pipe", "inherit"],
});
const port = await waitForPort(server);

const config = {
  defaultModel: "openai/fake",
  providers: {
    openai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "FAKE_KEY" },
    anthropic: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
  models: [
    {
      provider: "openai",
      id: "fake",
      ref: "openai/fake",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: "FAKE_KEY",
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  ],
  compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
  permissions: { allowWrite: [] },
  tui: { showThinking: true, theme: "dark", keybindings: {} },
};
await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

const child = spawn(
  process.execPath,
  [
    join(root, "packages/coding-agent/dist/cli.js"),
    "-p",
    "Create hello.txt containing hi",
    "--yolo",
    "--model",
    "openai/fake",
    "--cwd",
    cwd,
  ],
  {
    env: { ...process.env, CLETUS_HOME: home, FAKE_KEY: "dummy" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
const code = await new Promise((resolveCode) => child.on("exit", resolveCode));

let failed = false;
const check = (condition, message) => {
  if (!condition) {
    failed = true;
    process.stderr.write(`FAIL: ${message}\n`);
  }
};
check(code === 0, `exit code ${code}; stderr: ${stderr}`);
check(stdout.includes("Created hello.txt"), `stdout missing final text: ${stdout}`);
const content = await readFile(join(cwd, "hello.txt"), "utf8").catch(() => "");
check(content === "hi\n", `hello.txt content ${JSON.stringify(content)}`);

const sessionsRoot = join(home, "sessions");
const dirs = await readdir(sessionsRoot).catch(() => []);
check(dirs.length > 0, "no session directory");
if (dirs[0]) {
  const files = await readdir(join(sessionsRoot, dirs[0]));
  const file = files.find((name) => name.endsWith(".jsonl"));
  check(Boolean(file), "no session file");
  if (file) {
    const lines = (await readFile(join(sessionsRoot, dirs[0], file), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const types = lines.map((line) => line.type);
    check(types.includes("session"), "session header missing");
    check(types.includes("message"), "messages missing");
    const messages = lines.filter((line) => line.type === "message").map((line) => line.message);
    check(messages.some((message) => message.role === "user"), "user message missing");
    check(
      messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall")),
      "assistant tool call missing",
    );
    check(messages.some((message) => message.role === "toolResult"), "tool result missing");
  }
}

server.kill("SIGKILL");
await rm(temp, { recursive: true, force: true });
if (failed) process.exitCode = 1;
else process.stdout.write("e2e-print passed\n");