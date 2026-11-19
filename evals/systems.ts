// The systems under test: the two ways of building the support assistant that
// the golden set is run on and compared.
//   two-agent    the real Ask Copper: Copper plus the Refund agent, with a hand-off
//   single-agent one agent that does everything (see evals/single-agent.ts)
// Each run is measured the same way: model calls, tokens, cost and time.
import type { RunOutput, SystemName } from "@/evals/checks";
import { SystemFailedError } from "@/evals/errors";
import type { GoldenItem } from "@/evals/golden-set";
import { runSingleAgent } from "@/evals/single-agent";
import { finalValue } from "@/lib/ai/live";
import { summarizeUsage, withUsage } from "@/lib/ai/usage";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";

export type { SystemName } from "@/evals/checks";
export { SystemFailedError } from "@/evals/errors";

type Question = Pick<GoldenItem, "question" | "desk">;

/** Asks the two-agent Ask Copper, exactly as the chat does, and records what happened. */
export async function runTwoAgent(item: Question): Promise<RunOutput> {
  const { progress } = await askCopper({
    messages: [{ role: "user", content: item.question }],
    useTools: true,
    desk: item.desk,
  });
  const final = await finalValue(progress);
  if (final.status === "error") throw new SystemFailedError();
  return {
    reply: final.reply,
    answeredBy: final.agent,
    tools: toolCallsOf(final),
  };
}

/** Runs a system and adds what the answer cost: model calls, tokens, money and time. */
function measured(run: (item: Question) => Promise<RunOutput>) {
  return async (item: Question): Promise<RunOutput> => {
    const started = performance.now();
    const { value, calls } = await withUsage(() => run(item));
    return {
      ...value,
      usage: summarizeUsage(
        calls,
        performance.now() - started,
        value.tools.length,
      ),
    };
  };
}

export const SYSTEMS: Record<
  SystemName,
  (item: Question) => Promise<RunOutput>
> = {
  "two-agent": measured(runTwoAgent),
  "single-agent": measured(runSingleAgent),
};
