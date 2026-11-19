// The tracing helper (lib/ai/langfuse.ts): it switches on only when the Langfuse
// keys are set, starts once, labels the trace and each agent, and can never stop
// the chat from running. The Langfuse libraries are faked, so nothing is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  registerTelemetry: vi.fn(),
  forceFlush: vi.fn(async () => {}),
  providerRegister: vi.fn(),
  processorOptions: [] as unknown[],
  propagate: vi.fn(),
  observations: [] as {
    name: string;
    options: unknown;
    update: ReturnType<typeof vi.fn>;
  }[],
  startFails: false,
}));

vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: class {
    forceFlush = fake.forceFlush;
    constructor(options: unknown) {
      fake.processorOptions.push(options);
    }
  },
}));
vi.mock("@langfuse/tracing", () => ({
  propagateAttributes: (params: unknown, run: () => unknown) => {
    fake.propagate(params);
    return run();
  },
  startActiveObservation: async (
    name: string,
    run: (span: unknown) => unknown,
    options?: unknown,
  ) => {
    // Tracing breaking before it starts the work.
    if (fake.startFails) throw new Error("tracing broke");
    const update = vi.fn();
    fake.observations.push({ name, options, update });
    return run({ update });
  },
}));
vi.mock("@langfuse/vercel-ai-sdk", () => ({
  LangfuseVercelAiSdkIntegration: class {},
}));
vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    register = fake.providerRegister;
  },
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  registerTelemetry: fake.registerTelemetry,
}));

const STARTED = Symbol.for("copper.langfuse.tracing");

function setKeys(on: boolean) {
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", on ? "pk-lf-test" : "");
  vi.stubEnv("LANGFUSE_SECRET_KEY", on ? "sk-lf-test" : "");
  vi.stubEnv("LANGFUSE_BASE_URL", on ? "https://us.cloud.langfuse.com" : "");
}

async function load() {
  vi.resetModules();
  return import("@/lib/ai/langfuse");
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.processorOptions.length = 0;
  fake.observations.length = 0;
  fake.startFails = false;
  delete (globalThis as Record<symbol, unknown>)[STARTED];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("when the Langfuse keys are not set", () => {
  beforeEach(() => setKeys(false));

  it("is not configured, starts nothing and registers nothing", async () => {
    const { isTracingConfigured, startTracing } = await load();
    expect(isTracingConfigured()).toBe(false);
    expect(startTracing()).toBeNull();
    expect(fake.registerTelemetry).not.toHaveBeenCalled();
    expect(fake.providerRegister).not.toHaveBeenCalled();
  });

  it("still runs the work: a turn and an agent just return their result", async () => {
    const { traceTurn, traceAgent } = await load();
    const turn = await traceTurn(
      { name: "ask-copper", input: "hi" },
      async () => "turn result",
    );
    const agent = await traceAgent("copper", async () => "agent result");
    expect(turn).toBe("turn result");
    expect(agent).toBe("agent result");
    expect(fake.observations).toHaveLength(0);
  });

  it("flushing does nothing and doesn't throw", async () => {
    const { flushTraces } = await load();
    await expect(flushTraces()).resolves.toBeUndefined();
    expect(fake.forceFlush).not.toHaveBeenCalled();
  });
});

describe("when the Langfuse keys are set", () => {
  beforeEach(() => setKeys(true));

  it("needs all three: the public key, the secret key and the host", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    const { isTracingConfigured } = await load();
    expect(isTracingConfigured()).toBe(false);
  });

  it("starts once: one exporter, one provider, one registration, however often it is called", async () => {
    const { startTracing } = await load();
    const first = startTracing();
    const second = startTracing();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(fake.processorOptions).toEqual([{ exportMode: "immediate" }]);
    expect(fake.providerRegister).toHaveBeenCalledTimes(1);
    expect(fake.registerTelemetry).toHaveBeenCalledTimes(1);
  });

  it("names the trace, tags it, and records what came in and what went out", async () => {
    const { traceTurn } = await load();
    const result = await traceTurn(
      {
        name: "ask-copper",
        input: "Can I get a refund?",
        tags: ["tools"],
        metadata: { useTools: true },
      },
      async (finish) => {
        finish({ reply: "Sure." });
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(fake.propagate).toHaveBeenCalledWith({
      traceName: "ask-copper",
      tags: ["tools"],
      metadata: { useTools: true },
      environment: "development",
    });
    const turn = fake.observations[0];
    expect(turn.name).toBe("ask-copper");
    expect(turn.update).toHaveBeenCalledWith({ input: "Can I get a refund?" });
    expect(turn.update).toHaveBeenCalledWith({ output: { reply: "Sure." } });
  });

  it("labels the environment: development locally, production on Vercel, or what CI sets", async () => {
    const { tracingEnvironment } = await load();
    expect(tracingEnvironment()).toBe("development");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(tracingEnvironment()).toBe("production");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(tracingEnvironment()).toBe("development");
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "ci");
    expect(tracingEnvironment()).toBe("ci");
  });

  it("gives the service a proper name", async () => {
    vi.stubEnv("OTEL_SERVICE_NAME", "");
    delete process.env.OTEL_SERVICE_NAME;
    const { startTracing } = await load();
    startTracing();
    expect(process.env.OTEL_SERVICE_NAME).toBe("copper-state-labs");
  });

  it("shows each agent as an agent observation", async () => {
    const { traceAgent } = await load();
    await traceAgent("refund-agent", async () => "ok");
    expect(fake.observations[0].name).toBe("refund-agent");
    expect(fake.observations[0].options).toEqual({ asType: "agent" });
  });

  it("runs the work untraced if tracing breaks before the work starts", async () => {
    fake.startFails = true;
    const { traceTurn, traceAgent } = await load();
    const run = vi.fn(async () => "answer");
    expect(await traceTurn({ name: "ask-copper", input: "hi" }, run)).toBe(
      "answer",
    );
    expect(await traceAgent("copper", run)).toBe("answer");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("doesn't hide an error from the work itself", async () => {
    const { traceTurn, traceAgent } = await load();
    await expect(
      traceTurn({ name: "ask-copper", input: "hi" }, async () => {
        throw new Error("the model failed");
      }),
    ).rejects.toThrow("the model failed");
    await expect(
      traceAgent("copper", async () => {
        throw new Error("the model failed");
      }),
    ).rejects.toThrow("the model failed");
  });

  it("sends the waiting spans when flushed, and a failure to send never throws", async () => {
    const { startTracing, flushTraces } = await load();
    startTracing();
    await flushTraces();
    expect(fake.forceFlush).toHaveBeenCalledTimes(1);

    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.forceFlush.mockRejectedValueOnce(new Error("network down"));
    await expect(flushTraces()).resolves.toBeUndefined();
  });
});
