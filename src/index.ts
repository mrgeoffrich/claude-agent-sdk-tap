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

// ── Core ─────────────────────────────────────────────────────────────

/**
 * Wraps an SDKMessage async iterable, calling strongly-typed handlers
 * for each message type without modifying the stream.
 *
 * @param source - Any AsyncIterable<SDKMessage> (from query(), instrumentedQuery(), etc.)
 * @param handlers - Per-type callbacks. System subtypes use "system:<subtype>" keys.
 * @param options - Catch-all, error handling, and await behavior.
 * @param queryParamsMessage - When provided, emitted before the real stream begins.
 * @returns An AsyncGenerator that yields a synthetic query_params message (if provided) followed by every SDK message unchanged.
 */
export async function* tap(
  source: AsyncIterable<SDKMessage>,
  handlers: TapHandlers = {},
  options: TapOptions = {},
  queryParamsMessage?: TapQueryParamsMessage,
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

  for await (const message of source) {
    // 1. Catch-all
    if (onMessage) {
      await invokeCallback(onMessage, message, message, onError, awaitCallbacks);
    }

    // 2. Type-specific handler
    const handler = resolveHandler(message, handlers);
    if (handler) {
      await invokeCallback(handler, message, message, onError, awaitCallbacks);
    }

    // 3. Yield unchanged
    yield message;
  }
}

/**
 * Convenience: calls query() and taps the stream in one call.
 *
 * Emits a synthetic `tap:query_params` message before the real stream begins,
 * surfacing the query parameters (prompt, system prompt, model, etc.) that
 * are otherwise invisible in the SDK output stream.
 */
export function tappedQuery(
  params: QueryParams,
  handlers: TapHandlers = {},
  options: TapOptions = {},
): AsyncGenerator<TapMessage> {
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
  return tap(query(params), handlers, options, queryParamsMessage);
}

// ── Internals ────────────────────────────────────────────────────────

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

export { query } from "@anthropic-ai/claude-agent-sdk";
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultSuccess,
  SDKResultError,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKAuthStatusMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
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
  SDKAssistantMessageError,
  SDKPermissionDenial,
  SDKStatus,
  SDKSessionInfo,
  Options,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
