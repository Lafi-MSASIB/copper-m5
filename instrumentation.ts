// Runs once when the server starts. It switches on Langfuse tracing (see
// lib/ai/langfuse.ts), which does nothing unless the Langfuse keys are set.
export async function register() {
  // Tracing needs Node.js, not the Edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTracing } = await import("@/lib/ai/langfuse");
    startTracing();
  }
}
