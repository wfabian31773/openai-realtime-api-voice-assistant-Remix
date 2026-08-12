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

/**
 * SDK tools for the named library tools, in the order given.
 *
 * Throws on an unknown name, at agent-construction time. A missing tool is a
 * deployment mistake and it should surface when the agent is built, not
 * silently on the one call that needed it.
 */
export function realtimeToolsFor(names: string[]): ReturnType<typeof tool>[] {
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
      execute: async (input: unknown) => {
        const result = await runTool(def.name, (input ?? {}) as Record<string, unknown>);
        return JSON.stringify(result);
      },
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
