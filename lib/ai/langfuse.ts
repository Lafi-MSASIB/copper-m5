// Tracing: every AI call is sent to Langfuse, so each question shows up as one
// trace with the agents that handled it, their tool calls, tokens, cost and
// time. Langfuse is the only tracing tool the app uses.
//
// Tracing is optional. Without LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_BASE_URL (in .env.local, or the repo's Actions secrets in CI) nothing
// is sent and the app works exactly the same.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim() &&
    process.env.LANGFUSE_BASE_URL?.trim(),
  );
}

// One exporter per server process, kept on globalThis so a hot reload in
// development doesn't register a second one.
const STARTED = Symbol.for("copper.langfuse.tracing");
type Started = { processor: LangfuseSpanProcessor };
const store = globalThis as typeof globalThis & { [STARTED]?: Started };

/**
 * Starts sending traces to Langfuse (once). Returns null, and does nothing,
 * when the Langfuse keys aren't set. Called from instrumentation.ts when the
 * server starts, and by scripts that make AI calls.
 */
export function startTracing(): Started | null {
  if (store[STARTED]) return store[STARTED];
  if (!isTracingConfigured()) return null;
  // Without a name, Langfuse would show the path to node.exe as the service.
  process.env.OTEL_SERVICE_NAME ??= "copper-state-labs";
  // "immediate" sends each span as it ends, so nothing waits in a batch that a
  // serverless function might never get to send.
  const processor = new LangfuseSpanProcessor({ exportMode: "immediate" });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  // From here on, every generateText / streamText / embedMany call is traced.
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  store[STARTED] = { processor };
  return store[STARTED];
}

/** Sends any spans still waiting. Never throws: tracing must not break a chat. */
export async function flushTraces(): Promise<void> {
  try {
    await store[STARTED]?.processor.forceFlush();
  } catch (error) {
    console.error(
      `[langfuse] couldn't send traces: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Which environment a trace came from, so Langfuse can filter live-site traffic,
 * local testing and CI evaluations apart: LANGFUSE_TRACING_ENVIRONMENT if set,
 * otherwise "production" on Vercel and "development" everywhere else.
 */
export function tracingEnvironment(): string {
  const set = process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim();
  if (set) return set;
  return process.env.VERCEL_ENV === "production" ? "production" : "development";
}

export type TurnInfo = {
  /** The trace's name in Langfuse, e.g. "ask-copper". */
  name: string;
  /** What came in (the customer's message). */
  input: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

/**
 * One trace for one whole turn. Everything inside (each agent, its model calls
 * and its tools) hangs under it. Call `finish` with what came out.
 */
export async function traceTurn<T>(
  info: TurnInfo,
  run: (finish: (output: unknown) => void) => Promise<T>,
): Promise<T> {
  if (!startTracing()) return run(() => {});
  // If tracing itself fails before the work starts, do the work untraced
  // rather than leave the customer without an answer.
  let started = false;
  try {
    return await propagateAttributes(
      {
        traceName: info.name,
        tags: info.tags,
        metadata: info.metadata,
        environment: tracingEnvironment(),
      },
      () =>
        startActiveObservation(info.name, async (turn) => {
          started = true;
          turn.update({ input: info.input });
          return run((output) => turn.update({ output }));
        }),
    );
  } catch (error) {
    if (started) throw error;
    return run(() => {});
  }
}

/** One agent's part of a turn, shown in Langfuse as an agent observation. */
export async function traceAgent<T>(
  agent: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!startTracing()) return run();
  let started = false;
  try {
    return await startActiveObservation(
      agent,
      async () => {
        started = true;
        return run();
      },
      { asType: "agent" },
    );
  } catch (error) {
    if (started) throw error;
    return run();
  }
}
