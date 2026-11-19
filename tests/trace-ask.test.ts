// How Ask Copper uses tracing: one trace per question, with each agent that
// answered shown inside it, and the trace sent before the turn is finished.
// Mock model and a recording stand-in for the tracing helper: no keys, nothing sent.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import type { Desk } from "@/lib/copper/orders";

const seen = vi.hoisted(() => ({
  turns: [] as {
    name: string;
    input: unknown;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }[],
  agents: [] as string[],
  outputs: [] as unknown[],
  flushed: 0,
}));

vi.mock("@/lib/ai/langfuse", () => ({
  traceTurn: async (
    info: (typeof seen.turns)[number],
    run: (finish: (output: unknown) => void) => Promise<unknown>,
  ) => {
    seen.turns.push(info);
    return run((output) => seen.outputs.push(output));
  },
  traceAgent: async (name: string, run: () => Promise<unknown>) => {
    seen.agents.push(name);
    return run();
  },
  flushTraces: async () => {
    seen.flushed++;
  },
}));

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
const calls = (toolName: string, input: unknown): StreamPart[] => [
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
function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

const desk: Desk = { limitUsd: 50, refunds: [] };

async function ask(
  request: Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0],
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue((await askCopper(request)).progress);
}

beforeEach(() => {
  seen.turns.length = 0;
  seen.agents.length = 0;
  seen.outputs.length = 0;
  seen.flushed = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("Ask Copper tracing", () => {
  it("traces one question as one turn with Copper inside it, then sends the trace", async () => {
    model = modelStreaming(says("It comes in three colors."));
    const result = await ask({
      messages: [
        { role: "user", content: "What colors does Copper Home come in?" },
      ],
      useTools: true,
    });
    expect(result.reply).toBe("It comes in three colors.");
    expect(seen.turns).toHaveLength(1);
    expect(seen.turns[0]).toMatchObject({
      name: "ask-copper",
      input: "What colors does Copper Home come in?",
      tags: ["tools"],
      metadata: { useTools: true, startedWith: "copper", onSupportPage: false },
    });
    expect(seen.agents).toEqual(["copper"]);
    expect(seen.outputs).toEqual([
      {
        reply: "It comes in three colors.",
        status: "done",
        answeredBy: "copper",
      },
    ]);
    expect(seen.flushed).toBe(1);
  });

  it("shows both agents in the trace when Copper hands a refund to the Refund agent", async () => {
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund order #1004" }),
      says("I'll look into that refund."),
    );
    const result = await ask({
      messages: [{ role: "user", content: "I want a refund for order #1004" }],
      useTools: true,
      desk,
    });
    expect(seen.agents).toEqual(["copper", "refund-agent"]);
    expect(seen.turns[0].metadata).toMatchObject({ onSupportPage: true });
    expect(seen.outputs[0]).toMatchObject({
      answeredBy: "refund",
      status: "done",
    });
    expect(result.reply).toMatch(/refund/);
    expect(seen.flushed).toBe(1);
  });

  it("labels a chat with tools off, and still traces it", async () => {
    model = modelStreaming(says("About $300?"));
    await ask({
      messages: [{ role: "user", content: "How much is it?" }],
      useTools: false,
    });
    expect(seen.turns[0].tags).toEqual(["no-tools"]);
    expect(seen.agents).toEqual(["copper-no-tools"]);
  });

  it("records the failure and still sends the trace when the model call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("The model is overloaded.");
      },
    });
    const result = await ask({
      messages: [{ role: "user", content: "hi" }],
      useTools: true,
    });
    expect(result.status).toBe("error");
    expect(seen.outputs[0]).toMatchObject({ status: "error" });
    expect(seen.flushed).toBe(1);
  });
});
