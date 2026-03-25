import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultSuccess,
  SDKSystemMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";

// Mock the SDK's query function before importing our module
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { tappedQuery } from "./index.js";
import type { TapHandlers, TapOptions, TapMessage } from "./index.js";
import { query as mockQueryFn } from "@anthropic-ai/claude-agent-sdk";

const mockQuery = vi.mocked(mockQueryFn);

// ── Helpers ──────────────────────────────────────────────────────────

const SESSION = "test-session-id";

/**
 * Build a fake Query object that simulates the real SDK behavior.
 *
 * When the real SDK receives an AsyncIterable prompt, it consumes that
 * iterable to read user messages. Our mock does the same: if the `query()`
 * call receives an async iterable prompt, fakeQuery drains it so that the
 * wrapUserInput wrapper actually fires handlers for each outgoing user message.
 */
function fakeQuery(messages: SDKMessage[]): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for (const msg of messages) {
      yield msg;
    }
  }

  const generator = gen();
  const streamInputFn = vi.fn<(stream: AsyncIterable<SDKUserMessage>) => Promise<void>>(
    async (stream) => {
      // Simulate the SDK consuming the stream input
      for await (const _ of stream) {
        // drain
      }
    },
  );

  return Object.assign(generator, {
    interrupt: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    streamInput: streamInputFn,
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setMaxThinkingTokens: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    initializationResult: vi.fn(async () => ({}) as any),
    supportedCommands: vi.fn(async () => []),
    supportedModels: vi.fn(async () => []),
    supportedAgents: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    accountInfo: vi.fn(async () => ({}) as any),
    rewindFiles: vi.fn(async () => ({}) as any),
    reconnectMcpServer: vi.fn(async () => {}),
    toggleMcpServer: vi.fn(async () => {}),
    setMcpServers: vi.fn(async () => ({}) as any),
    stopTask: vi.fn(async () => {}),
  }) as unknown as Query;
}

/**
 * Helper to make mockQuery consume an async iterable prompt, simulating
 * how the real SDK reads user messages from the prompt stream.
 */
async function drainMockPrompt(): Promise<void> {
  const callArgs = mockQuery.mock.calls[0]?.[0];
  if (callArgs && typeof callArgs.prompt !== "string") {
    for await (const _ of callArgs.prompt as AsyncIterable<SDKUserMessage>) {
      // drain — triggers wrapUserInput handlers
    }
  }
}

function makeSystemInit(): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "api_key" as any,
    betas: [],
    claude_code_version: "1.0.0",
    cwd: "/tmp",
    tools: ["Read", "Write"],
    mcp_servers: [],
    model: "claude-sonnet-4-20250514",
    permissionMode: "default" as any,
    slash_commands: [],
    output_style: "concise",
    skills: [],
    uuid: "uuid-init" as any,
    session_id: SESSION,
  };
}

function makeAssistant(text: string): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as any,
    parent_tool_use_id: null,
    uuid: "uuid-assistant" as any,
    session_id: SESSION,
  };
}

function makeUser(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    } as any,
    parent_tool_use_id: null,
    session_id: SESSION,
  };
}

function makeResult(): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 } as any,
    modelUsage: {},
    permission_denials: [],
    uuid: "uuid-result" as any,
    session_id: SESSION,
  };
}

/** Collect all messages from a tapped query. */
async function collect(stream: AsyncIterable<TapMessage>): Promise<TapMessage[]> {
  const messages: TapMessage[] = [];
  for await (const msg of stream) {
    messages.push(msg);
  }
  return messages;
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  mockQuery.mockReset();
});

describe("tappedQuery with string prompt", () => {
  it("emits tap:query_params as the first message with the prompt", async () => {
    const q = fakeQuery([makeSystemInit(), makeAssistant("Hello"), makeResult()]);
    mockQuery.mockReturnValue(q);

    const messages = await collect(
      tappedQuery({ prompt: "Hi there", options: { model: "claude-sonnet-4-20250514" } }, {}),
    );

    expect(messages[0]).toMatchObject({
      type: "tap:query_params",
      prompt: "Hi there",
      model: "claude-sonnet-4-20250514",
    });
  });

  it("passes all SDK messages through unchanged", async () => {
    const init = makeSystemInit();
    const assistant = makeAssistant("Hello");
    const result = makeResult();
    const q = fakeQuery([init, assistant, result]);
    mockQuery.mockReturnValue(q);

    const messages = await collect(tappedQuery({ prompt: "test" }, {}));

    // First is tap:query_params, then the 3 SDK messages
    expect(messages).toHaveLength(4);
    expect(messages[1]).toBe(init);
    expect(messages[2]).toBe(assistant);
    expect(messages[3]).toBe(result);
  });

  it("calls type-specific handlers for each message", async () => {
    const init = makeSystemInit();
    const assistant = makeAssistant("Hello");
    const result = makeResult();
    const q = fakeQuery([init, assistant, result]);
    mockQuery.mockReturnValue(q);

    const handlers: TapHandlers = {
      "tap:query_params": vi.fn(),
      "system:init": vi.fn(),
      assistant: vi.fn(),
      result: vi.fn(),
    };

    await collect(tappedQuery({ prompt: "test" }, handlers, { awaitCallbacks: true }));

    expect(handlers["tap:query_params"]).toHaveBeenCalledOnce();
    expect(handlers["system:init"]).toHaveBeenCalledWith(init);
    expect(handlers.assistant).toHaveBeenCalledWith(assistant);
    expect(handlers.result).toHaveBeenCalledWith(result);
  });

  it("calls onMessage for every message including tap:query_params", async () => {
    const q = fakeQuery([makeSystemInit(), makeResult()]);
    mockQuery.mockReturnValue(q);

    const onMessage = vi.fn();
    await collect(tappedQuery({ prompt: "test" }, {}, { onMessage, awaitCallbacks: true }));

    // tap:query_params + system:init + result = 3
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ type: "tap:query_params" });
  });
});

describe("tappedQuery with AsyncIterable prompt (streaming input)", () => {
  it("taps outgoing user messages through the user handler", async () => {
    const userMsg = makeUser("Hello from user");
    const assistant = makeAssistant("Hello back");
    const result = makeResult();

    // The SDK will emit messages in response to user input
    const q = fakeQuery([makeSystemInit(), assistant, result]);
    mockQuery.mockReturnValue(q);

    const userHandler = vi.fn();
    const onMessage = vi.fn();

    // Create an async iterable that yields user messages
    async function* userInput(): AsyncIterable<SDKUserMessage> {
      yield userMsg;
    }

    const tapped = tappedQuery(
      { prompt: userInput() },
      { user: userHandler },
      { onMessage, awaitCallbacks: true },
    );

    // Simulate the SDK consuming the prompt (as the real SDK would)
    await drainMockPrompt();

    // Consume the tapped stream
    await collect(tapped);

    // The user handler should have been called for the outgoing user message
    expect(userHandler).toHaveBeenCalledWith(userMsg);
    // onMessage should also see the user message
    expect(onMessage).toHaveBeenCalledWith(userMsg);
  });

  it("forwards wrapped user messages to the SDK query unchanged", async () => {
    const userMsg = makeUser("Hello from user");
    const q = fakeQuery([makeSystemInit(), makeResult()]);
    mockQuery.mockReturnValue(q);

    async function* userInput(): AsyncIterable<SDKUserMessage> {
      yield userMsg;
    }

    tappedQuery({ prompt: userInput() }, {});

    // Verify that mockQuery was called with a wrapped prompt (not a string)
    expect(mockQuery).toHaveBeenCalledOnce();
    const callArgs = mockQuery.mock.calls[0][0];
    expect(typeof callArgs.prompt).not.toBe("string");

    // The wrapped prompt should yield the same messages
    const wrappedPrompt = callArgs.prompt as AsyncIterable<SDKUserMessage>;
    const yielded: SDKUserMessage[] = [];
    for await (const msg of wrappedPrompt) {
      yielded.push(msg);
    }
    expect(yielded).toHaveLength(1);
    expect(yielded[0]).toBe(userMsg);
  });

  it("does not include prompt text in tap:query_params when prompt is async iterable", async () => {
    const q = fakeQuery([makeResult()]);
    mockQuery.mockReturnValue(q);

    async function* userInput(): AsyncIterable<SDKUserMessage> {
      yield makeUser("hi");
    }

    const messages = await collect(tappedQuery({ prompt: userInput() }, {}));

    const qp = messages[0];
    expect(qp).toMatchObject({ type: "tap:query_params" });
    expect((qp as any).prompt).toBeUndefined();
  });

  it("taps multiple user messages in order", async () => {
    const msg1 = makeUser("first");
    const msg2 = makeUser("second");
    const msg3 = makeUser("third");

    const q = fakeQuery([makeSystemInit(), makeResult()]);
    mockQuery.mockReturnValue(q);

    const tappedUsers: SDKUserMessage[] = [];
    const userHandler = vi.fn((msg: SDKUserMessage) => {
      tappedUsers.push(msg);
    });

    async function* userInput(): AsyncIterable<SDKUserMessage> {
      yield msg1;
      yield msg2;
      yield msg3;
    }

    tappedQuery({ prompt: userInput() }, { user: userHandler });

    // Consume the wrapped prompt to trigger tapping
    const callArgs = mockQuery.mock.calls[0][0];
    const wrappedPrompt = callArgs.prompt as AsyncIterable<SDKUserMessage>;
    for await (const _ of wrappedPrompt) {
      // drain
    }

    expect(tappedUsers).toEqual([msg1, msg2, msg3]);
  });
});

describe("tappedQuery streamInput wrapping", () => {
  it("wraps streamInput calls to tap outgoing user messages", async () => {
    const q = fakeQuery([makeSystemInit(), makeResult()]);
    mockQuery.mockReturnValue(q);

    const userHandler = vi.fn();
    const tapped = tappedQuery(
      { prompt: "initial prompt" },
      { user: userHandler },
      { awaitCallbacks: true },
    );

    // Send a follow-up message via streamInput
    const followUp = makeUser("follow-up message");
    async function* followUpStream(): AsyncIterable<SDKUserMessage> {
      yield followUp;
    }

    // streamInput is wrapped by the proxy — the mock now self-drains
    await tapped.streamInput(followUpStream());

    expect(userHandler).toHaveBeenCalledWith(followUp);
  });
});

describe("handler error isolation", () => {
  it("does not break the stream when a handler throws", async () => {
    const q = fakeQuery([makeSystemInit(), makeAssistant("hello"), makeResult()]);
    mockQuery.mockReturnValue(q);

    const onError = vi.fn();
    const handlers: TapHandlers = {
      "system:init": () => {
        throw new Error("handler boom");
      },
      assistant: vi.fn(),
    };

    const messages = await collect(
      tappedQuery({ prompt: "test" }, handlers, { onError, awaitCallbacks: true }),
    );

    // All messages should still come through
    expect(messages).toHaveLength(4); // tap:query_params + 3 SDK messages
    expect(onError).toHaveBeenCalledOnce();
    expect(handlers.assistant).toHaveBeenCalledOnce();
  });

  it("does not break the stream when onMessage throws", async () => {
    const q = fakeQuery([makeAssistant("hello"), makeResult()]);
    mockQuery.mockReturnValue(q);

    const onError = vi.fn();
    const onMessage = vi.fn(() => {
      throw new Error("onMessage boom");
    });

    const messages = await collect(
      tappedQuery({ prompt: "test" }, {}, { onMessage, onError, awaitCallbacks: true }),
    );

    // All messages should still come through
    expect(messages).toHaveLength(3); // tap:query_params + 2 SDK messages
    // onError called for each onMessage failure
    expect(onError).toHaveBeenCalledTimes(3);
  });
});

describe("awaitCallbacks option", () => {
  it("awaits async handlers when awaitCallbacks is true", async () => {
    const q = fakeQuery([makeAssistant("hello")]);
    mockQuery.mockReturnValue(q);

    const order: string[] = [];
    const handlers: TapHandlers = {
      assistant: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("handler");
      },
    };

    for await (const msg of tappedQuery({ prompt: "test" }, handlers, { awaitCallbacks: true })) {
      if ((msg as any).type === "assistant") {
        order.push("yield");
      }
    }

    // With awaitCallbacks, handler completes before yield
    expect(order).toEqual(["handler", "yield"]);
  });

  it("fires and forgets async handlers when awaitCallbacks is false", async () => {
    const q = fakeQuery([makeAssistant("hello")]);
    mockQuery.mockReturnValue(q);

    const order: string[] = [];
    const handlers: TapHandlers = {
      assistant: async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push("handler");
      },
    };

    for await (const msg of tappedQuery({ prompt: "test" }, handlers, { awaitCallbacks: false })) {
      if ((msg as any).type === "assistant") {
        order.push("yield");
      }
    }

    // With fire-and-forget, yield happens before handler completes
    expect(order).toEqual(["yield"]);

    // Wait for the handler to complete
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual(["yield", "handler"]);
  });
});

describe("proxy delegates Query control methods", () => {
  it("delegates interrupt() to the underlying query", async () => {
    const q = fakeQuery([makeSystemInit(), makeResult()]);
    mockQuery.mockReturnValue(q);

    const tapped = tappedQuery({ prompt: "test" }, {});
    await tapped.interrupt();

    expect(q.interrupt).toHaveBeenCalledOnce();
  });

  it("delegates close() to the underlying query", async () => {
    const q = fakeQuery([makeSystemInit(), makeResult()]);
    mockQuery.mockReturnValue(q);

    const tapped = tappedQuery({ prompt: "test" }, {});
    tapped.close();

    expect(q.close).toHaveBeenCalledOnce();
  });
});

describe("realistic multi-turn conversation", () => {
  it("taps all messages in a typical init → user → assistant → result flow", async () => {
    const init = makeSystemInit();
    const user1 = makeUser("What is 2+2?");
    const assistant1 = makeAssistant("4");
    const result = makeResult();

    // SDK emits: init, user (replayed), assistant, result
    const q = fakeQuery([init, user1, assistant1, result]);
    mockQuery.mockReturnValue(q);

    const seen: string[] = [];
    const handlers: TapHandlers = {
      "tap:query_params": () => seen.push("tap:query_params"),
      "system:init": () => seen.push("system:init"),
      user: () => seen.push("user"),
      assistant: () => seen.push("assistant"),
      result: () => seen.push("result"),
    };

    const messages = await collect(
      tappedQuery({ prompt: "What is 2+2?" }, handlers, { awaitCallbacks: true }),
    );

    expect(messages).toHaveLength(5);
    expect(seen).toEqual([
      "tap:query_params",
      "system:init",
      "user",
      "assistant",
      "result",
    ]);
  });

  it("taps user messages from both initial prompt and streamInput", async () => {
    const init = makeSystemInit();
    const assistant1 = makeAssistant("Hello!");
    const result = makeResult();

    const q = fakeQuery([init, assistant1, result]);
    mockQuery.mockReturnValue(q);

    const userMessages: SDKUserMessage[] = [];
    const userHandler = vi.fn((msg: SDKUserMessage) => userMessages.push(msg));

    const initialMsg = makeUser("Hello");
    async function* initialInput(): AsyncIterable<SDKUserMessage> {
      yield initialMsg;
    }

    const tapped = tappedQuery(
      { prompt: initialInput() },
      { user: userHandler },
      { awaitCallbacks: true },
    );

    // Simulate the SDK consuming the initial prompt
    await drainMockPrompt();

    // Now send a follow-up via streamInput (mock self-drains)
    const followUp = makeUser("Follow up");
    async function* followUpInput(): AsyncIterable<SDKUserMessage> {
      yield followUp;
    }
    await tapped.streamInput(followUpInput());

    // Both user messages should have been tapped
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toBe(initialMsg);
    expect(userMessages[1]).toBe(followUp);
  });
});

describe("session ID tracking and backfill", () => {
  it("buffers user message until system:init provides session_id, then backfills", async () => {
    const user1: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] } as any,
      parent_tool_use_id: null,
      session_id: "", // empty — will be buffered and backfilled
    };
    const init = makeSystemInit(); // has session_id = SESSION
    const assistant = makeAssistant("Hi");
    const result = makeResult();

    // SDK emits: user (empty session_id), init (has session_id), assistant, result
    const q = fakeQuery([user1, init, assistant, result]);
    mockQuery.mockReturnValue(q);

    const messages = await collect(tappedQuery({ prompt: "hello" }, {}));

    // user1 was buffered until init arrived, then backfilled
    expect((messages[1] as any).session_id).toBe(SESSION);
    // assistant (after init) also has the session_id
    expect((messages[3] as any).session_id).toBe(SESSION);
  });

  it("backfills session_id on messages after system:init", async () => {
    const init = makeSystemInit(); // session_id = SESSION
    const userNoSession: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] } as any,
      parent_tool_use_id: null,
      session_id: "", // empty — should be backfilled after init
    };
    const result = makeResult();

    const q = fakeQuery([init, userNoSession, result]);
    mockQuery.mockReturnValue(q);

    const messages = await collect(tappedQuery({ prompt: "hello" }, {}));

    // init has session_id, user comes after → should be backfilled
    expect((messages[2] as any).session_id).toBe(SESSION);
  });

  it("exposes sessionId on TappedQuery after stream starts", async () => {
    const init = makeSystemInit();
    const result = makeResult();
    const q = fakeQuery([init, result]);
    mockQuery.mockReturnValue(q);

    const tapped = tappedQuery({ prompt: "test" }, {});

    // Before consuming, sessionId may be undefined
    expect(tapped.sessionId).toBeUndefined();

    await collect(tapped);

    // After consuming, sessionId should be set from system:init
    expect(tapped.sessionId).toBe(SESSION);
  });

  it("seeds sessionId from options.sessionId via tap:query_params", async () => {
    const result = makeResult();
    const q = fakeQuery([result]);
    mockQuery.mockReturnValue(q);

    const tapped = tappedQuery(
      { prompt: "test", options: { sessionId: "pre-seeded-id" } },
      {},
    );

    // Should be seeded immediately from options
    expect(tapped.sessionId).toBe("pre-seeded-id");
  });

  it("seeds sessionId from options.resume", async () => {
    const result = makeResult();
    const q = fakeQuery([result]);
    mockQuery.mockReturnValue(q);

    const tapped = tappedQuery(
      { prompt: "test", options: { resume: "resumed-session-id" } },
      {},
    );

    expect(tapped.sessionId).toBe("resumed-session-id");
  });

  it("updates seeded sessionId when system:init provides the real one", async () => {
    const init = makeSystemInit(); // session_id = SESSION
    const result = makeResult();
    const q = fakeQuery([init, result]);
    mockQuery.mockReturnValue(q);

    const tapped = tappedQuery(
      { prompt: "test", options: { resume: "old-session" } },
      {},
    );

    expect(tapped.sessionId).toBe("old-session");
    await collect(tapped);
    expect(tapped.sessionId).toBe(SESSION);
  });

  it("handlers see the backfilled session_id", async () => {
    const init = makeSystemInit();
    const userNoSession: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] } as any,
      parent_tool_use_id: null,
      session_id: "",
    };
    const result = makeResult();

    const q = fakeQuery([init, userNoSession, result]);
    mockQuery.mockReturnValue(q);

    let capturedSessionId = "";
    const handlers: TapHandlers = {
      user: (msg) => {
        capturedSessionId = (msg as any).session_id;
      },
    };

    await collect(tappedQuery({ prompt: "test" }, handlers, { awaitCallbacks: true }));

    expect(capturedSessionId).toBe(SESSION);
  });
});

describe("tap:query_params captures options correctly", () => {
  it("captures all provided options", async () => {
    const q = fakeQuery([makeResult()]);
    mockQuery.mockReturnValue(q);

    const messages = await collect(
      tappedQuery(
        {
          prompt: "test",
          options: {
            model: "claude-opus-4-20250514",
            systemPrompt: "You are a helpful assistant",
            maxTurns: 5,
            maxBudgetUsd: 1.0,
            permissionMode: "bypassPermissions" as any,
            cwd: "/home/user",
            mcpServers: {
              "my-server": { type: "stdio", command: "node", args: ["server.js"] } as any,
            },
          },
        },
        {},
      ),
    );

    expect(messages[0]).toMatchObject({
      type: "tap:query_params",
      prompt: "test",
      model: "claude-opus-4-20250514",
      systemPrompt: "You are a helpful assistant",
      maxTurns: 5,
      maxBudgetUsd: 1.0,
      permissionMode: "bypassPermissions",
      cwd: "/home/user",
      mcpServers: ["my-server"],
    });
  });

  it("has a valid ISO timestamp", async () => {
    const q = fakeQuery([makeResult()]);
    mockQuery.mockReturnValue(q);

    const messages = await collect(tappedQuery({ prompt: "test" }, {}));

    const ts = (messages[0] as any).timestamp;
    expect(ts).toBeDefined();
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});

describe("sidecar session ID scenario (from docker logs)", () => {
  /**
   * Reproduces the exact message sequence observed in mini-infra-agent-sidecar logs:
   *
   *   1. tap:query_params  — no sessionId (not passed in options)
   *   2. user              — session_id: "" (empty, SDK hasn't assigned yet)
   *   3. system:init       — session_id: "dd6cd52a-..." (real ID assigned by SDK)
   *   4. stream_event(s)   — session_id: "dd6cd52a-..."
   *   5. assistant         — session_id: "dd6cd52a-..."
   *   6. result            — session_id: "dd6cd52a-..."
   *
   * The library should:
   *   - Buffer messages with empty session_id until one is captured
   *   - Capture the session_id from system:init
   *   - Backfill buffered messages and release them with the correct session_id
   *   - Backfill any later messages that are also missing a session_id
   *   - Expose tappedQuery.sessionId for the consumer
   */
  const REAL_SESSION = "dd6cd52a-dee8-4f3b-aea3-c342c52435f1";

  function makeSidecarMessages(): SDKMessage[] {
    const user: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: "hello" } as any,
      parent_tool_use_id: null,
      session_id: "", // empty — the problem
    };

    const init: SDKSystemMessage = {
      type: "system",
      subtype: "init",
      apiKeySource: "ANTHROPIC_API_KEY" as any,
      betas: [],
      claude_code_version: "2.1.83",
      cwd: "/tmp/agent-work",
      tools: ["Bash", "Glob", "Grep", "Read"],
      mcp_servers: [
        { name: "mini-infra-infra", status: "connected" },
        { name: "mini-infra-ui", status: "connected" },
      ] as any,
      model: "claude-sonnet-4-6",
      permissionMode: "default" as any,
      slash_commands: [],
      output_style: "default",
      skills: [],
      uuid: "b5785490-c05b-4cc2-b821-a45e14b5d0ce" as any,
      session_id: REAL_SESSION,
    };

    const streamStart: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      } as any,
      session_id: REAL_SESSION,
      parent_tool_use_id: null,
      uuid: "338d6479-4713-45cf-89a9-535dd36b8766" as any,
    };

    const assistant: SDKAssistantMessage = {
      type: "assistant",
      message: {
        id: "msg_01DmqZuVU9PAKyzDTyMzAqJp",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello! I'm your Mini Infra operations assistant." }],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          cache_creation_input_tokens: 9429,
          cache_read_input_tokens: 0,
        },
      } as any,
      parent_tool_use_id: null,
      session_id: REAL_SESSION,
      uuid: "ffa8890b-c05b-4cc2-b821-a45e14b5d0ce" as any,
    };

    const result: SDKResultSuccess = {
      type: "result",
      subtype: "success",
      duration_ms: 5140,
      duration_api_ms: 5130,
      is_error: false,
      num_turns: 1,
      result: "Hello! I'm your Mini Infra operations assistant.",
      stop_reason: "end_turn",
      total_cost_usd: 0.03841275,
      usage: { input_tokens: 3, output_tokens: 203 } as any,
      modelUsage: {},
      permission_denials: [],
      session_id: REAL_SESSION,
      uuid: "bd5c080e-362a-4d94-956a-e4dfe1597a60" as any,
    };

    return [user, init, streamStart, assistant, result];
  }

  it("captures session_id from system:init and backfills later messages", async () => {
    const sdkMessages = makeSidecarMessages();
    const q = fakeQuery(sdkMessages);
    mockQuery.mockReturnValue(q);

    const sessionIds: Record<string, string> = {};
    const tapped = tappedQuery(
      {
        prompt: "hello",
        options: {
          model: "claude-sonnet-4-6",
          systemPrompt: "You are an AI operations assistant...",
          cwd: "/tmp/agent-work",
          thinking: { type: "adaptive" } as any,
          effort: "medium" as any,
          tools: ["Bash", "Read", "Glob", "Grep"] as any,
          includePartialMessages: true,
        },
      },
      {
        "tap:query_params": (msg) => {
          sessionIds["tap:query_params"] = msg.sessionId ?? "(undefined)";
        },
        user: (msg) => {
          sessionIds["user"] = (msg as any).session_id;
        },
        "system:init": (msg) => {
          sessionIds["system:init"] = msg.session_id;
        },
        stream_event: (msg) => {
          sessionIds["stream_event"] = (msg as any).session_id;
        },
        assistant: (msg) => {
          sessionIds["assistant"] = msg.session_id;
        },
        result: (msg) => {
          sessionIds["result"] = (msg as any).session_id;
        },
      },
      { awaitCallbacks: true },
    );

    // Before consuming: no sessionId (not passed in options)
    expect(tapped.sessionId).toBeUndefined();

    const messages = await collect(tapped);

    // After consuming: sessionId captured from system:init
    expect(tapped.sessionId).toBe(REAL_SESSION);

    // tap:query_params had no sessionId in options
    expect(sessionIds["tap:query_params"]).toBe("(undefined)");

    // user message was buffered and backfilled with session_id from system:init
    expect(sessionIds["user"]).toBe(REAL_SESSION);

    // system:init is where the real session_id first appears
    expect(sessionIds["system:init"]).toBe(REAL_SESSION);

    // All messages after system:init retain their session_id
    expect(sessionIds["stream_event"]).toBe(REAL_SESSION);
    expect(sessionIds["assistant"]).toBe(REAL_SESSION);
    expect(sessionIds["result"]).toBe(REAL_SESSION);

    // 6 total: tap:query_params + 5 SDK messages
    expect(messages).toHaveLength(6);
  });

  it("buffered user message is emitted after the message that provides session_id", async () => {
    const sdkMessages = makeSidecarMessages();
    const q = fakeQuery(sdkMessages);
    mockQuery.mockReturnValue(q);

    const tapped = tappedQuery(
      { prompt: "hello", options: { model: "claude-sonnet-4-6" } },
      {},
      { awaitCallbacks: true },
    );

    const messages = await collect(tapped);

    // tap:query_params is first
    expect(messages[0]).toMatchObject({ type: "tap:query_params" });

    // Buffered user message is flushed (backfilled) before the message
    // that provided the session_id, preserving original stream order
    expect(messages[1]).toMatchObject({ type: "user" });
    expect((messages[1] as any).session_id).toBe(REAL_SESSION);

    // system:init follows (it's the one that provided the session_id)
    expect(messages[2]).toMatchObject({ type: "system", subtype: "init" });

    // Remaining messages follow in original order
    expect(messages[3]).toMatchObject({ type: "stream_event" });
    expect(messages[4]).toMatchObject({ type: "assistant" });
    expect(messages[5]).toMatchObject({ type: "result" });
  });

  it("backfills if a second user message arrives after system:init with empty session_id", async () => {
    // Simulates a multi-turn conversation where a follow-up user message
    // also has an empty session_id (e.g., streamed in via the sidecar)
    const [user1, init, streamEvt, assistant1, result1] = makeSidecarMessages();

    const user2: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: "list containers" } as any,
      parent_tool_use_id: null,
      session_id: "", // empty again
    };

    const assistant2: SDKAssistantMessage = {
      type: "assistant",
      message: {
        id: "msg_02",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Here are your containers..." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      } as any,
      parent_tool_use_id: null,
      session_id: REAL_SESSION,
      uuid: "uuid-assistant-2" as any,
    };

    const q = fakeQuery([user1, init, streamEvt, assistant1, user2, assistant2]);
    mockQuery.mockReturnValue(q);

    const userSessionIds: string[] = [];
    const tapped = tappedQuery(
      { prompt: "hello", options: { model: "claude-sonnet-4-6" } },
      {
        user: (msg) => {
          userSessionIds.push((msg as any).session_id);
        },
      },
      { awaitCallbacks: true },
    );

    await collect(tapped);

    // First user message: buffered until system:init, then backfilled
    expect(userSessionIds[0]).toBe(REAL_SESSION);
    // Second user message: after system:init → also backfilled
    expect(userSessionIds[1]).toBe(REAL_SESSION);

    expect(tapped.sessionId).toBe(REAL_SESSION);
  });
});
