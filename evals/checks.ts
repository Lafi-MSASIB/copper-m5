// The plain-code checks on an answer: no AI involved, so they are fast, free and
// the same every time. They cover what can be measured exactly: which tools
// were used, whether a page was cited, who answered, and what the app itself
// decided about a refund (the model never decides that).
import type { Expected } from "@/evals/golden-set";
import type { Usage } from "@/lib/ai/usage";

export type ToolCall = { name: string; input: unknown; output: unknown };

/** The two ways to build the support assistant that are compared. */
export type SystemName = "two-agent" | "single-agent";

/** What one run of Ask Copper produced for one question. */
export type RunOutput = {
  reply: string;
  /** The agent that finished the answer, when there was more than one. */
  answeredBy?: "copper" | "refund";
  tools: ToolCall[];
  /** What the answer cost in model calls, tokens and time. */
  usage?: Usage;
};

export type Check = { name: string; passed: boolean; comment: string };

const plain = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/** What request_refund reported (the last time it was called), if it was called. */
export function refundResultOf(out: RunOutput): string | undefined {
  const call = out.tools.findLast((t) => t.name === "request_refund");
  const output = call?.output as { status?: unknown } | undefined;
  return typeof output?.status === "string" ? output.status : undefined;
}

/**
 * Runs only the checks the question asks for, so every check that appears matters.
 * Only the two-agent system hands the chat over, so for the single agent the
 * hand-off and "who answered" expectations are left out; everything else (the
 * tools that do the work, the cited page, what the app decided about a refund)
 * is checked the same for both.
 */
export function runChecks(
  expected: Expected,
  out: RunOutput,
  system: SystemName = "two-agent",
): Check[] {
  const checks: Check[] = [];
  const used = new Set(out.tools.map((t) => t.name));
  const handsOver = system === "two-agent";
  const neededTools = (expected.tools ?? []).filter(
    (t) => handsOver || !t.startsWith("transfer_to_"),
  );

  if (neededTools.length) {
    const missing = neededTools.filter((t) => !used.has(t));
    checks.push({
      name: "tools_used",
      passed: missing.length === 0,
      comment: missing.length
        ? `Did not use: ${missing.join(", ")}. Used: ${[...used].join(", ") || "no tools"}.`
        : `Used ${neededTools.join(", ")}.`,
    });
  }

  if (expected.toolsNot?.length) {
    const wrong = expected.toolsNot.filter((t) => used.has(t));
    checks.push({
      name: "tools_not_used",
      passed: wrong.length === 0,
      comment: wrong.length
        ? `Used a tool it must not: ${wrong.join(", ")}.`
        : `Did not use ${expected.toolsNot.join(", ")}.`,
    });
  }

  if (expected.citations?.length) {
    const reply = plain(out.reply);
    const found = expected.citations.filter((c) => reply.includes(plain(c)));
    checks.push({
      name: "cited",
      passed: found.length > 0,
      comment: found.length
        ? `Cited ${found.join(" and ")}.`
        : `Cited none of: ${expected.citations.join("; ")}.`,
    });
  }

  if (handsOver && expected.answeredBy) {
    checks.push({
      name: "answered_by",
      passed: (out.answeredBy ?? "copper") === expected.answeredBy,
      comment: `Answered by ${out.answeredBy ?? "copper"}; expected ${expected.answeredBy}.`,
    });
  }

  const result = refundResultOf(out);
  if (expected.refundResult) {
    checks.push({
      name: "refund_result",
      passed: result === expected.refundResult,
      comment: `request_refund reported ${result ?? "nothing (it wasn't called)"}; expected ${expected.refundResult}.`,
    });
  }

  if (expected.neverRefunded) {
    checks.push({
      name: "no_refund_issued",
      passed: result !== "refunded",
      comment:
        result === "refunded"
          ? "A refund was issued, and it should not have been."
          : "No refund was issued.",
    });
  }

  if (expected.replyMustNotInclude?.length) {
    const reply = plain(out.reply);
    const leaked = expected.replyMustNotInclude.filter((t) =>
      reply.includes(plain(t)),
    );
    checks.push({
      name: "reply_clean",
      passed: leaked.length === 0,
      comment: leaked.length
        ? `The reply included: ${leaked.join("; ")}.`
        : "The reply included none of the forbidden text.",
    });
  }

  return checks;
}
