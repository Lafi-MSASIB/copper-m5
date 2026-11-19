// Measures what one piece of work cost in AI calls: how many model calls, how
// many tokens, how much money. The evaluation uses it to compare two ways of
// answering the same question. Every call already goes through lib/ai/call.ts,
// which reports each one here; outside withUsage() that report is simply dropped.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AiCallRow } from "@/lib/ai/call";
import { EMBEDDING_MODEL } from "@/lib/ai/models";

const current = new AsyncLocalStorage<AiCallRow[]>();

/** Called by lib/ai/call.ts for every AI call. Does nothing unless someone is measuring. */
export function recordCall(row: AiCallRow): void {
  current.getStore()?.push(row);
}

export type Usage = {
  /** AI calls logged: one per agent turn, however many steps the turn takes. */
  modelCalls: number;
  /** Calls that turn text into numbers (the document search). */
  embeddingCalls: number;
  /** Calls to tools. Filled in by the system that knows its own tool calls. */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Wall-clock time for the whole answer, in seconds. */
  latencyS: number;
};

/** Runs the work and returns it together with every AI call it made. */
export async function withUsage<T>(
  run: () => Promise<T>,
): Promise<{ value: T; calls: AiCallRow[] }> {
  const calls: AiCallRow[] = [];
  const value = await current.run(calls, run);
  return { value, calls };
}

/**
 * Adds up the calls. A call that failed isn't counted as a model call, but its
 * tokens and cost still are (when Google reports them).
 */
export function summarizeUsage(
  calls: AiCallRow[],
  elapsedMs: number,
  toolCalls: number,
): Usage {
  const embedding = calls.filter((c) => c.model === EMBEDDING_MODEL);
  const generation = calls.filter((c) => c.model !== EMBEDDING_MODEL);
  const sum = (pick: (c: AiCallRow) => number | null) =>
    calls.reduce((total, c) => total + (pick(c) ?? 0), 0);
  return {
    modelCalls: generation.length,
    embeddingCalls: embedding.length,
    toolCalls,
    inputTokens: sum((c) => c.input_tokens),
    outputTokens: sum((c) => c.output_tokens),
    costUsd: Math.round(sum((c) => c.cost_usd) * 1e6) / 1e6,
    latencyS: Math.round(elapsedMs / 100) / 10,
  };
}
