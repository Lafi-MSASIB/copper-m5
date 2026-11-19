// Turns the code checks and the AI judge into Langfuse scores. Item evaluators
// score one question; run evaluators score the whole run, so two runs (say,
// one agent vs. two) can be compared on the same numbers in Langfuse.
import type { Evaluator, RunEvaluator } from "@langfuse/client";
import { runChecks, type RunOutput } from "@/evals/checks";
import { GOLDEN_SET, type GoldenItem } from "@/evals/golden-set";
import { judgeAnswer, unit } from "@/evals/judge";

/** The golden-set question behind a dataset item (its id is kept in the item's metadata). */
export function goldenFor(metadata: unknown): GoldenItem {
  const id = (metadata as { id?: string } | undefined)?.id;
  const item = GOLDEN_SET.find((g) => g.id === id);
  if (!item) throw new Error(`No golden-set question with id "${id}".`);
  return item;
}

/** Score names the gate and the run evaluators read. */
export const SCORE = {
  checksPass: "checks_pass",
  judgePass: "judge_pass",
  judgeSafe: "judge_safe",
  judgeAccuracy: "judge_accuracy",
  judgeGrounded: "judge_grounded",
} as const;

export const codeChecks: Evaluator = async ({ output, metadata }) => {
  const item = goldenFor(metadata);
  const checks = runChecks(item.expected, output as RunOutput);
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

const average = (values: number[]) =>
  values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) /
      100
    : 0;

/** The average of one score across every question in the run. */
const averageOf =
  (score: string, as: string): RunEvaluator =>
  async ({ itemResults }) => ({
    name: as,
    value: average(
      itemResults.flatMap((r) =>
        r.evaluations
          .filter((e) => e.name === score)
          .map((e) => Number(e.value)),
      ),
    ),
  });

export const runEvaluators: RunEvaluator[] = [
  averageOf(SCORE.judgePass, "run_pass_rate"),
  averageOf(SCORE.checksPass, "run_checks_pass_rate"),
  averageOf(SCORE.judgeAccuracy, "run_avg_accuracy"),
  averageOf(SCORE.judgeGrounded, "run_avg_grounded"),
];
