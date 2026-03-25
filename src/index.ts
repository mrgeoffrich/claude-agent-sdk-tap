/**
 * Transparent tap/observer for the Claude Agent SDK message stream.
 *
 * Wraps any `AsyncIterable<SDKMessage>` and calls strongly-typed callbacks
 * for each message type. Messages pass through unchanged — no reassembly,
 * no buffering, no processing. The consumer decides what to do.
 *
 * @example
 * ```ts
 * import { tappedQuery } from "@mrgeoffrich/claude-agent-sdk-tap";
 *
 * for await (const msg of tappedQuery(
 *   { prompt: "Hello", options: {} },
 *   {
 *     assistant: (msg) => console.log("model:", msg.message.model),
 *     stream_event: (msg) => process.stdout.write("."),
 *     result: (msg) => console.log("cost:", msg.total_cost_usd),
 *     "system:init": (msg) => console.log("tools:", msg.tools),
 *   },
 * )) {
 *   // messages pass through unchanged
 * }
 * ```
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultSuccess,
  SDKResultError,
  SDKPartialAssistantMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKAuthStatusMessage,
  SDKRateLimitEvent,
  SDKPromptSuggestionMessage,
  SDKSystemMessage,
  SDKAPIRetryMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKTaskNotificationMessage,
  SDKLocalCommandOutputMessage,
  SDKFilesPersistedEvent,
  SDKElicitationCompleteMessage,
  Options,
  Query,
} from "@anthropic-ai/claude-agent-sdk";

// ── Types ────────────────────────────────────────────────────────────

type QueryParams = Parameters<typeof query>[0];

/** Union of all messages the tap can yield: real SDK messages + synthetic tap messages. */
export type TapMessage = SDKMessage | TapQueryParamsMessage;

/**
 * Synthetic message emitted by `tappedQuery` before the real stream begins.
 * Surfaces the query parameters (prompt, system prompt, model, etc.) that are
 * otherwise invisible in the SDK output stream.
 *
 * Discriminated by `type: "tap:query_params"`.
 */
export interface TapQueryParamsMessage {
  type: "tap:query_params";
  /** The user prompt passed to query(). Undefined when prompt is an AsyncIterable. */
  prompt?: string;
  /** System prompt configuration. */
  systemPrompt?: Options["systemPrompt"];
  /** Model identifier. */
  model?: string;
  /** Working directory. */
  cwd?: string;
  /** Permission mode. */
  permissionMode?: Options["permissionMode"];
  /** Maximum conversation turns. */
  maxTurns?: number;
  /** Maximum budget in USD. */
  maxBudgetUsd?: number;
  /** Thinking/reasoning configuration. */
  thinking?: Options["thinking"];
  /** Effort level. */
  effort?: Options["effort"];
  /** Agent name for the main thread. */
  agent?: string;
  /** Agent definitions. */
  agents?: Options["agents"];
  /** Tools configuration. */
  tools?: Options["tools"];
  /** Auto-allowed tool names. */
  allowedTools?: string[];
  /** Disallowed tool names. */
  disallowedTools?: string[];
  /** MCP server configurations (names only — configs may contain secrets). */
  mcpServers?: string[];
  /** Plugin configurations. */
  plugins?: Options["plugins"];
  /** Output format configuration. */
  outputFormat?: Options["outputFormat"];
  /** Whether continuing a previous session. */
  continue?: boolean;
  /** Session ID being resumed. */
  resume?: string;
  /** Specific session ID. */
  sessionId?: string;
  /** Beta features enabled. */
  betas?: Options["betas"];
  /** Whether partial/streaming messages are included. */
  includePartialMessages?: boolean;
  /** Whether prompt suggestions are enabled. */
  promptSuggestions?: boolean;
  /** Additional directories. */
  additionalDirectories?: string[];
  /** Setting sources loaded. */
  settingSources?: Options["settingSources"];
  /** ISO timestamp when the message was created. */
  timestamp: string;
}

/** A callback that receives a strongly-typed message. May be sync or async. */
export type TapCallback<T> = (message: T) => void | Promise<void>;

/**
 * Per-type handlers. Each key maps to exactly one narrowed message type.
 *
 * Non-system messages use their `type` field as key.
 * System messages use `system:<subtype>` to disambiguate.
 *
 * All handlers are optional.
 */
export interface TapHandlers {
  // ── Tap synthetic types ──
  "tap:query_params"?: TapCallback<TapQueryParamsMessage>;

  // ── Non-system types ──
  assistant?: TapCallback<SDKAssistantMessage>;
  user?: TapCallback<SDKUserMessage | SDKUserMessageReplay>;
  result?: TapCallback<SDKResultSuccess | SDKResultError>;
  stream_event?: TapCallback<SDKPartialAssistantMessage>;
  tool_progress?: TapCallback<SDKToolProgressMessage>;
  tool_use_summary?: TapCallback<SDKToolUseSummaryMessage>;
  auth_status?: TapCallback<SDKAuthStatusMessage>;
  rate_limit_event?: TapCallback<SDKRateLimitEvent>;
  prompt_suggestion?: TapCallback<SDKPromptSuggestionMessage>;

  // ── System subtypes ──
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

export interface TapOptions {
  /**
   * Called for every message before the specific handler.
   * Useful for logging or forwarding all messages to another system.
   */
  onMessage?: TapCallback<TapMessage>;

  /**
   * Called when a handler throws. If not provided, errors are silently
   * swallowed. The stream is never interrupted by a bad callback.
   */
  onError?: (error: unknown, message: TapMessage) => void;

  /**
   * When true, async callbacks are awaited before yielding the message.
   * Default: false (fire-and-forget).
   */
  awaitCallbacks?: boolean;
}

/**
 * A tapped query that yields TapMessage and exposes all Query control methods.
 *
 * Created by `tappedQuery()`. Iterate with `for await` to receive tapped
 * messages. Call control methods (interrupt, streamInput, close, etc.)
 * directly on the object — they delegate to the underlying Query.
 *
 * When using streaming input (prompt as AsyncIterable or via streamInput()),
 * outgoing user messages are tapped through handlers before being forwarded.
 */
export type TappedQuery = AsyncGenerator<TapMessage, void> & {
  [K in Exclude<keyof Query, keyof AsyncGenerator<any, any>>]: Query[K];
} & {
  /** The session ID captured from the stream. Updated as messages arrive. */
  readonly sessionId: string | undefined;
};

// ── Core ─────────────────────────────────────────────────────────────

/** Shared session-ID state mutated by the tap generator and read via the proxy. */
interface SessionIdHolder {
  value: string | undefined;
}

async function* tap(
  source: AsyncIterable<SDKMessage>,
  handlers: TapHandlers = {},
  options: TapOptions = {},
  queryParamsMessage?: TapQueryParamsMessage,
  sessionIdHolder?: SessionIdHolder,
): AsyncGenerator<TapMessage> {
  const { onMessage, onError, awaitCallbacks = false } = options;

  // Emit synthetic query params message before the real stream
  if (queryParamsMessage) {
    if (onMessage) {
      await invokeCallback(onMessage, queryParamsMessage, queryParamsMessage, onError, awaitCallbacks);
    }
    const handler = handlers["tap:query_params"];
    if (handler) {
      await invokeCallback(handler, queryParamsMessage, queryParamsMessage, onError, awaitCallbacks);
    }
    yield queryParamsMessage;
  }

  // Buffer messages that arrive before a session_id is known.
  // Once a message with a real session_id arrives, backfill and flush.
  const pendingBuffer: SDKMessage[] = [];

  for await (const message of source) {
    if (sessionIdHolder) {
      const sid = (message as any).session_id;
      if (typeof sid === "string" && sid !== "") {
        // Captured a real session_id — update the holder
        sessionIdHolder.value = sid;

        // Flush any buffered messages with the now-known session_id
        for (const buffered of pendingBuffer) {
          (buffered as any).session_id = sessionIdHolder.value;
          yield* emitMessage(buffered, handlers, onMessage, onError, awaitCallbacks);
        }
        pendingBuffer.length = 0;
      } else if (!sessionIdHolder.value && "session_id" in message) {
        // No session_id yet — buffer this message
        pendingBuffer.push(message);
        continue;
      } else if (sessionIdHolder.value && "session_id" in message) {
        // We have a session_id and this message is missing one — backfill
        (message as any).session_id = sessionIdHolder.value;
      }
    }

    yield* emitMessage(message, handlers, onMessage, onError, awaitCallbacks);
  }

  // If the stream ends without ever providing a session_id, flush remaining
  // buffered messages as-is so they aren't silently swallowed.
  for (const buffered of pendingBuffer) {
    yield* emitMessage(buffered, handlers, onMessage, onError, awaitCallbacks);
  }
}

/**
 * Convenience: calls query() and taps the stream in one call.
 *
 * Returns a `TappedQuery` — an async iterable of tapped messages that also
 * exposes all `Query` control methods (interrupt, streamInput, close, etc.).
 *
 * When the prompt is an `AsyncIterable<SDKUserMessage>` (streaming input mode),
 * outgoing user messages are tapped through handlers before being forwarded to
 * the SDK. The same applies to messages sent via `streamInput()`.
 *
 * Emits a synthetic `tap:query_params` message before the real stream begins,
 * surfacing the query parameters (prompt, system prompt, model, etc.) that
 * are otherwise invisible in the SDK output stream.
 */
export function tappedQuery(
  params: QueryParams,
  handlers: TapHandlers = {},
  options: TapOptions = {},
): TappedQuery {
  const opts = params.options;

  const queryParamsMessage: TapQueryParamsMessage = {
    type: "tap:query_params",
    prompt: typeof params.prompt === "string" ? params.prompt : undefined,
    systemPrompt: opts?.systemPrompt,
    model: opts?.model,
    cwd: opts?.cwd,
    permissionMode: opts?.permissionMode,
    maxTurns: opts?.maxTurns,
    maxBudgetUsd: opts?.maxBudgetUsd,
    thinking: opts?.thinking,
    effort: opts?.effort,
    agent: opts?.agent,
    agents: opts?.agents,
    tools: opts?.tools,
    allowedTools: opts?.allowedTools,
    disallowedTools: opts?.disallowedTools,
    mcpServers: opts?.mcpServers ? Object.keys(opts.mcpServers) : undefined,
    plugins: opts?.plugins,
    outputFormat: opts?.outputFormat,
    continue: opts?.continue,
    resume: opts?.resume,
    sessionId: opts?.sessionId,
    betas: opts?.betas,
    includePartialMessages: opts?.includePartialMessages,
    promptSuggestions: opts?.promptSuggestions,
    additionalDirectories: opts?.additionalDirectories,
    settingSources: opts?.settingSources,
    timestamp: new Date().toISOString(),
  };

  // Shared mutable holder so the proxy can expose the latest session ID.
  // Created before wrapUserInput so outgoing user messages can be backfilled.
  const sessionIdHolder: SessionIdHolder = {
    value: queryParamsMessage.sessionId ?? queryParamsMessage.resume ?? undefined,
  };

  // Wrap input iterable to tap outgoing user messages
  const wrappedParams =
    typeof params.prompt === "string"
      ? params
      : { ...params, prompt: wrapUserInput(params.prompt, handlers, options, sessionIdHolder) };

  const q = query(wrappedParams);
  const tappedStream = tap(q, handlers, options, queryParamsMessage, sessionIdHolder);

  // Return a proxy that delegates iteration to the tapped stream
  // and control methods to the underlying Query.
  return new Proxy(tappedStream as unknown as TappedQuery, {
    get(_target, prop, _receiver) {
      // Expose the tracked session ID
      if (prop === "sessionId") {
        return sessionIdHolder.value;
      }
      // Wrap streamInput to tap outgoing user messages
      if (prop === "streamInput") {
        return (stream: AsyncIterable<SDKUserMessage>) =>
          q.streamInput(wrapUserInput(stream, handlers, options, sessionIdHolder));
      }
      // AsyncGenerator protocol from tapped stream
      if (
        prop === Symbol.asyncIterator ||
        prop === "next" ||
        prop === "return" ||
        prop === "throw"
      ) {
        const val = Reflect.get(tappedStream, prop, tappedStream);
        return typeof val === "function" ? val.bind(tappedStream) : val;
      }
      // All other Query control methods delegate to the query
      const val = (q as any)[prop];
      if (typeof val === "function") return val.bind(q);
      return val;
    },
  });
}

// ── Internals ────────────────────────────────────────────────────────

/** Run onMessage + type-specific handler, then yield the message. */
async function* emitMessage(
  message: SDKMessage,
  handlers: TapHandlers,
  onMessage: TapOptions["onMessage"],
  onError: TapOptions["onError"],
  awaitCallbacks: boolean,
): AsyncGenerator<SDKMessage> {
  if (onMessage) {
    await invokeCallback(onMessage, message, message, onError, awaitCallbacks);
  }
  const handler = resolveHandler(message, handlers);
  if (handler) {
    await invokeCallback(handler, message, message, onError, awaitCallbacks);
  }
  yield message;
}

/**
 * Wraps an input AsyncIterable<SDKUserMessage> to tap each outgoing user
 * message through the handlers before forwarding it to the SDK.
 *
 * If a sessionIdHolder is provided and the message has an empty session_id,
 * backfills it from the holder (which is populated by the main tap generator
 * when system:init arrives).
 */
async function* wrapUserInput(
  source: AsyncIterable<SDKUserMessage>,
  handlers: TapHandlers,
  options: TapOptions,
  sessionIdHolder?: SessionIdHolder,
): AsyncGenerator<SDKUserMessage> {
  const { onMessage, onError, awaitCallbacks = false } = options;
  for await (const message of source) {
    // Backfill empty session_id from the shared holder
    if (sessionIdHolder?.value && "session_id" in message) {
      const sid = (message as any).session_id;
      if (typeof sid !== "string" || sid === "") {
        (message as any).session_id = sessionIdHolder.value;
      }
    }
    if (onMessage) {
      await invokeCallback(onMessage, message, message, onError, awaitCallbacks);
    }
    const handler = handlers.user;
    if (handler) {
      await invokeCallback(handler, message, message, onError, awaitCallbacks);
    }
    yield message;
  }
}

function resolveHandler(
  message: SDKMessage,
  handlers: TapHandlers,
): TapCallback<any> | undefined {
  if (message.type === "system" && "subtype" in message) {
    const key = `system:${(message as any).subtype}` as keyof TapHandlers;
    return handlers[key] as TapCallback<any> | undefined;
  }
  return handlers[message.type as keyof TapHandlers] as TapCallback<any> | undefined;
}

async function invokeCallback<T>(
  callback: TapCallback<T>,
  value: T,
  originalMessage: TapMessage,
  onError: TapOptions["onError"],
  awaitCallbacks: boolean,
): Promise<void> {
  try {
    const result = callback(value);
    if (result instanceof Promise) {
      if (awaitCallbacks) {
        await result;
      } else {
        result.catch((err) => onError?.(err, originalMessage));
      }
    }
  } catch (err) {
    onError?.(err, originalMessage);
  }
}

// ── Re-exports ───────────────────────────────────────────────────────

export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultSuccess,
  SDKResultError,
  SDKPartialAssistantMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKAuthStatusMessage,
  SDKRateLimitEvent,
  SDKPromptSuggestionMessage,
  SDKSystemMessage,
  SDKAPIRetryMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKTaskNotificationMessage,
  SDKLocalCommandOutputMessage,
  SDKFilesPersistedEvent,
  SDKElicitationCompleteMessage,
  Options,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
