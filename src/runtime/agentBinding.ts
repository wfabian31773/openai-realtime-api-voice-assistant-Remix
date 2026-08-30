/**
 * src/runtime/agentBinding.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR-001 layer 2: **agents as configuration.** Takes an agent exactly as
 * this repo already builds it — `createAnsweringServiceAgent`,
 * `createSurgeryAgent`, any of them — and exposes the two things the voice
 * runtime needs: the instructions to speak under, and the tools to offer.
 *
 * It BORROWS. It does not reimplement, wrap, or "improve" an agent:
 *
 *   agent.instructions  the real system prompt, built by the agent's own
 *                       builder with its own context
 *   agent.tools         the real tools, with the real `invoke` that does
 *                       the real work (files the real ticket)
 *
 * This is the `src/standalone/claudeBrain.ts` pattern, which already proved
 * the approach against a different provider. Production agent files are
 * never edited (standing instruction 5), and the agent is unchanged by the
 * pipeline swap (standing instruction 2: *same exact agent, different voice
 * pipeline*).
 *
 * ## Tool schemas — the rule that cost most of 2026-08-12
 *
 * `.agents/memory/realtime-tool-schemas.md`: a generated schema registered
 * with `strict: true` silently rejected the model's call BEFORE `execute`
 * ran — no HTTP request, no log line, no timeline event, indistinguishable
 * from a model that chose not to call the tool. The cause was a Zod
 * translation that made every property `.nullable()` (still required) and
 * never `.optional()`.
 *
 * So: **pass the tool's OWN schema through untouched wherever possible, and
 * never assert strict.** Zod is converted only when a tool actually carries
 * Zod, and a schema that cannot be converted still yields a usable tool
 * rather than a dropped one — an untyped tool the model can call beats a
 * perfectly-typed tool that silently is not there.
 *
 * ## Every tool call must be answered
 *
 * The wire stalls if a `function_call_output` never arrives, and a stalled
 * call is dead air. `dispatch` therefore NEVER throws: an unknown tool, a
 * malformed payload, or a tool that throws all come back as a structured
 * result the session can hand straight to the provider.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { GrokToolDefinition } from './wireTypes';

/** A live tool as the Agents SDK holds it: name, schema, and the real
 * implementation. `invoke` takes the arguments as a JSON STRING. */
export interface LiveTool {
  name?: string;
  description?: string;
  parameters?: unknown;
  invoke?: (ctx: unknown, input: string) => Promise<unknown>;
}

/** The shape every agent factory in `src/agents/` already returns. */
export interface BorrowableAgent {
  instructions?: unknown;
  tools?: unknown;
}

export interface ToolDispatchResult {
  ok: boolean;
  /** Exactly what goes into the `function_call_output` payload. */
  output: string;
  /** Populated when the runtime refused or the tool failed — for the call
   * record, never for the caller's ears. */
  error?: string;
}

/**
 * An output guardrail as the agents declare them — structurally identical to
 * the SDK's `RealtimeOutputGuardrail`, typed locally so the runtime does not
 * import agent-SDK types. Each is a pure predicate over the agent's spoken
 * text; `execute` never sees audio and never touches the wire.
 */
export interface OutputGuardrail {
  name: string;
  /** Guidance for the corrective turn when this trips. Never spoken verbatim. */
  policyHint?: string;
  execute(input: {
    agentOutput: string;
  }): Promise<{ tripwireTriggered: boolean; outputInfo?: unknown }>;
}

export interface BoundAgent {
  /** The agent's own system prompt, verbatim. */
  instructions: string;
  /** The agent's tools in Grok wire form. */
  tools: GrokToolDefinition[];
  /**
   * The agent's own output guardrails, verbatim — the same objects the SDK
   * would run on the SIP path. Four agents set them (pcpAgent: no diagnosis /
   * no medication advice / no unverified disclosure; noIvrAgent, noIvrAgentV2,
   * azulSchedulingAgent: medicalSafetyGuardrails), and every one of those is
   * a transfer-capable lane — exactly the lanes the transfer work makes
   * servable. Borrowing instructions and tools but not these would put the
   * medical-facing agents on a transport where their safety rules silently
   * do not exist.
   */
  guardrails: OutputGuardrail[];
  /** Names offered to the model — the allow-list `dispatch` enforces. */
  toolNames: string[];
  /** Tools the agent declared but that cannot be offered (no name, or no
   * implementation to run). Surfaced rather than silently dropped: a tool
   * that vanishes looks exactly like a model that would not call it. */
  skipped: Array<{ name: string; reason: 'no name' | 'no implementation' }>;
  dispatch(name: string, args: Record<string, unknown>): Promise<ToolDispatchResult>;
}

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  required: [],
};

/** Best-effort JSON Schema for one tool. Never throws: an unconvertible
 * schema yields the permissive object schema so the tool still exists. */
export function toJsonSchema(parameters: unknown): Record<string, unknown> {
  try {
    if (parameters && typeof parameters === 'object') {
      if ('_def' in (parameters as Record<string, unknown>)) {
        const json = zodToJsonSchema(parameters as never, { target: 'openApi3' }) as Record<
          string,
          unknown
        >;
        delete json.$schema;
        return json;
      }
      return parameters as Record<string, unknown>;
    }
  } catch {
    /* fall through — an untyped tool beats a missing one */
  }
  return { ...EMPTY_OBJECT_SCHEMA };
}

export function toGrokTools(tools: LiveTool[]): {
  defs: GrokToolDefinition[];
  skipped: BoundAgent['skipped'];
} {
  const defs: GrokToolDefinition[] = [];
  const skipped: BoundAgent['skipped'] = [];
  for (const t of tools) {
    if (!t?.name) {
      skipped.push({ name: '(unnamed)', reason: 'no name' });
      continue;
    }
    if (typeof t.invoke !== 'function') {
      // Offering a tool we cannot run would let the model promise something
      // that never happens — the same class of harm as a transfer tool on a
      // line that cannot transfer (standing instruction 9).
      skipped.push({ name: t.name, reason: 'no implementation' });
      continue;
    }
    defs.push({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      // The tool's own schema, unchanged. NEVER strict — see the header.
      parameters: toJsonSchema(t.parameters),
    });
  }
  return { defs, skipped };
}

/**
 * Bind a built agent to the runtime.
 *
 * `instructionsPrefix` is prepended verbatim and is where the runtime's
 * stable practice-knowledge pack goes. It comes FIRST and is byte-identical
 * per lane, so the whole prefix caches (ADR-001's caching section); anything
 * that varies per call must be appended by the caller, never injected here.
 */
/**
 * The agent's prompt as TEXT, evaluating it when it is a closure.
 *
 * Several agents build their prompt with a function so a time-dependent
 * tail stays fresh behind a stable cached prefix — `azulSchedulingAgent`
 * (`instructions: () => buildAzulSchedulingPrompt(metadata)`) and
 * `afterHoursAgent` both do. On the SIP path the SDK evaluates that closure
 * inside `getSystemPrompt()`, reached from `connect()`. This runtime does
 * not go through the SDK's session, so it has to do the same thing itself:
 * stringifying the function instead sends Grok the literal source text
 * `() => buildAzulSchedulingPrompt(metadata)` as the system prompt, and the
 * lane loses its entire workflow and its safety rules while looking
 * perfectly healthy (Codex review, PR #227).
 *
 * `String(fn)` is never a fallback here. A prompt that cannot be resolved
 * throws, the lane is refused, and the caller hears the controlled
 * unavailable line — the same reasoning as the empty-prompt guard below.
 */
async function resolveInstructions(agent: BorrowableAgent): Promise<string> {
  const raw = (agent as { instructions?: unknown }).instructions;
  if (typeof raw === 'string') return raw;

  // The SDK's own contract first, since it is what the SIP transport relies
  // on and what an agent's closure is written to be called by.
  const viaSdk = (agent as { getSystemPrompt?: (ctx: unknown) => Promise<string | undefined> })
    .getSystemPrompt;
  if (typeof viaSdk === 'function') {
    try {
      const resolved = await viaSdk.call(agent, {});
      if (typeof resolved === 'string' && resolved.trim()) return resolved;
    } catch {
      // Fall through to calling the closure directly.
    }
  }
  if (typeof raw === 'function') {
    const resolved = await (raw as () => unknown)();
    if (typeof resolved === 'string') return resolved;
  }
  return '';
}

export async function bindAgent(
  agent: BorrowableAgent,
  opts: { instructionsPrefix?: string } = {},
): Promise<BoundAgent> {
  const own = await resolveInstructions(agent);
  if (!own.trim()) {
    // The agent's prompt IS the agent. Running without it would put a
    // nameless improviser on a patient line.
    throw new Error('agentBinding: the agent produced no instructions');
  }
  const prefix = opts.instructionsPrefix?.trim() ? `${opts.instructionsPrefix.trim()}\n\n` : '';
  const instructions = `${prefix}${own}`;

  const live = (Array.isArray(agent.tools) ? agent.tools : []) as LiveTool[];
  const { defs, skipped } = toGrokTools(live);
  const byName = new Map<string, LiveTool>();
  for (const t of live) if (t?.name && typeof t.invoke === 'function') byName.set(t.name, t);

  // Borrowed exactly as declared — a malformed entry is dropped rather than
  // crashing the call, but never silently: it is the same "surfaced, not
  // swallowed" rule the skipped-tools list follows.
  const declaredGuardrails = (agent as { outputGuardrails?: unknown }).outputGuardrails;
  const guardrails: OutputGuardrail[] = (
    Array.isArray(declaredGuardrails) ? declaredGuardrails : []
  ).filter((g): g is OutputGuardrail => {
    const ok =
      Boolean(g) &&
      typeof (g as OutputGuardrail).name === 'string' &&
      typeof (g as OutputGuardrail).execute === 'function';
    if (!ok) console.warn('[agentBinding] dropped a malformed output guardrail', g);
    return ok;
  });

  return {
    instructions,
    tools: defs,
    guardrails,
    toolNames: defs.map((d) => d.name),
    skipped,
    async dispatch(name: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
      const tool = byName.get(name);
      if (!tool) {
        // Defense in depth: the model was never offered this name.
        return {
          ok: false,
          output: JSON.stringify({ ok: false, error: 'unknown_tool' }),
          error: `unknown tool: ${name}`,
        };
      }
      try {
        const result = await tool.invoke!({}, JSON.stringify(args ?? {}));
        const output = typeof result === 'string' ? result : JSON.stringify(result ?? null);
        return { ok: true, output };
      } catch (err) {
        // A throwing tool must not become a stalled turn. The provider gets
        // a real answer; the record gets the reason.
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          output: JSON.stringify({ ok: false, error: 'tool_failed' }),
          error: message,
        };
      }
    },
  };
}
