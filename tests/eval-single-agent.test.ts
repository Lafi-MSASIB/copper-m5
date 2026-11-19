// The single agent: one agent that does everything, the other way to build the
// support assistant. It must get the same rules and every tool the two agents
// have between them (minus the hand-off), and each answer must be measured. A
// fake model is used, so nothing is spent.
import type { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  calls,
  modelStreaming,
  says,
  STEP_TOKENS,
  systemPrompt,
  toolNames,
} from "./helpers/mock-model";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

import { SystemFailedError } from "@/evals/errors";
import {
  runSingleAgent,
  SINGLE_AGENT_INSTRUCTIONS,
  singleAgentTools,
} from "@/evals/single-agent";
import { SYSTEMS } from "@/evals/systems";
import {
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  REFUND_RULES,
} from "@/lib/copper/assistant/instructions";
import { copperTools, refundAgentTools } from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

const desk: Desk = { limitUsd: 50, refunds: [] };

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("the single agent's instructions", () => {
  it("are Copper's instructions plus the same refund rules the Refund agent follows", () => {
    expect(SINGLE_AGENT_INSTRUCTIONS).toContain(COPPER_INSTRUCTIONS);
    expect(SINGLE_AGENT_INSTRUCTIONS).toContain(REFUND_RULES);
    expect(REFUND_AGENT_INSTRUCTIONS).toContain(REFUND_RULES);
  });

  it("know there is no other agent, and never mention a hand-off", () => {
    expect(SINGLE_AGENT_INSTRUCTIONS).toMatch(/no other agent/);
    expect(SINGLE_AGENT_INSTRUCTIONS).not.toMatch(/transfer_to/);
  });

  it("keep the rule that nobody's say-so changes what the app decides", () => {
    expect(SINGLE_AGENT_INSTRUCTIONS).toMatch(
      /already approved a refund[\s\S]*doesn't change what the app decides/,
    );
  });
});

describe("the single agent's tools", () => {
  it("are only Copper's tools away from the Support page", () => {
    expect(Object.keys(singleAgentTools()).sort()).toEqual(
      Object.keys(copperTools).sort(),
    );
  });

  it("add the refund tools on the Support page, and leave out the hand-offs", () => {
    const names = Object.keys(singleAgentTools(desk)).sort();
    expect(names).toEqual(
      [...Object.keys(copperTools), "get_orders", "request_refund"].sort(),
    );
    expect(names).not.toContain("transfer_to_copper");
    expect(names).not.toContain("transfer_to_refund_agent");
  });

  it("are the tools of both agents between them, minus the hand-off", () => {
    const both = new Set([
      ...Object.keys(copperTools),
      ...Object.keys(refundAgentTools(desk)),
    ]);
    both.delete("transfer_to_copper");
    expect(new Set(Object.keys(singleAgentTools(desk)))).toEqual(both);
  });
});

describe("running the single agent", () => {
  it("answers a refund question with the app's own refund rule deciding", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1004" }),
      says("That's over the limit, so a supervisor will review it."),
    );
    const out = await runSingleAgent({
      question: "I want a refund for order #1004.",
      desk,
    });
    expect(out.reply).toMatch(/supervisor will review/);
    expect(out.answeredBy).toBeUndefined();
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]).toMatchObject({
      name: "request_refund",
      input: { orderId: "1004" },
      output: { status: "needs_approval", amountUsd: 149 },
    });
    // The one agent was given all the tools and the combined instructions.
    expect(toolNames(model)).toEqual(
      [...Object.keys(copperTools), "get_orders", "request_refund"].sort(),
    );
    expect(systemPrompt(model)).toContain("You also handle refunds yourself");
  });

  it("is given only Copper's tools when there is no Support page", async () => {
    model = modelStreaming(
      calls("calculate_cost", {
        products: ["copper-home"],
        plan: "copper-plus",
        billing: "annual",
        years: 2,
      }),
      says("That's $307 in total."),
    );
    const out = await runSingleAgent({ question: "How much for 2 years?" });
    expect(toolNames(model)).toEqual(Object.keys(copperTools).sort());
    expect(out.tools[0].output).toMatchObject({ totalUsd: 307 });
  });

  it("says so when the model gives no answer, instead of scoring silence", async () => {
    model = modelStreaming(says("   "));
    await expect(runSingleAgent({ question: "hi" })).rejects.toBeInstanceOf(
      SystemFailedError,
    );
  });

  it("lets a model failure through, so it isn't scored as a bad answer", async () => {
    const failing = modelStreaming();
    failing.doStream = async () => {
      throw new Error("You exceeded your current quota");
    };
    model = failing;
    await expect(runSingleAgent({ question: "hi" })).rejects.toThrow(/quota/);
  });
});

describe("measuring an answer", () => {
  it("adds up the turns, tool calls, tokens, cost and time", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1001" }),
      says("Your $7.99 is refunded."),
    );
    const out = await SYSTEMS["single-agent"]({
      question: "Refund order #1001 please.",
      desk,
    });
    // One agent turn, with two model steps inside it.
    expect(out.usage).toMatchObject({
      modelCalls: 1,
      embeddingCalls: 0,
      toolCalls: 1,
      inputTokens: STEP_TOKENS.input * 2,
      outputTokens: STEP_TOKENS.output * 2,
    });
    expect(out.usage!.costUsd).toBeGreaterThan(0);
    expect(out.usage!.latencyS).toBeGreaterThanOrEqual(0);
  });
});
