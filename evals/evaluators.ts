// Turns the code checks, the AI judge and the measured cost into Langfuse scores.
// Item evaluators score one question; run evaluators score the whole run, so two
// runs (the two-agent and the single-agent system) can be compared on the same
// numbers in Langfuse.
import type { Evaluator, RunEvaluator } from "@langfuse/client";
import { runChecks, type RunOutput, type SystemName } from "@/evals/checks";
import { GOLDEN_SET, type GoldenItem } from "@/evals/golden-set";
import { judgeAnswer, unit } from "@/evals/judge";

/** The golden-set question behind a dataset item (its id is kept in the item's metadata). */
export function goldenFor(metadata: unknown): GoldenItem {
  const id = (metadata as { id?: string } | undefined)?.id;
  const item = GOLDEN_SET.find((g) => g.id === id);
  if (!item) throw new Error(`No golden-set question with id "${id}".`);
  return item;
}

/** Score names the gate, the run evaluators and the comparison read. */
export const SCORE = {
  checksPass: "checks_pass",
  judgePass: "judge_pass",
  judgeSafe: "judge_safe",
  judgeAccuracy: "judge_accuracy",
  judgeGrounded: "judge_grounded",
  modelCalls: "model_calls",
  toolCalls: "tool_calls",
  costUsd: "cost_usd",
  latencyS: "latency_s",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
} as const;

/** The code checks for a question, for the given way of building the assistant. */
export const makeCodeChecks =
  (system: SystemName): Evaluator =>
  async ({ output, metadata }) => {
    const item = goldenFor(metadata);
    const checks = runChecks(item.expected, output as RunOutput, system);
    return [
      ...checks.map((c) => ({
        name: `check_${c.name}`,
        value: c.passed ? 1 : 0,
        comment: c.comment,
      })),
      {
        name: SCORE.checksPass,
        value: checks.every((c) => c.passed) ? 1 : 0,
        comment: checks.length
          ? `${checks.filter((c) => c.passed).length} of ${checks.length} code checks passed.`
          : "No code checks for this question.",
      },
    ];
  };

export const codeChecks = makeCodeChecks("two-agent");

export const aiJudge: Evaluator = async ({ output, metadata }) => {
  const item = goldenFor(metadata);
  const verdict = await judgeAnswer(item, output as RunOutput);
  return [
    {
      name: SCORE.judgeAccuracy,
      value: unit(verdict.accuracy),
      comment: verdict.reason,
    },
    {
      name: SCORE.judgeGrounded,
      value: unit(verdict.grounded),
      comment: verdict.reason,
    },
    {
      name: SCORE.judgeSafe,
      value: verdict.safe ? 1 : 0,
      comment: verdict.reason,
    },
    {
      name: SCORE.judgePass,
      value: verdict.verdict === "pass" ? 1 : 0,
      comment: verdict.reason,
    },
  ];
};

/** What the answer cost: model calls, tool calls, tokens, money and seconds. */
export const usageScores: Evaluator = async ({ output }) => {
  const usage = (output as RunOutput).usage;
  if (!usage) return [];
  return [
    { name: SCORE.modelCalls, value: usage.modelCalls },
    { name: SCORE.toolCalls, value: usage.toolCalls },
    { name: SCORE.inputTokens, value: usage.inputTokens },
    { name: SCORE.outputTokens, value: usage.outputTokens },
    { name: SCORE.costUsd, value: usage.costUsd },
    { name: SCORE.latencyS, value: usage.latencyS },
  ];
};

/** Every evaluator for one run of the given system. */
export const evaluatorsFor = (system: SystemName): Evaluator[] => [
  makeCodeChecks(system),
  aiJudge,
  usageScores,
];

const round = (value: number, digits: number) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

const valuesOf = (
  itemResults: { evaluations: { name: string; value: unknown }[] }[],
  score: string,
) =>
  itemResults.flatMap((r) =>
    r.evaluations.filter((e) => e.name === score).map((e) => Number(e.value)),
  );

/** The average (or total) of one score across every question in the run. */
const across =
  (
    score: string,
    as: string,
    how: "average" | "total",
    digits = 2,
  ): RunEvaluator =>
  async ({ itemResults }) => {
    const values = valuesOf(itemResults, score);
    const total = values.reduce((a, b) => a + b, 0);
    return {
      name: as,
      value: round(
        how === "total" ? total : values.length ? total / values.length : 0,
        digits,
      ),
    };
  };

export const runEvaluators: RunEvaluator[] = [
  across(SCORE.judgePass, "run_pass_rate", "average"),
  across(SCORE.checksPass, "run_checks_pass_rate", "average"),
  across(SCORE.judgeAccuracy, "run_avg_accuracy", "average"),
  across(SCORE.judgeGrounded, "run_avg_grounded", "average"),
  across(SCORE.costUsd, "run_avg_cost_usd", "average", 6),
  across(SCORE.costUsd, "run_total_cost_usd", "total", 6),
  across(SCORE.latencyS, "run_avg_latency_s", "average", 1),
  across(SCORE.modelCalls, "run_avg_model_calls", "average"),
  across(SCORE.toolCalls, "run_avg_tool_calls", "average"),
];
