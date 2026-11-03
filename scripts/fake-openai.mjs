import http from "node:http";

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 43123;

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", async () => {
    const parsed = JSON.parse(body || "{}");
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const text = String(lastUser?.content ?? "");
    const hasToolResult = messages.some((message) => message.role === "tool");
    const lastMessage = messages[messages.length - 1];
    const toolDenied =
      lastMessage?.role === "tool" && /denied|blocked/i.test(String(lastMessage.content ?? ""));

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    const write = async (payload) => {
      send(res, payload);
      await wait();
    };

    if (/create hello\.txt/i.test(text)) {
      if (!hasToolResult || toolDenied) {
        await write({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_write_1",
                    type: "function",
                    function: { name: "write", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        for (const piece of ['{"path":"hello.txt",', '"content":"hi\\n"}']) {
          await write({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: piece } }],
                },
                finish_reason: null,
              },
            ],
          });
        }
        await write({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
      } else {
        await write({
          choices: [{ index: 0, delta: { role: "assistant", content: "Created hello.txt" }, finish_reason: null }],
        });
        await write({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
        });
      }
    } else if (/hello/i.test(text)) {
      await write({
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello from cletus." }, finish_reason: null }],
      });
      await write({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      });
    } else {
      await write({
        choices: [{ index: 0, delta: { role: "assistant", content: "Created hello.txt" }, finish_reason: null }],
      });
      await write({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`PORT ${actual}\n`);
});