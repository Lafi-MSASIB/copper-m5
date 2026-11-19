// Puts two runs of the golden set side by side: is the single agent or the pair
// of agents better, and what does each cost? Plain code over the scores already
// collected, so it makes no model calls and is easy to test.
import type { SystemName } from "@/evals/checks";
import type { ScoredItem, Summary } from "@/evals/gate";

export type SystemResult = {
  system: SystemName;
  runName: string;
  /** Where to see this run in Langfuse. */
  url?: string;
  items: ScoredItem[];
  summary: Summary;
};

type Row = {
  label: string;
  /** Which way is better, so the table can mark the winner. null: just informative. */
  better: "higher" | "lower" | null;
  /** The number for each system, or null when nothing was scored. */
  values: Partial<Record<SystemName, number | null>>;
  /** How to show a number. */
  show: (value: number) => string;
};

/** The average of one score over the questions that have it. */
function mean(items: ScoredItem[], score: string): number | null {
  const values = items
    .map((i) => i.scores[score])
    .filter((v): v is number => typeof v === "number");
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

function total(items: ScoredItem[], score: string): number | null {
  const values = items
    .map((i) => i.scores[score])
    .filter((v): v is number => typeof v === "number");
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

const percent = (v: number) => `${Math.round(v * 100)}%`;
const decimal = (digits: number) => (v: number) => v.toFixed(digits);
const dollars = (v: number) => `$${v.toFixed(4)}`;

/** Every number compared, for each system. */
export function comparisonRows(results: SystemResult[]): Row[] {
  const per = <T>(pick: (r: SystemResult) => T) =>
    Object.fromEntries(results.map((r) => [r.system, pick(r)])) as Partial<
      Record<SystemName, T>
    >;
  const scored = (r: SystemResult) =>
    r.items.filter(
      (i) =>
        i.scores.judge_pass !== undefined && i.scores.checks_pass !== undefined,
    );
  const rate = (r: SystemResult, pick: (s: Summary) => number) =>
    r.summary.scoredCount ? pick(r.summary) : null;

  return [
    {
      label: "Questions scored",
      better: null,
      values: per((r) => r.summary.scoredCount),
      show: (v) => String(v),
    },
    {
      label: "AI judge passed",
      better: "higher",
      values: per((r) => rate(r, (s) => s.judgePassRate)),
      show: percent,
    },
    {
      label: "Passed every code check",
      better: "higher",
      values: per((r) => rate(r, (s) => s.checksPassRate)),
      show: percent,
    },
    {
      label: "Average accuracy (judge, 0 to 1)",
      better: "higher",
      values: per((r) => mean(scored(r), "judge_accuracy")),
      show: decimal(2),
    },
    {
      label: "Average grounded (judge, 0 to 1)",
      better: "higher",
      values: per((r) => mean(scored(r), "judge_grounded")),
      show: decimal(2),
    },
    {
      label: "Safety or refund failures",
      better: "lower",
      values: per((r) =>
        r.summary.scoredCount ? r.summary.criticalFailures.length : null,
      ),
      show: (v) => String(v),
    },
    {
      label: "Average cost per question",
      better: "lower",
      values: per((r) => mean(r.items, "cost_usd")),
      show: dollars,
    },
    {
      label: "Total cost of the run",
      better: "lower",
      values: per((r) => total(r.items, "cost_usd")),
      show: dollars,
    },
    {
      label: "Average time per question (s)",
      better: "lower",
      values: per((r) => mean(r.items, "latency_s")),
      show: decimal(1),
    },
    {
      label: "Average agent turns per question",
      better: "lower",
      values: per((r) => mean(r.items, "model_calls")),
      show: decimal(1),
    },
    {
      label: "Average tool calls per question",
      better: null,
      values: per((r) => mean(r.items, "tool_calls")),
      show: decimal(1),
    },
  ];
}

/** Which of two systems wins a row, if either: "tie" when they match. */
export function winner(
  row: Row,
  systems: SystemName[],
): SystemName | "tie" | null {
  if (!row.better || systems.length !== 2) return null;
  const [a, b] = systems.map((s) => row.values[s]);
  if (a == null || b == null) return null;
  if (a === b) return "tie";
  const aWins = row.better === "higher" ? a > b : a < b;
  return aWins ? systems[0] : systems[1];
}

/** Questions the two systems answered differently: where the setup mattered. */
export function differences(results: SystemResult[]) {
  const ids = results[0]?.items.map((i) => i.id) ?? [];
  return ids
    .map((id) => {
      const outcomes = results.map((r) => {
        const s = r.items.find((i) => i.id === id)?.scores ?? {};
        return {
          system: r.system,
          checks: s.checks_pass,
          judge: s.judge_pass,
        };
      });
      const same = outcomes.every(
        (o) => o.checks === outcomes[0].checks && o.judge === outcomes[0].judge,
      );
      return { id, outcomes, same };
    })
    .filter((q) => !q.same);
}

const mark = (v: number | undefined) =>
  v === undefined ? "n/a" : v === 1 ? "pass" : "FAIL";

/** The comparison as plain text for the terminal. */
export function formatComparison(results: SystemResult[]): string {
  const systems = results.map((r) => r.system);
  const rows = comparisonRows(results);
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const colWidth = 16;
  const header =
    "".padEnd(labelWidth) +
    "  " +
    systems.map((s) => s.padEnd(colWidth)).join("") +
    "better";
  const lines = [header, "-".repeat(header.length)];
  for (const row of rows) {
    const cells = systems.map((s) => {
      const v = row.values[s];
      return (v == null ? "n/a" : row.show(v)).padEnd(colWidth);
    });
    const w = winner(row, systems);
    lines.push(
      `${row.label.padEnd(labelWidth)}  ${cells.join("")}${w === null ? "" : w === "tie" ? "tie" : w}`,
    );
  }

  const diff = differences(results);
  lines.push("");
  if (diff.length) {
    lines.push("Questions the two systems answered differently:");
    for (const q of diff) {
      lines.push(
        `  ${q.id}: ${q.outcomes.map((o) => `${o.system} (checks ${mark(o.checks)}, judge ${mark(o.judge)})`).join("  vs  ")}`,
      );
    }
  } else {
    lines.push("The two systems got the same result on every question.");
  }
  return lines.join("\n");
}
