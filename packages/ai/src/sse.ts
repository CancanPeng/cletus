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

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const event = dispatch();
          if (event) yield event;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let rest = colon < 0 ? "" : line.slice(colon + 1);
        if (rest.startsWith(" ")) rest = rest.slice(1);
        if (field === "event") eventName = rest;
        else if (field === "data") dataLines.push(rest);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith("data:")) {
        let rest = line.slice(5);
        if (rest.startsWith(" ")) rest = rest.slice(1);
        dataLines.push(rest);
      }
    }
    const event = dispatch();
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}