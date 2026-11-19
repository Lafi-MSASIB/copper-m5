// A scripted fake model for tests: what it streams back, one model step at a
// time, so no AI key is needed and nothing is spent.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

export type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

/** Every model step reports this much, so tests can check the totals add up. */
export const STEP_TOKENS = { input: 500, output: 50 };

const usage = {
  inputTokens: {
    total: STEP_TOKENS.input,
    noCache: STEP_TOKENS.input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: STEP_TOKENS.output,
    text: STEP_TOKENS.output,
    reasoning: undefined,
  },
};

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});

/** The model says some words and stops. */
export const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

/** The model calls one tool. */
export const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

/** A fake model that streams each of `steps` in turn, one per model step. */
export function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

/** The names of the tools a model call was offered, sorted. */
export function toolNames(model: MockLanguageModelV4, call = 0): string[] {
  return (model.doStreamCalls[call]?.tools ?? []).map((t) => t.name).sort();
}

/** The system prompt a model call was given. */
export function systemPrompt(model: MockLanguageModelV4, call = 0): string {
  const system = model.doStreamCalls[call]?.prompt.find(
    (m) => m.role === "system",
  );
  return typeof system?.content === "string" ? system.content : "";
}
