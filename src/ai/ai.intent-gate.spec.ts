import { AiService, type AiChatResponse } from "./ai.service";

/**
 * Pins the fast intent gate (FR-1) that removes the sequential double OpenAI
 * round-trip for plain chat on the streaming path:
 *  - `isClearlyConversational` must accept small-talk and REJECT anything that
 *    could be a command / mission / status / info / nav request (false-negative
 *    biased — a miss only costs latency, a false positive loses classification).
 *  - On the streaming path (`onToken` present) a conversational message streams
 *    freeform and NEVER calls `tryLlmStructured`.
 *  - A command-ish "text" message still runs the structured pass.
 *  - The non-streaming path (`onToken` undefined) always runs the structured
 *    pass — `/ai/chat` is byte-for-byte unchanged.
 */

const gate = (message: string): boolean =>
  (
    AiService.prototype as unknown as {
      isClearlyConversational: (this: unknown, m: string) => boolean;
    }
  ).isClearlyConversational.call(AiService.prototype, message);

const computeChat = (
  AiService.prototype as unknown as {
    computeChat: (
      this: unknown,
      identity: { userId: string; accessToken: string },
      body: { user_message: string; deployment_id?: string; drone_id?: string; client_context?: unknown },
      onToken?: (d: string) => void,
    ) => Promise<AiChatResponse>;
  }
).computeChat;

function makeStub(overrides: Record<string, unknown> = {}) {
  // Real classifiers (detectIntent / isClearlyConversational / wantsMissionOrOpsPlanning /
  // isInfoGroundingQuery / toPromptHistory / safeResponse) come from the prototype;
  // only the IO/LLM boundaries are mocked.
  const stub = Object.create(AiService.prototype);
  stub.resolveAvailableMissions = jest.fn().mockResolvedValue([]);
  stub.buildSessionKey = () => "session-key";
  stub.memory = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  stub.config = { get: jest.fn().mockReturnValue(undefined) };
  stub.persistMemory = jest.fn().mockResolvedValue(undefined);
  stub.tryLlmStructured = jest.fn().mockResolvedValue(null);
  stub.tryLlmFreeformChat = jest.fn().mockResolvedValue("Sure — happy to help!");
  stub.buildSmartFallback = jest
    .fn()
    .mockResolvedValue({ type: "text", message: "fallback", action: null, confidence: 0, data: {} });
  return Object.assign(stub, overrides);
}

describe("AiService.isClearlyConversational (fast intent gate)", () => {
  const conversational = [
    "hi",
    "hello there",
    "thanks!",
    "thank you so much",
    "tell me a joke",
    "what can you do",
    "who are you",
    "how are you doing today",
    "xin chào",
    "cảm ơn nhé",
    "bạn là ai",
  ];
  const notConversational = [
    "take off",
    "takeoff now",
    "land the drone",
    "run the perimeter mission",
    "battery status",
    "what is the drone battery level",
    "what time is it",
    "go to waypoint 1",
    "circle the building",
    "circle once",
    "go around the tower",
    "fly around the perimeter",
    "open the map",
    "show me the settings",
    "return home",
    "cất cánh",
    "hạ cánh ngay",
    "chạy nhiệm vụ tuần tra",
    "mở màn hình bản đồ",
  ];

  it.each(conversational)("treats %p as conversational", (m) => {
    expect(gate(m)).toBe(true);
  });

  it.each(notConversational)("treats %p as NOT conversational", (m) => {
    expect(gate(m)).toBe(false);
  });

  it("rejects empty / whitespace input", () => {
    expect(gate("")).toBe(false);
    expect(gate("   ")).toBe(false);
  });
});

describe("AiService.computeChat — fast gate routing", () => {
  it("streams freeform and skips the structured pass for conversational + onToken", async () => {
    const stub = makeStub();
    const tokens: string[] = [];

    const result = await computeChat.call(
      stub,
      { userId: "u", accessToken: "t" },
      { user_message: "hello there", deployment_id: "d" },
      (d) => tokens.push(d),
    );

    expect(stub.tryLlmFreeformChat).toHaveBeenCalledTimes(1);
    expect(stub.tryLlmStructured).not.toHaveBeenCalled();
    expect(result.type).toBe("text");
    expect(result.message).toBe("Sure — happy to help!");
    expect(stub.persistMemory).toHaveBeenCalledTimes(1);
  });

  it("still runs the structured pass for a command-ish text message (gate rejects)", async () => {
    const stub = makeStub();

    await computeChat.call(
      stub,
      { userId: "u", accessToken: "t" },
      { user_message: "take off", deployment_id: "d" },
      () => undefined,
    );

    expect(stub.tryLlmStructured).toHaveBeenCalledTimes(1);
  });

  it("never enters the gate on the non-streaming path (no onToken)", async () => {
    const stub = makeStub();

    await computeChat.call(
      stub,
      { userId: "u", accessToken: "t" },
      { user_message: "hello there", deployment_id: "d" },
      // no onToken
    );

    expect(stub.tryLlmFreeformChat).not.toHaveBeenCalled();
    expect(stub.tryLlmStructured).toHaveBeenCalledTimes(1);
  });

  it("falls through to the structured pass when freeform yields nothing", async () => {
    const stub = makeStub({ tryLlmFreeformChat: jest.fn().mockResolvedValue(null) });

    await computeChat.call(
      stub,
      { userId: "u", accessToken: "t" },
      { user_message: "hello there", deployment_id: "d" },
      () => undefined,
    );

    expect(stub.tryLlmFreeformChat).toHaveBeenCalledTimes(1);
    expect(stub.tryLlmStructured).toHaveBeenCalledTimes(1);
  });
});
