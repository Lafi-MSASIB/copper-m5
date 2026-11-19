// npm run eval: asks Ask Copper the golden-set questions, checks every answer
// with code checks and an AI judge, and keeps the scores in Langfuse. It exits
// with 0 when the answers are good enough, 1 when they are not, and 2 when the
// run couldn't finish (for example a key is missing or Google's free daily
// limit is used up), so a pull request is never passed by accident.
//
//   npm run eval                      the quick set (what pull requests run)
//   npm run eval -- --set full        every question
//   npm run eval -- --only docs-c47   one or more questions, by id
//   npm run eval -- --dry             save the golden set to Langfuse, ask nothing
import { parseArgs } from "node:util";
import { LangfuseClient } from "@langfuse/client";
import {
  aiJudge,
  codeChecks,
  goldenFor,
  runEvaluators,
} from "@/evals/evaluators";
import { summarize, type ScoredItem } from "@/evals/gate";
import {
  GOLDEN_SET,
  selectGolden,
  type GoldenSetName,
} from "@/evals/golden-set";
import { SYSTEMS, type SystemName } from "@/evals/systems";
import { isAiConfigured } from "@/lib/ai/call";
import {
  flushTraces,
  isTracingConfigured,
  startTracing,
} from "@/lib/ai/langfuse";
import { defaultModel } from "@/lib/ai/models";

const DATASET = "copper-golden-set";

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
const system = (values.system ?? "two-agent") as SystemName;
if (!(system in SYSTEMS))
  stop(2, `--system must be one of: ${Object.keys(SYSTEMS).join(", ")}.`);
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
  `Running ${selected.length} question${selected.length === 1 ? "" : "s"} (${only ? "chosen by id" : `${setName} set`}) on the ${system} system:`,
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

const runName =
  values["run-name"] ??
  `${system}-${only ? "custom" : setName}-${new Date().toISOString().slice(0, 16)}`;

const result = await langfuse.experiment.run({
  name: DATASET,
  runName,
  description: `Ask Copper on the golden set (${system}).`,
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
  evaluators: [codeChecks, aiJudge],
  runEvaluators,
  maxConcurrency: 1,
});

// Gather every score by question.
const scored: ScoredItem[] = selected.map((g) => {
  const found = result.itemResults.find(
    (r) => goldenFor(r.item.metadata).id === g.id,
  );
  const scores: Record<string, number> = {};
  for (const e of found?.evaluations ?? []) scores[e.name] = Number(e.value);
  return { id: g.id, category: g.category, scores };
});
const summary = summarize(scored);

console.log(
  "\nquestion                     checks  accuracy  grounded  safe  judge",
);
for (const s of scored) {
  const v = (name: string) =>
    s.scores[name] === undefined ? "  -" : String(s.scores[name]).padStart(3);
  console.log(
    `${s.id.padEnd(28)} ${v("checks_pass")}     ${v("judge_accuracy")}       ${v("judge_grounded")}      ${v("judge_safe")}   ${v("judge_pass")}`,
  );
}
for (const r of result.itemResults) {
  const g = goldenFor(r.item.metadata);
  const bad = r.evaluations.filter(
    (e) =>
      (e.name.startsWith("check_") && e.value === 0) ||
      (e.name === "judge_pass" && e.value === 0),
  );
  for (const e of bad) console.log(`  ${g.id}: ${e.name}: ${e.comment ?? ""}`);
}

// A rate over nothing would only mislead, so say "n/a" when nothing was scored.
const pct = (rate: number) =>
  summary.scoredCount ? `${Math.round(rate * 100)}%` : "n/a";
console.log(
  `\nScored ${summary.scoredCount} of ${summary.total}. Judge pass rate ${pct(summary.judgePassRate)}, code checks ${pct(summary.checksPassRate)}.`,
);
if (result.experimentUrl)
  console.log(`See the run in Langfuse: ${result.experimentUrl}`);

await langfuse.flush();
await flushTraces();

if (summary.ok) {
  console.log("\nThe golden-set evaluation PASSED.");
  process.exit(0);
}
console.error(
  `\nThe golden-set evaluation FAILED:\n- ${summary.reasons.join("\n- ")}`,
);
if (summary.unscored.length)
  console.error(
    "\nIf the log above mentions a quota, Google's free daily limit is used up. It resets once a day: run again later, ask for fewer questions with --only, or use a Google key with billing turned on.",
  );
process.exit(summary.unscored.length ? 2 : 1);
