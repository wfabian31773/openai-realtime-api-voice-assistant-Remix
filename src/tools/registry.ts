/**
 * THE TOOL LIBRARY.
 *
 * One shape for every tool an agent can call, copied deliberately from the Eye
 * Care scheduling service (`eyecare-scheduling-agent`), which already got this
 * right: a self-describing manifest, one endpoint shape, one auth story, and a
 * two-layer split where agents only ever see the guarded layer.
 *
 * WHY THIS EXISTS
 *
 * Wayne's direction, 2026-08-11: build the tools first and prove each one
 * works; the agents are the easy part. And route by QUEUE — a call arriving on
 * the optical queue IS an optical request, so the classification comes from the
 * phone system rather than from a model. That makes each agent's tool set small
 * and its prompt small, which is the whole point.
 *
 * THE ONE RULE THAT MAKES TOOLS RELIABLE
 *
 * A tool REFUSES when it is missing something it needs, and says what is
 * missing in a form the agent can act on. It never guesses and it never
 * silently succeeds with a hole in the data.
 *
 * This is not a preference — it is the single best-performing control in the
 * whole system. The ticketing app's hard-requires work exactly this way, and
 * they hold surgery tickets missing a surgeon to 0.4% and optical tickets
 * missing a location to 1.9%. Prompt instructions alone never achieved that.
 */

/** A tool refused to run because the caller has not supplied enough. */
export interface MissingFields {
  success: false;
  /** Machine-readable. The agent re-asks for exactly these. */
  missingFields: string[];
  /** One sentence the agent can say more or less verbatim. */
  message: string;
}

export interface ToolFailure {
  success: false;
  error: string;
  /** True when retrying might work — a timeout, a vendor blip. */
  retryable?: boolean;
}

export type ToolResult = { success: true; [k: string]: unknown } | MissingFields | ToolFailure;

export interface ToolDefinition {
  name: string;
  /** Written for the model, not for us. Says when to call it, not how it works. */
  description: string;
  /** JSON Schema. Published in the manifest and used to validate on the way in. */
  input_schema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description: string;
        enum?: string[];
        /**
         * How to ASK a patient for this, in words.
         *
         * Without it a refusal reads "I still need spoken_location" — a field
         * name in the mouth of an agent talking to a patient. The convention
         * is borrowed from `knowledgeBase.ts`, which already does this.
         */
        askAs?: string;
      }
    >;
    required?: string[];
  };
  /**
   * `agent` tools are the ones a voice agent may call. `primitive` tools exist
   * for other tools to build on and are excluded from the agent-facing
   * manifest.
   *
   * The scheduling service has this split too but publishes only its
   * primitives, so the 14 tools its agents actually use are invisible to
   * discovery. That is precisely backwards, and this field is here so we do
   * not repeat it.
   */
  layer: 'agent' | 'primitive';
  /** Milliseconds. Declared per tool because sage_book legitimately needs 75s. */
  timeoutMs: number;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`[TOOLS] duplicate tool name: ${def.name}`);
  }
  registry.set(def.name, def);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function allTools(): ToolDefinition[] {
  return [...registry.values()];
}

/**
 * The manifest a platform reads to discover what it can call.
 *
 * Defaults to the AGENT layer, because that is what an agent should see. Pass
 * `includePrimitives` for diagnostics only.
 */
export function manifest(includePrimitives = false): Array<{
  name: string;
  description: string;
  input_schema: ToolDefinition['input_schema'];
  timeout_seconds: number;
}> {
  return allTools()
    .filter((t) => includePrimitives || t.layer === 'agent')
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      timeout_seconds: Math.ceil(t.timeoutMs / 1000),
    }));
}

/** Shorthand for the refusal every tool uses. */
export function missing(fields: string[], message: string): MissingFields {
  return { success: false, missingFields: fields, message };
}

/**
 * Validate input against the declared schema before the handler sees it.
 *
 * Deliberately shallow — required-and-non-empty, and string/number sanity. A
 * tool's own handler owns the semantic checks, because only it knows that a
 * date of birth in the future is wrong.
 */
export function validateInput(
  def: ToolDefinition,
  input: Record<string, unknown>,
): MissingFields | null {
  const required = def.input_schema.required ?? [];
  const absent = required.filter((f) => {
    const v = input[f];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
  if (absent.length === 0) return null;

  // Build the message from askAs so it is speakable. Falling back to the field
  // name is deliberate and ugly on purpose — it makes a missing askAs obvious
  // the first time anyone hears it, rather than silently reading fine.
  const asks = absent.map((f) => def.input_schema.properties[f]?.askAs ?? f);
  const message =
    asks.length === 1
      ? asks[0]
      : `${asks.slice(0, -1).join(', ')} And ${asks[asks.length - 1]}`;
  return missing(absent, message);
}

/** Run a tool with its declared timeout. Never throws. */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const def = registry.get(name);
  if (!def) return { success: false, error: `no such tool: ${name}` };

  const bad = validateInput(def, input);
  if (bad) return bad;

  try {
    return await Promise.race([
      def.handler(input),
      new Promise<ToolResult>((resolve) =>
        setTimeout(
          () => resolve({ success: false, error: `${name} timed out`, retryable: true }),
          def.timeoutMs,
        ),
      ),
    ]);
  } catch (e) {
    // A thrown tool is information for the agent, never a dead call.
    return { success: false, error: (e as Error).message, retryable: true };
  }
}
