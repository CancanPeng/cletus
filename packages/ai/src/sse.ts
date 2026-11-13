export type SseEvent = { event?: string; data: string };

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const event: SseEvent = { data: dataLines.join("\n") };
    if (eventName !== undefined) event.event = eventName;
    eventName = undefined;
    dataLines = [];
    return event;
  };

  const processLine = (raw: string): SseEvent | undefined => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let rest = colon < 0 ? "" : line.slice(colon + 1);
    if (rest.startsWith(" ")) rest = rest.slice(1);
    if (field === "event") eventName = rest;
    else if (field === "data") dataLines.push(rest);
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        // SSE allows LF, CRLF, and lone CR as line terminators.
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = processLine(line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const event = processLine(buffer);
      if (event) yield event;
    }
    const event = dispatch();
    if (event) yield event;
  } finally {
    // Cancel releases the lock and frees the socket when the consumer stops
    // early (e.g. [DONE]); a no-op once the body is fully read.
    await reader.cancel().catch(() => undefined);
  }
}
