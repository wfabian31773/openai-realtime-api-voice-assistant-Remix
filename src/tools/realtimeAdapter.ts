/**
 * The tool library, as the Realtime SDK wants to see it.
 *
 * The whole point of the library is that there is ONE definition of each tool.
 * An agent that redeclared its own `tool({...})` beside the registry would be a
 * second copy, and a second copy drifts — that is how the practice ended up
 * with provider names in four shapes and a locations table nobody refreshed.
 *
 * So agents do not define tools. They name the ones they need, and this turns
 * the registry entries into SDK tools: same schema, same handler, same refusal
 * contract, same timeout. What an agent calls on a live call and what a managed
 * platform calls over HTTP are the same code path.
 */
import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { getTool, runTool } from './registry';
import { recordingExecute } from '../services/toolTimeline';

/**
 * Who is calling, for the tool timeline.
 *
 * `callLogId` is declared as a getter-friendly property rather than a value on
 * purpose: the id does not exist when the agent is built, it is resolved a
 * moment later. Reading it eagerly freezes `undefined` — the exact bug that put
 * VA-50813 on the board with a null call_sid. Pass an object with a getter and
 * it is read at tool-call time, when the answer is known.
 */
export interface ToolTelemetry {
  callId?: string;
  callSid?: string;
  readonly callLogId?: string;
  /** The queue, so a call's tools can be attributed to the line that took it. */
  agentSlug: string;
}

/**
 * SDK tools for the named library tools, in the order given.
 *
 * Throws on an unknown name, at agent-construction time. A missing tool is a
 * deployment mistake and it should surface when the agent is built, not
 * silently on the one call that needed it.
 */
export function realtimeToolsFor(
  names: string[],
  /**
   * Values the CALL knows and the model must not be asked for.
   *
   * `call_sid` is the case that forced this. VA-50813 — the Optical line's
   * first working call — filed with `call_sid: null`, because the tool accepts
   * it as an input and the model simply never passed it. Without it,
   * `update-call-data` can never match the ticket to the call, so the
   * recording, transcript and summary are not merely late, they are
   * unattachable forever. No prompt instruction should be load-bearing for a
   * value the process already holds.
   *
   * Merged UNDER the model's arguments, and the model cannot blank one: strict
   * mode makes every field present-and-nullable, so an unset argument arrives
   * as null and would otherwise overwrite what we injected.
   */
  context: Record<string, unknown> = {},
  /**
   * Recording target. Without it these tools are invisible: `tool_timeline` and
   * `tool_call_count` stay null on the call row, which is how both Surgery
   * lines failed to file a ticket on 2026-08-12 and left NOTHING anywhere I
   * could read — no event, no error, no argument list. The answering service
   * has had this since it was built (`recordedTool`); the shared library never
   * did, so every queue built on it was blind.
   *
   * Optional so the HTTP surface, which has no call, does not have to invent
   * one. Recording never changes what a tool returns and never throws into it.
   */
  telemetry?: ToolTelemetry,
): ReturnType<typeof tool>[] {
  return names.map((name) => {
    const def = getTool(name);
    if (!def) {
      throw new Error(
        `[TOOLS] ${name} is not registered — check the import side effects in the agent module`,
      );
    }
    if (def.layer !== 'agent') {
      throw new Error(`[TOOLS] ${name} is a primitive and must not be given to an agent`);
    }

    // The SDK's `tool()` infers its argument type from a literal Zod shape.
    // These shapes are built at runtime from the registry, so there is nothing
    // for it to infer from and the generic collapses to `never`. The cast is
    // the adapter's whole reason to exist: it is confined to this one call, and
    // the shape it produces is a real z.object either way.
    const options = {
      name: def.name,
      description: def.description,
      parameters: toZod(def),
      // The SDK requires strict mode for Zod parameters, and strict mode
      // requires every property to be present. See toZod: everything is
      // nullable, so "I do not have this" is expressible as null — which
      // validateInput already treats as missing. The two contracts line up.
      strict: true,
      // runTool applies the declared timeout and never throws, so a tool that
      // fails returns something the model can read and act on rather than
      // ending the turn. The string is what the model sees.
      execute: wrapWithTelemetry(def.name, telemetry, async (input: unknown) => {
        const supplied = Object.fromEntries(
          Object.entries((input ?? {}) as Record<string, unknown>).filter(
            ([, v]) => v !== null && v !== undefined,
          ),
        );
        const result = await runTool(def.name, { ...context, ...supplied });
        return JSON.stringify(result);
      }),
    } as unknown as Parameters<typeof tool>[0];

    return tool(options);
  });
}

/**
 * The registry's JSON Schema as the Zod schema the SDK wants.
 *
 * Note what this does NOT do: it does not enforce required-ness. Every field is
 * optional here, and refusal is left to the registry's own `validateInput`.
 *
 * That is deliberate. A schema-level rejection comes back to the model as a
 * malformed-arguments error with no guidance in it; the registry's refusal
 * comes back as `{missingFields, message}` where the message is a sentence the
 * agent can say to the patient — "And your date of birth?" — which is the
 * behaviour holding surgery-missing-surgeon to 0.4% and optical-missing-location
 * to 2.1%. Letting the call reach the handler and be refused properly is worth
 * more than blocking it a layer earlier.
 */
function toZod(def: NonNullable<ReturnType<typeof getTool>>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(def.input_schema.properties)) {
    const base = spec.enum?.length
      ? z.enum(spec.enum as [string, ...string[]])
      : spec.type === 'number'
        ? z.number()
        : spec.type === 'boolean'
          ? z.boolean()
          : z.string();
    // Nullable, never optional. Strict mode requires every property to be
    // present, so "I do not have this yet" has to be sayable — and null is how
    // the model says it. validateInput already reads null as missing, so a
    // half-supplied call still reaches the handler and comes back as a proper
    // refusal with a sentence in it, rather than as a schema error the model
    // cannot act on.
    shape[key] = base.describe(spec.description).nullable();
  }
  return z.object(shape);
}

/**
 * Time and record the call, or pass it straight through when there is nothing
 * to record against.
 *
 * `recordingExecute` reads its context at call time, so the getter on
 * `callLogId` survives — see ToolTelemetry.
 */
function wrapWithTelemetry(
  name: string,
  telemetry: ToolTelemetry | undefined,
  execute: (input: unknown) => Promise<string>,
): (input: unknown) => Promise<string> {
  if (!telemetry) return execute;
  if (!telemetry.callId && !telemetry.callSid) return execute;
  return recordingExecute<unknown, string>(
    {
      callId: telemetry.callId,
      callSid: telemetry.callSid,
      get callLogId() {
        return telemetry.callLogId;
      },
      agentSlug: telemetry.agentSlug,
    },
    name,
    execute,
  );
}
