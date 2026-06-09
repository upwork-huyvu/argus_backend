import { AiService, type AiChatResponse } from "./ai.service";

/**
 * Pins the Tier-B streaming contract without standing up the whole pipeline:
 *  - chatStream() delegates to computeChat ONCE (→ memory persisted once),
 *    emits the structured envelope (message omitted) via `meta`, the prose via
 *    `token`, and the full response via `done`.
 *  - When the LLM streamed prose through onToken, the message is NOT re-emitted
 *    as a trailing token; when nothing streamed (canned/structured reply), the
 *    message is emitted once so the client can still speak it.
 *  - streamOpenAiFreeform() parses the OpenAI SSE body, forwards each delta, and
 *    returns the assembled text.
 */

type Emit = {
  meta: (e: Omit<AiChatResponse, "message">) => void;
  token: (d: string) => void;
  done: (r: AiChatResponse) => void;
};

const chatStream = (
  AiService.prototype as unknown as {
    chatStream: (
      this: unknown,
      identity: { userId: string; accessToken: string },
      body: { user_message: string },
      emit: Emit,
    ) => Promise<AiChatResponse>;
  }
).chatStream;

const streamOpenAiFreeform = (
  AiService.prototype as unknown as {
    streamOpenAiFreeform: (
      this: unknown,
      apiKey: string,
      model: string,
      messages: Array<{ role: string; content: string }>,
      onToken: (d: string) => void,
    ) => Promise<string | null>;
  }
).streamOpenAiFreeform;

describe("AiService.chatStream", () => {
  it("emits meta → single token (canned message) → done when nothing streamed", async () => {
    const canned: AiChatResponse = {
      type: "status",
      message: "Battery is at 87%.",
      action: null,
      confidence: 0.9,
      data: { status: { battery: "87%" } },
    };
    const computeChat = jest.fn().mockResolvedValue(canned);
    const events: Array<[string, unknown]> = [];
    const emit: Emit = {
      meta: (e) => events.push(["meta", e]),
      token: (d) => events.push(["token", d]),
      done: (r) => events.push(["done", r]),
    };

    const result = await chatStream.call(
      { computeChat },
      { userId: "u", accessToken: "t" },
      { user_message: "battery?" },
      emit,
    );

    expect(computeChat).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e[0])).toEqual(["meta", "token", "done"]);
    expect((events[0][1] as Partial<AiChatResponse>).message).toBeUndefined();
    expect((events[0][1] as AiChatResponse).type).toBe("status");
    expect(events[1][1]).toBe("Battery is at 87%.");
    expect(result).toBe(canned);
  });

  it("forwards live token deltas and does NOT re-emit the message at the end", async () => {
    const streamed: AiChatResponse = {
      type: "text",
      message: "Hello there.",
      action: null,
      confidence: 0.7,
      data: {},
    };
    const computeChat = jest
      .fn()
      .mockImplementation(
        async (
          _id: unknown,
          _body: unknown,
          onToken: (d: string) => void,
        ): Promise<AiChatResponse> => {
          onToken("Hello ");
          onToken("there.");
          return streamed;
        },
      );
    const events: Array<[string, unknown]> = [];
    const emit: Emit = {
      meta: (e) => events.push(["meta", e]),
      token: (d) => events.push(["token", d]),
      done: (r) => events.push(["done", r]),
    };

    await chatStream.call(
      { computeChat },
      { userId: "u", accessToken: "t" },
      { user_message: "hi" },
      emit,
    );

    const kinds = events.map((e) => e[0]);
    expect(kinds).toEqual(["token", "token", "meta", "done"]);
    expect(events.filter((e) => e[0] === "token").map((e) => e[1])).toEqual([
      "Hello ",
      "there.",
    ]);
  });
});

describe("AiService.streamOpenAiFreeform", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("parses the OpenAI SSE body, forwards deltas, returns assembled text", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    async function* body(): AsyncGenerator<Uint8Array> {
      for (const f of frames) yield new TextEncoder().encode(f);
    }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: body(),
      text: async () => "",
    }) as unknown as typeof fetch;

    const stub = {
      openAiTemperatureParams: () => ({}),
      openAiTokenLimitParams: () => ({}),
      isOpenAiInsufficientQuota: () => false,
      logger: { warn: jest.fn() },
    };

    const tokens: string[] = [];
    const result = await streamOpenAiFreeform.call(
      stub,
      "key",
      "gpt-4.1-mini",
      [{ role: "user", content: "hi" }],
      (d) => tokens.push(d),
    );

    expect(tokens).toEqual(["Hel", "lo"]);
    expect(result).toBe("Hello");
  });
});
