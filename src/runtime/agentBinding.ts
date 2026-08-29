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

export interface BoundAgent {
  /** The agent's own system prompt, verbatim. */
  instructions: string;
  /** The agent's tools in Grok wire form. */
  tools: GrokToolDefinition[];
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
export function bindAgent(
  agent: BorrowableAgent,
  opts: { instructionsPrefix?: string } = {},
): BoundAgent {
  const raw = agent.instructions;
  const own = typeof raw === 'string' ? raw : String(raw ?? '');
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

  return {
    instructions,
    tools: defs,
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
