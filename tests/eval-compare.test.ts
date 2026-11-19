// The usage measuring and the side-by-side comparison of the two systems:
// plain code over scores, so no model is involved.
import { describe, expect, it } from "vitest";
import {
  comparisonRows,
  differences,
  formatComparison,
  winner,
  type SystemResult,
} from "@/evals/compare";
import { summarize, type ScoredItem } from "@/evals/gate";
import type { AiCallRow } from "@/lib/ai/call";
import { recordCall, summarizeUsage, withUsage } from "@/lib/ai/usage";

const row = (overrides: Partial<AiCallRow> = {}): AiCallRow => ({
  module: 2,
  feature: "ask-copper",
  model: "google/gemini-3-flash",
  input_tokens: 1000,
  output_tokens: 100,
  cost_usd: 0.001,
  latency_ms: 500,
  ok: true,
  created_at: "2026-11-19T00:00:00Z",
  ...overrides,
});

describe("measuring AI calls", () => {
  it("collects the calls made inside withUsage, and ignores the ones outside", async () => {
    recordCall(row({ feature: "before" }));
    const { value, calls } = await withUsage(async () => {
      recordCall(row({ feature: "first" }));
      await Promise.resolve();
      recordCall(row({ feature: "second" }));
      return "answer";
    });
    recordCall(row({ feature: "after" }));
    expect(value).toBe("answer");
    expect(calls.map((c) => c.feature)).toEqual(["first", "second"]);
  });

  it("keeps two measurements that run at the same time apart", async () => {
    const run = (feature: string) =>
      withUsage(async () => {
        recordCall(row({ feature }));
        await new Promise((r) => setTimeout(r, 5));
        recordCall(row({ feature }));
      });
    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect(a.calls.map((c) => c.feature)).toEqual(["a", "a"]);
    expect(b.calls.map((c) => c.feature)).toEqual(["b", "b"]);
  });

  it("adds up turns, tokens and cost, counts embeddings apart, and rounds the time", () => {
    const usage = summarizeUsage(
      [
        row(),
        row({ input_tokens: 2000, output_tokens: 50, cost_usd: 0.002 }),
        row({
          model: "google/gemini-embedding-2",
          input_tokens: null,
          output_tokens: null,
          cost_usd: null,
        }),
      ],
      2345,
      3,
    );
    expect(usage).toEqual({
      modelCalls: 2,
      embeddingCalls: 1,
      toolCalls: 3,
      inputTokens: 3000,
      outputTokens: 150,
      costUsd: 0.003,
      latencyS: 2.3,
    });
  });

  it("still counts the tokens and cost of a call that failed", () => {
    const usage = summarizeUsage(
      [
        row({
          ok: false,
          cost_usd: null,
          input_tokens: null,
          output_tokens: null,
        }),
      ],
      100,
      0,
    );
    expect(usage).toMatchObject({ modelCalls: 1, costUsd: 0, inputTokens: 0 });
  });
});

const item = (
  id: string,
  scores: Record<string, number> = {},
  category: ScoredItem["category"] = "docs",
): ScoredItem => ({
  id,
  category,
  scores: {
    checks_pass: 1,
    judge_pass: 1,
    judge_safe: 1,
    judge_accuracy: 1,
    judge_grounded: 1,
    cost_usd: 0.001,
    latency_s: 2,
    model_calls: 1,
    tool_calls: 1,
    ...scores,
  },
});

const result = (
  system: SystemResult["system"],
  items: ScoredItem[],
): SystemResult => ({
  system,
  runName: `${system}-core`,
  items,
  summary: summarize(items),
});

describe("comparing the two systems", () => {
  const two = result("two-agent", [
    item("a", { cost_usd: 0.002, latency_s: 3, model_calls: 2 }),
    item("b", { cost_usd: 0.004, latency_s: 5, model_calls: 2 }),
  ]);
  const single = result("single-agent", [
    item("a", { cost_usd: 0.001, latency_s: 2 }),
    item("b", {
      cost_usd: 0.003,
      latency_s: 4,
      judge_pass: 0,
      judge_accuracy: 0.5,
    }),
  ]);

  it("shows each number for each system", () => {
    const rows = comparisonRows([two, single]);
    const row = (label: string) => rows.find((r) => r.label === label)!;
    expect(row("AI judge passed").values).toEqual({
      "two-agent": 1,
      "single-agent": 0.5,
    });
    expect(row("Average cost per question").values["two-agent"]).toBeCloseTo(
      0.003,
    );
    expect(row("Average cost per question").values["single-agent"]).toBeCloseTo(
      0.002,
    );
    expect(row("Total cost of the run").values["two-agent"]).toBeCloseTo(0.006);
    expect(row("Average time per question (s)").values["single-agent"]).toBe(3);
  });

  it("names the better system on each row: higher is better for quality, lower for cost and time", () => {
    const rows = comparisonRows([two, single]);
    const systems = ["two-agent", "single-agent"] as const;
    const better = (label: string) =>
      winner(
        rows.find((r) => r.label === label)!,
        [...systems],
      );
    expect(better("AI judge passed")).toBe("two-agent");
    expect(better("Average cost per question")).toBe("single-agent");
    expect(better("Average time per question (s)")).toBe("single-agent");
    expect(better("Passed every code check")).toBe("tie");
    // Tool calls are informative only: no winner.
    expect(better("Average tool calls per question")).toBeNull();
  });

  it("lists the questions the two systems answered differently", () => {
    const diff = differences([two, single]);
    expect(diff.map((d) => d.id)).toEqual(["b"]);
    expect(diff[0].outcomes).toEqual([
      { system: "two-agent", checks: 1, judge: 1 },
      { system: "single-agent", checks: 1, judge: 0 },
    ]);
  });

  it("prints a readable table with the winner and the differences", () => {
    const text = formatComparison([two, single]);
    expect(text).toContain("two-agent");
    expect(text).toContain("single-agent");
    expect(text).toMatch(/AI judge passed\s+100%\s+50%\s+two-agent/);
    expect(text).toMatch(
      /Average cost per question\s+\$0\.0030\s+\$0\.0020\s+single-agent/,
    );
    expect(text).toContain("Questions the two systems answered differently:");
    expect(text).toContain(
      "b: two-agent (checks pass, judge pass)  vs  single-agent (checks pass, judge FAIL)",
    );
  });

  it("says so when the two systems agree on every question", () => {
    const same = formatComparison([two, result("single-agent", two.items)]);
    expect(same).toContain(
      "The two systems got the same result on every question.",
    );
  });

  it("shows n/a, and picks no winner, for a system that scored nothing", () => {
    const unscored = result("single-agent", [
      { id: "a", category: "docs", scores: {} },
      { id: "b", category: "docs", scores: {} },
    ]);
    const rows = comparisonRows([two, unscored]);
    const judge = rows.find((r) => r.label === "AI judge passed")!;
    expect(judge.values["single-agent"]).toBeNull();
    expect(winner(judge, ["two-agent", "single-agent"])).toBeNull();
    expect(formatComparison([two, unscored])).toMatch(
      /AI judge passed\s+100%\s+n\/a/,
    );
  });
});
