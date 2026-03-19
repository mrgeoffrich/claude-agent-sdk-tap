# claude-agent-sdk-tap

Transparent tap/observer for the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) message stream. Calls strongly-typed callbacks for each message type without modifying the stream — useful for diagnostics, debugging, logging, and forwarding messages to a collection server.

## Install

```bash
npm install @mrgeoffrich/claude-agent-sdk-tap
```

Requires `@anthropic-ai/claude-agent-sdk` >=0.2.0 as a peer dependency.

## Forward all messages to your server

The simplest way to use this library is to forward every SDK message to an HTTP endpoint. Three steps:

1. Create a sink pointed at your server
2. Pass it as `onMessage` when you call the SDK
3. Call `flush()` when you're done to make sure everything is sent

```ts
import { tappedQuery } from "@mrgeoffrich/claude-agent-sdk-tap";
import { createHttpSink } from "@mrgeoffrich/claude-agent-sdk-tap/transport";

// 1. Point the sink at your server
const sink = createHttpSink("http://localhost:8080/messages");

// 2. Use tappedQuery instead of query — every message gets POSTed to your server
for await (const msg of tappedQuery(
  { prompt: "Hello", options: {} },
  {},
  { onMessage: sink.send },
)) {
  // your app logic here — messages pass through unchanged
}

// 3. Flush to ensure nothing is lost
await sink.flush();
```

Your server receives a JSON POST for each message with this shape:

```json
{
  "sequence": 1,
  "timestamp": "2026-03-19T08:00:00.000Z",
  "type": "assistant",
  "subtype": null,
  "session_id": "abc-123",
  "uuid": "msg-456",
  "message": { /* the raw SDK message */ }
}
```

That's it. Every message the SDK produces — assistant responses, tool calls, system events, results — gets forwarded to your endpoint in real time.

## Quick start — typed callbacks

If you don't need to forward messages and just want to react to specific message types locally:

```ts
import { tappedQuery } from "@mrgeoffrich/claude-agent-sdk-tap";

for await (const msg of tappedQuery(
  { prompt: "Hello", options: {} },
  {
    assistant: (msg) => console.log("model:", msg.message.model),
    result: (msg) => console.log("cost:", msg.total_cost_usd),
    "system:init": (msg) => console.log("tools:", msg.tools),
  },
)) {
  // messages pass through unchanged
}
```

You can also combine both — use typed handlers for local logging while forwarding everything to your server. See [Combining handlers and sinks](#combining-handlers-and-sinks) below.

## API

### `tap(source, handlers?, options?)`

Wraps any `AsyncIterable<SDKMessage>` (from `query()`, or any other source) and calls handlers for each message type. Returns an `AsyncGenerator<SDKMessage>` that yields every message unchanged.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tap } from "@mrgeoffrich/claude-agent-sdk-tap";

const stream = query({ prompt: "Hello", options: {} });

for await (const msg of tap(stream, {
  assistant: (msg) => console.log(msg.message.content),
  stream_event: (msg) => process.stdout.write("."),
})) {
  // process messages as normal
}
```

### `tappedQuery(params, handlers?, options?)`

Convenience function that calls `query()` and `tap()` in one step. Equivalent to `tap(query(params), handlers, options)`.

### Handlers

All handlers are optional. Non-system messages use their `type` field as the key. System messages use `system:<subtype>` to disambiguate.

```ts
interface TapHandlers {
  // Non-system types
  assistant?: TapCallback<SDKAssistantMessage>;
  user?: TapCallback<SDKUserMessage | SDKUserMessageReplay>;
  result?: TapCallback<SDKResultSuccess | SDKResultError>;
  stream_event?: TapCallback<SDKPartialAssistantMessage>;
  tool_progress?: TapCallback<SDKToolProgressMessage>;
  tool_use_summary?: TapCallback<SDKToolUseSummaryMessage>;
  auth_status?: TapCallback<SDKAuthStatusMessage>;
  rate_limit_event?: TapCallback<SDKRateLimitEvent>;
  prompt_suggestion?: TapCallback<SDKPromptSuggestionMessage>;

  // System subtypes
  "system:init"?: TapCallback<SDKSystemMessage>;
  "system:api_retry"?: TapCallback<SDKAPIRetryMessage>;
  "system:compact_boundary"?: TapCallback<SDKCompactBoundaryMessage>;
  "system:status"?: TapCallback<SDKStatusMessage>;
  "system:hook_started"?: TapCallback<SDKHookStartedMessage>;
  "system:hook_progress"?: TapCallback<SDKHookProgressMessage>;
  "system:hook_response"?: TapCallback<SDKHookResponseMessage>;
  "system:task_started"?: TapCallback<SDKTaskStartedMessage>;
  "system:task_progress"?: TapCallback<SDKTaskProgressMessage>;
  "system:task_notification"?: TapCallback<SDKTaskNotificationMessage>;
  "system:local_command_output"?: TapCallback<SDKLocalCommandOutputMessage>;
  "system:files_persisted"?: TapCallback<SDKFilesPersistedEvent>;
  "system:elicitation_complete"?: TapCallback<SDKElicitationCompleteMessage>;
}
```

### Options

```ts
interface TapOptions {
  /** Called for every message before the specific handler. */
  onMessage?: TapCallback<SDKMessage>;

  /** Called when a handler throws. Defaults to swallowing errors silently. */
  onError?: (error: unknown, message: SDKMessage) => void;

  /** When true, async callbacks are awaited before yielding. Default: false. */
  awaitCallbacks?: boolean;
}
```

## Transport sinks

The `transport` module provides ready-made sinks for forwarding messages to a collection server over HTTP or gRPC.

### HTTP sink

Zero additional dependencies. Supports batching.

```ts
import { tappedQuery } from "@mrgeoffrich/claude-agent-sdk-tap";
import { createHttpSink } from "@mrgeoffrich/claude-agent-sdk-tap/transport";

const sink = createHttpSink("http://localhost:8080/messages");

for await (const msg of tappedQuery(
  { prompt: "Hello", options: {} },
  {},
  { onMessage: sink.send },
)) {
  // process as normal
}

await sink.flush(); // ensure all messages are sent
```

#### HTTP sink options

```ts
createHttpSink(url, {
  headers: { Authorization: "Bearer ..." },  // extra headers
  batchSize: 10,        // buffer up to N messages before sending (default: 1)
  flushIntervalMs: 500, // flush partial batches after this delay (default: 1000)
  onError: (err) => {},  // error handler (default: console.error)
});
```

When `batchSize` is 1 (default), each message is POSTed individually as a JSON object. When `batchSize > 1`, messages are POSTed as a JSON array.

### gRPC sink

Requires `@grpc/grpc-js` as a peer dependency (optional — only needed if you use gRPC).

```bash
npm install @grpc/grpc-js
```

```ts
import { tappedQuery } from "@mrgeoffrich/claude-agent-sdk-tap";
import { createGrpcSink } from "@mrgeoffrich/claude-agent-sdk-tap/transport";

const sink = await createGrpcSink("localhost:50051");

for await (const msg of tappedQuery(
  { prompt: "Hello", options: {} },
  {},
  { onMessage: sink.send },
)) {
  // process as normal
}

await sink.flush(); // end stream and close connection
```

The gRPC sink streams messages over a client-side streaming call. Your server should implement:

```protobuf
service AgentMessages {
  rpc StreamMessages (stream MessageEnvelope) returns (Ack);
}
```

### Message envelope

Both sinks wrap each message in an envelope:

```ts
interface MessageEnvelope {
  sequence: number;       // monotonically increasing per sink
  timestamp: string;      // ISO-8601
  type: string;           // e.g. "assistant", "system", "result"
  subtype: string | null; // e.g. "init", "api_retry" (system messages only)
  session_id: string;
  uuid: string;
  message: SDKMessage;    // the raw message, unmodified
}
```

## Combining handlers and sinks

You can use typed handlers for local processing while simultaneously forwarding everything to a collection server:

```ts
import { tappedQuery } from "@mrgeoffrich/claude-agent-sdk-tap";
import { createHttpSink } from "@mrgeoffrich/claude-agent-sdk-tap/transport";

const sink = createHttpSink("http://collector:8080/messages", {
  batchSize: 20,
  flushIntervalMs: 2000,
});

for await (const msg of tappedQuery(
  { prompt: "Analyze this codebase", options: {} },
  {
    assistant: (msg) => console.log(`[${msg.message.model}]`, msg.message.content),
    result: (msg) => {
      if (msg.type === "result" && "total_cost_usd" in msg) {
        console.log(`Done. Cost: $${msg.total_cost_usd}`);
      }
    },
    "system:init": (msg) => console.log(`Session started with ${msg.tools.length} tools`),
  },
  { onMessage: sink.send },
)) {
  // your app logic here
}

await sink.flush();
```

## Re-exports

For convenience, this package re-exports `query` and all SDK message types from `@anthropic-ai/claude-agent-sdk`, so you can import everything from one place:

```ts
import { tappedQuery, query, type SDKMessage } from "@mrgeoffrich/claude-agent-sdk-tap";
```

## License

MIT
