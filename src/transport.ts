/**
 * Transport sinks for forwarding SDK messages over HTTP or gRPC.
 *
 * Each `create*Sink` function returns a `TapCallback<SDKMessage>` that
 * can be plugged straight into `onMessage`.
 *
 * @example
 * ```ts
 * import { tappedQuery } from "@mrgeoffrich/claude-agent-sdk-tap";
 * import { createHttpSink } from "@mrgeoffrich/claude-agent-sdk-tap/transport";
 *
 * const sink = createHttpSink("http://localhost:8080/messages");
 *
 * for await (const msg of tappedQuery(
 *   { prompt: "Hello", options: {} },
 *   {},
 *   { onMessage: sink.send },
 * )) {}
 *
 * await sink.flush();
 * ```
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ── Envelope ─────────────────────────────────────────────────────────

/** Wire format: every message is wrapped in an envelope with metadata. */
export interface MessageEnvelope {
  /** Monotonically increasing per sink instance */
  sequence: number;
  /** ISO-8601 timestamp when the message was observed */
  timestamp: string;
  /** Top-level type (e.g. "assistant", "system", "result") */
  type: string;
  /** System subtype if present (e.g. "init", "api_retry"), otherwise null */
  subtype: string | null;
  /** Session ID from the message */
  session_id: string;
  /** Message UUID */
  uuid: string;
  /** The raw SDKMessage, unmodified */
  message: SDKMessage;
}

function toEnvelope(msg: SDKMessage, sequence: number): MessageEnvelope {
  return {
    sequence,
    timestamp: new Date().toISOString(),
    type: msg.type,
    subtype: "subtype" in msg ? (msg as any).subtype ?? null : null,
    session_id: "session_id" in msg ? (msg as any).session_id : "",
    uuid: "uuid" in msg ? (msg as any).uuid : "",
    message: msg,
  };
}

// ── HTTP Sink ────────────────────────────────────────────────────────

export interface HttpSinkOptions {
  /** HTTP headers to include on every request. */
  headers?: Record<string, string>;
  /**
   * Max messages to buffer before flushing. Default: 1 (send immediately).
   * Set higher for batching.
   */
  batchSize?: number;
  /** Max ms to wait before flushing a partial batch. Default: 1000. Only applies when batchSize > 1. */
  flushIntervalMs?: number;
  /** Called on send errors. Default: console.error. */
  onError?: (error: unknown) => void;
}

export interface HttpSink {
  /** The callback to pass to `onMessage`. */
  send: (message: SDKMessage) => void;
  /** Flush any buffered messages and stop the flush timer. */
  flush: () => Promise<void>;
}

export function createHttpSink(url: string, options: HttpSinkOptions = {}): HttpSink {
  const {
    headers = {},
    batchSize = 1,
    flushIntervalMs = 1000,
    onError = (err) => console.error("[http-sink]", err),
  } = options;

  let sequence = 0;
  let buffer: MessageEnvelope[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let inflightRequests: Promise<void>[] = [];

  function doSend(batch: MessageEnvelope[]): void {
    const body = batchSize === 1 ? JSON.stringify(batch[0]) : JSON.stringify(batch);
    const request = fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      })
      .catch(onError);

    inflightRequests.push(request as Promise<void>);
    // Clean up settled promises
    (request as Promise<void>).finally(() => {
      inflightRequests = inflightRequests.filter((r) => r !== request);
    });
  }

  function flushBuffer(): void {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    doSend(batch);
  }

  // Periodic flush for partial batches
  if (batchSize > 1) {
    flushTimer = setInterval(flushBuffer, flushIntervalMs);
    if (typeof flushTimer === "object" && "unref" in flushTimer) {
      flushTimer.unref();
    }
  }

  return {
    send(message: SDKMessage): void {
      buffer.push(toEnvelope(message, ++sequence));
      if (buffer.length >= batchSize) {
        flushBuffer();
      }
    },

    async flush(): Promise<void> {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      flushBuffer();
      await Promise.all(inflightRequests);
    },
  };
}

// ── gRPC Sink ────────────────────────────────────────────────────────

export interface GrpcSinkOptions {
  /** gRPC metadata (headers) to include on the stream. */
  metadata?: Record<string, string>;
  /** Called on send errors. Default: console.error. */
  onError?: (error: unknown) => void;
}

export interface GrpcSink {
  /** The callback to pass to `onMessage`. */
  send: (message: SDKMessage) => void;
  /** End the gRPC stream and wait for completion. */
  flush: () => Promise<void>;
}

/**
 * Creates a gRPC sink that streams messages over a client-side streaming call.
 *
 * Uses a simple framing protocol: each message is sent as a length-prefixed
 * JSON buffer over a raw gRPC bidirectional stream. The server should implement:
 *
 * ```protobuf
 * service AgentMessages {
 *   rpc StreamMessages (stream MessageEnvelope) returns (Ack);
 * }
 * ```
 *
 * Requires `@grpc/grpc-js` as a peer dependency.
 *
 * If you don't need gRPC, use `createHttpSink` instead — it has zero dependencies.
 */
export async function createGrpcSink(
  url: string,
  options: GrpcSinkOptions = {},
): Promise<GrpcSink> {
  const { onError = (err) => console.error("[grpc-sink]", err) } = options;

  // Dynamic import to keep @grpc/grpc-js optional
  const grpc = await import("@grpc/grpc-js");

  const client = new grpc.Client(url, grpc.credentials.createInsecure());

  const metadata = new grpc.Metadata();
  if (options.metadata) {
    for (const [key, value] of Object.entries(options.metadata)) {
      metadata.add(key, value);
    }
  }

  let sequence = 0;
  let stream: any = null;
  let streamError: unknown = null;

  // Create the client streaming call
  const finishedPromise = new Promise<void>((resolve, reject) => {
    stream = client.makeClientStreamRequest(
      "/agent_messages.AgentMessages/StreamMessages",
      (msg: MessageEnvelope) => Buffer.from(JSON.stringify(msg)),
      (buf: Buffer) => JSON.parse(buf.toString()),
      metadata,
      (err: any, _response: any) => {
        if (err) {
          streamError = err;
          reject(err);
        } else {
          resolve();
        }
      },
    );
  });

  return {
    send(message: SDKMessage): void {
      if (streamError) return;
      try {
        const envelope = toEnvelope(message, ++sequence);
        stream?.write(envelope);
      } catch (err) {
        onError(err);
      }
    },

    async flush(): Promise<void> {
      stream?.end();
      try {
        await finishedPromise;
      } catch (err) {
        onError(err);
      }
      client.close();
    },
  };
}
