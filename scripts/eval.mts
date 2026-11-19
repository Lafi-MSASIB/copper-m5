// npm run eval: asks the support assistant the golden-set questions, checks
// every answer with code checks and an AI judge, and keeps the scores in
// Langfuse. It exits with 0 when the answers are good enough, 1 when they are
// not, and 2 when the run couldn't finish (for example a key is missing or
// Google's free daily limit is used up), so a pull request is never passed by
// accident.
//
//   npm run eval                          the quick set, on the two-agent Ask Copper
//   npm run eval -- --set full            every question
//   npm run eval -- --only docs-c47       one or more questions, by id
//   npm run eval -- --system single-agent the one-agent version instead
//   npm run eval:compare                  both systems on the same questions, then compare
//   npm run eval -- --dry                 save the golden set to Langfuse, ask nothing
//
// The pass/fail gate is about the system that ships (the two-agent Ask Copper).
// The single agent is there to be compared against it, not to be gated.
import { parseArgs } from "node:util";
import { LangfuseClient } from "@langfuse/client";
import type { SystemName } from "@/evals/checks";
import { formatComparison, type SystemResult } from "@/evals/compare";
import { evaluatorsFor, goldenFor, runEvaluators } from "@/evals/evaluators";
import { summarize, type ScoredItem } from "@/evals/gate";
import {
  GOLDEN_SET,
  selectGolden,
  type GoldenSetName,
} from "@/evals/golden-set";
import { SYSTEMS } from "@/evals/systems";
import { isAiConfigured } from "@/lib/ai/call";
import {
  flushTraces,
  isTracingConfigured,
  startTracing,
} from "@/lib/ai/langfuse";
import { defaultModel } from "@/lib/ai/models";

const DATASET = "copper-golden-set";
const SYSTEM_NAMES = Object.keys(SYSTEMS) as SystemName[];

// Evaluation traces get their own environment, apart from real chats in Langfuse
// (the pull-request workflow sets it to "ci").
process.env.LANGFUSE_TRACING_ENVIRONMENT ??= "evaluation";

function stop(code: number, message: string): never {
  console.error(`\n${message}`);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    set: { type: "string" },
    only: { type: "string" },
    system: { type: "string" },
    "run-name": { type: "string" },
    dry: { type: "boolean" },
  },
});

const setName = (values.set ?? process.env.EVAL_SET ?? "core") as GoldenSetName;
if (setName !== "core" && setName !== "full")
  stop(2, `--set must be "core" or "full", not "${setName}".`);
const requested = values.system ?? "two-agent";
if (requested !== "both" && !SYSTEM_NAMES.includes(requested as SystemName))
  stop(2, `--system must be one of: ${[...SYSTEM_NAMES, "both"].join(", ")}.`);
const systemsToRun: SystemName[] =
  requested === "both" ? SYSTEM_NAMES : [requested as SystemName];
const only = values.only?.split(",").map((id) => id.trim());
if (only?.some((id) => !GOLDEN_SET.some((g) => g.id === id)))
  stop(
    2,
    `Unknown question id. Known ids: ${GOLDEN_SET.map((g) => g.id).join(", ")}.`,
  );

if (!isTracingConfigured())
  stop(
    2,
    "Langfuse isn't set up: add LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (to .env.local, or to the repo's Actions secrets).",
  );
if (!values.dry && !isAiConfigured())
  stop(
    2,
    "Add GOOGLE_GENERATIVE_AI_API_KEY (to .env.local, or to the repo's Actions secrets).",
  );

startTracing();
const langfuse = new LangfuseClient();
const selected = selectGolden(setName, only);

// Keep the whole golden set in Langfuse as a dataset, so runs show up against it.
await langfuse.api.datasets.create({
  name: DATASET,
  description:
    "Questions Ask Copper must keep answering well: pricing, stock, support documents, refunds, scope and safety.",
});
for (const g of GOLDEN_SET) {
  await langfuse.api.datasetItems.create({
    datasetName: DATASET,
    id: `golden-${g.id}`,
    input: { question: g.question, desk: g.desk },
    expectedOutput: g.expected,
    metadata: { id: g.id, category: g.category, core: g.core },
  });
}
console.log(
  `Golden set saved to Langfuse (${GOLDEN_SET.length} questions in "${DATASET}").`,
);
console.log(
  `Running ${selected.length} question${selected.length === 1 ? "" : "s"} (${only ? "chosen by id" : `${setName} set`}) on: ${systemsToRun.join(" and ")}.`,
);
for (const g of selected) console.log(`  - ${g.id} [${g.category}]`);

if (values.dry) {
  await langfuse.flush();
  console.log("\nDry run: nothing was asked.");
  process.exit(0);
}

const dataset = await langfuse.dataset.get(DATASET);
const wanted = new Set(selected.map((g) => `golden-${g.id}`));
const data = dataset.items.filter((item) => wanted.has(item.id));
if (data.length !== selected.length)
  stop(2, "Some golden-set questions are missing from the Langfuse dataset.");

// Both systems' runs share a timestamp, so the pair is easy to spot in Langfuse.
const stamp = new Date().toISOString().slice(0, 16);

/** Runs every selected question on one system and scores the answers. */
async function runSystem(system: SystemName): Promise<SystemResult> {
  console.log(`\n=== ${system} ===`);
  const runName =
    systemsToRun.length === 1 && values["run-name"]
      ? values["run-name"]
      : `${system}-${only ? "custom" : setName}-${stamp}`;

  const result = await langfuse.experiment.run({
    name: DATASET,
    runName,
    description: `The support assistant on the golden set (${system}).`,
    metadata: {
      system,
      set: only ? "custom" : setName,
      model: defaultModel(),
      commit: process.env.GITHUB_SHA ?? "local",
    },
    data,
    task: async (item) => {
      const input = item.input as { question: string; desk?: never };
      return SYSTEMS[system]({ question: input.question, desk: input.desk });
    },
    evaluators: evaluatorsFor(system),
    runEvaluators,
    maxConcurrency: 1,
  });

  // Gather every score by question.
  const items: ScoredItem[] = selected.map((g) => {
    const found = result.itemResults.find(
      (r) => goldenFor(r.item.metadata).id === g.id,
    );
    const scores: Record<string, number> = {};
    for (const e of found?.evaluations ?? []) scores[e.name] = Number(e.value);
    return { id: g.id, category: g.category, scores };
  });
  const summary = summarize(items);

  console.log(
    "\nquestion                     checks  accuracy  grounded  safe  judge   cost($)  time(s)",
  );
  for (const s of items) {
    const v = (name: string, width = 3) =>
      s.scores[name] === undefined
        ? "-".padStart(width)
        : String(s.scores[name]).padStart(width);
    console.log(
      `${s.id.padEnd(28)} ${v("checks_pass")}     ${v("judge_accuracy")}       ${v("judge_grounded")}      ${v("judge_safe")}   ${v("judge_pass")}   ${v("cost_usd", 9)}  ${v("latency_s", 6)}`,
    );
  }
  for (const r of result.itemResults) {
    const g = goldenFor(r.item.metadata);
    const bad = r.evaluations.filter(
      (e) =>
        (e.name.startsWith("check_") && e.value === 0) ||
        (e.name === "judge_pass" && e.value === 0),
    );
    for (const e of bad)
      console.log(`  ${g.id}: ${e.name}: ${e.comment ?? ""}`);
  }
  // A rate over nothing would only mislead, so say "n/a" when nothing was scored.
  const pct = (rate: number) =>
    summary.scoredCount ? `${Math.round(rate * 100)}%` : "n/a";
  console.log(
    `\nScored ${summary.scoredCount} of ${summary.total}. Judge pass rate ${pct(summary.judgePassRate)}, code checks ${pct(summary.checksPassRate)}.`,
  );
  if (result.experimentUrl)
    console.log(`See this run in Langfuse: ${result.experimentUrl}`);
  await langfuse.flush();
  return { system, runName, url: result.experimentUrl, items, summary };
}

const results: SystemResult[] = [];
for (const system of systemsToRun) results.push(await runSystem(system));

if (results.length > 1) {
  console.log(
    `\n=== Comparison: ${results.map((r) => r.system).join(" vs ")} ===\n`,
  );
  console.log(formatComparison(results));
  console.log(
    `\nTo compare them in Langfuse: open the dataset "${DATASET}", go to Runs, tick these runs and choose Compare:\n${results.map((r) => `  - ${r.runName}`).join("\n")}`,
  );
}

await flushTraces();

// The gate is about the first system (the two-agent Ask Copper that ships).
const gated = results[0];
const incomplete = results.filter((r) => r.summary.unscored.length > 0);
if (incomplete.length) {
  console.error(
    `\nThe evaluation could not finish. Not scored: ${incomplete
      .map((r) => `${r.system} (${r.summary.unscored.join(", ")})`)
      .join("; ")}.`,
  );
  console.error(
    "If the log above mentions a quota, Google's free daily limit is used up. It resets once a day: run again later, ask for fewer questions with --only, or use a Google key with billing turned on.",
  );
  process.exit(2);
}
if (results.length > 1)
  for (const r of results.slice(1))
    console.log(
      `\n${r.system} ${r.summary.ok ? "would pass" : "would not pass"} the gate (for comparison only).`,
    );
if (gated.summary.ok) {
  console.log(`\nThe golden-set evaluation PASSED (${gated.system}).`);
  process.exit(0);
}
console.error(
  `\nThe golden-set evaluation FAILED (${gated.system}):\n- ${gated.summary.reasons.join("\n- ")}`,
);
process.exit(1);
