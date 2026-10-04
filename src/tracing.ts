import { LangfuseSpanProcessor } from "@langfuse/otel";
import { getActiveTraceId, propagateAttributes, startActiveObservation, type LangfuseObservation, type LangfuseObservationAttributes } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | undefined;
let processor: LangfuseSpanProcessor | undefined;
let initialized = false;

function initializeTracing(): boolean {
  if (initialized) return Boolean(sdk);
  initialized = true;
  if (process.env.LANGFUSE_TRACING_ENABLED === "false") return false;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    if (publicKey || secretKey) console.warn("Langfuse tracing disabled: set both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.");
    return false;
  }
  try {
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && value && value.length >= 8)
      .map(([, value]) => value!);
    processor = new LangfuseSpanProcessor({
      publicKey, secretKey, timeout: 5,
      mask: ({ data }) => maskCredentials(data, secrets),
    });
    sdk = new NodeSDK({ spanProcessors: [processor], autoDetectResources: false });
    sdk.start();
    return true;
  } catch {
    sdk = undefined;
    processor = undefined;
    console.warn("Could not initialize Langfuse tracing; continuing without traces.");
    return false;
  }
}

type UpdateObservation = (attributes: LangfuseObservationAttributes) => void;

function maskCredentials(data: unknown, secrets: string[]): unknown {
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === "object") return JSON.stringify(maskCredentials(parsed, secrets));
    } catch { /* Plain text is masked below. */ }
    let masked = data.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
    for (const secret of secrets) masked = masked.replaceAll(secret, "[REDACTED]");
    return masked;
  }
  if (Array.isArray(data)) return data.map((value) => maskCredentials(value, secrets));
  if (data && typeof data === "object") {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [
      key, /^(?:authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?key)$/i.test(key)
        ? "[REDACTED]" : maskCredentials(value, secrets),
    ]));
  }
  return data;
}

export async function traceOperation<T>(
  name: string,
  type: "agent" | "generation" | "tool",
  attributes: LangfuseObservationAttributes,
  run: (update: UpdateObservation) => Promise<T>,
  userId?: string,
  sessionId?: string,
): Promise<T> {
  if (!initializeTracing()) return run(() => {});
  const root = !getActiveTraceId();
  const observe = async (observation: LangfuseObservation) => {
    const update: UpdateObservation = (values) => {
      try { observation.updateOtelSpanAttributes(values); }
      catch { console.warn("Could not update Langfuse observation."); }
    };
    update(attributes);
    try {
      return await run(update);
    } catch (error) {
      update({ level: "ERROR", statusMessage: "Operation failed; see output.", output: { error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  };
  const start = () => {
    switch (type) {
      case "agent": return startActiveObservation(name, observe, { asType: "agent" });
      case "generation": return startActiveObservation(name, observe, { asType: "generation" });
      case "tool": return startActiveObservation(name, observe, { asType: "tool" });
    }
  };
  try {
    return await (userId ? propagateAttributes({ userId, ...(sessionId ? { sessionId } : {}), ...(root ? { traceName: name, tags: ["pekka"] } : {}) }, start) : start());
  } finally {
    if (root) await flushTracing();
  }
}

export async function flushTracing(): Promise<void> {
  try { await processor?.forceFlush(); }
  catch { console.warn("Could not export Langfuse traces; check your credentials and LANGFUSE_BASE_URL."); }
}

export async function shutdownTracing(): Promise<void> {
  try { await sdk?.shutdown(); }
  catch { console.warn("Could not shut down Langfuse tracing cleanly."); }
}
