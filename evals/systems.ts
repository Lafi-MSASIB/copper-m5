// The systems under test: which support setup answers the golden-set questions.
// Today there is one, the two-agent Ask Copper (Copper plus the Refund agent).
// A single do-everything agent will be added here so both can be run on the same
// questions and compared in Langfuse.
import type { RunOutput } from "@/evals/checks";
import type { GoldenItem } from "@/evals/golden-set";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";

export type SystemName = "two-agent";

/** The system couldn't produce an answer (for example Google's free daily limit is used up). */
export class SystemFailedError extends Error {
  constructor() {
    super(
      "Ask Copper hit an error and gave no real answer. A common cause is Google's free daily limit; the evaluation can't score this question.",
    );
    this.name = "SystemFailedError";
  }
}

/** Asks the two-agent Ask Copper, exactly as the chat does, and records what happened. */
export async function runTwoAgent(
  item: Pick<GoldenItem, "question" | "desk">,
): Promise<RunOutput> {
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

export const SYSTEMS: Record<
  SystemName,
  (item: Pick<GoldenItem, "question" | "desk">) => Promise<RunOutput>
> = {
  "two-agent": runTwoAgent,
};
