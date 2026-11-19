// Errors the evaluation raises itself, kept apart so every system can use them.

/** The system couldn't produce an answer (for example Google's free daily limit is used up). */
export class SystemFailedError extends Error {
  constructor() {
    super(
      "Ask Copper hit an error and gave no real answer. A common cause is Google's free daily limit; the evaluation can't score this question.",
    );
    this.name = "SystemFailedError";
  }
}
