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
import { getTool, runTool } from './registry';
import { recordingExecute, flushAzulTimeline } from '../services/toolTimeline';

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
      // THE REGISTRY'S OWN JSON SCHEMA, not a Zod translation of it.
      //
      // This used to be `toZod(def)` with `strict: true`, and that combination
      // is what stopped `file_surgery_ticket` from ever running on a live call.
      //
      // toZod made every property `.nullable()` but never `.optional()`, so all
      // fifteen landed in `required`. Strict mode then demands the model emit
      // all fifteen keys — and on 2026-08-12 it emitted thirteen, omitting
      // `callback_number` and `description_prefix`. The SDK rejected the
      // arguments with "Invalid JSON input for tool" BEFORE calling execute, so
      // there was no handler run, no log line, no timeline event, and nothing
      // anywhere to see. The model got an error and told the caller it was
      // having trouble filing. Four live calls, all identical.
      //
      // file_optical_ticket has twelve properties and the model happened to
      // emit all twelve, which is the entire reason Optical filed and Surgery
      // did not. Nothing was wrong with either tool.
      //
      // The registry's schema already carries the RIGHT required list — five
      // fields for file_surgery_ticket, not fifteen — because that is what the
      // tool actually needs. Handing it over directly means a model may omit
      // what it does not have, `validateInput` refuses with a sentence the
      // agent can say out loud, and the caller is asked for the missing field
      // instead of hearing that the system is broken. That refusal contract is
      // the whole point of the library and it was unreachable.
      parameters: {
        ...def.input_schema,
        // Strict-adjacent hygiene, independent of the strict flag: never let a
        // model invent a field the handler will silently ignore.
        additionalProperties: false,
      },
      // NOT strict. Strict requires every property in `required`, which is the
      // constraint that caused this. The library refuses missing fields itself,
      // and it does it with words a patient can hear.
      strict: false,
      // runTool applies the declared timeout and never throws, so a tool that
      // fails returns something the model can read and act on rather than
      // ending the turn. The string is what the model sees.
      execute: wrapWithTelemetry(def.name, telemetry, async (input: unknown) => {
        const supplied = Object.fromEntries(
          Object.entries((input ?? {}) as Record<string, unknown>).filter(
            ([, v]) => v !== null && v !== undefined,
          ),
        );

        // ONE LINE IN, ONE LINE OUT — the same pair the HTTP surface writes.
        //
        // The tool timeline only reaches the database when the call ends and
        // flushes, so a tool still running at hangup leaves no record at all.
        // That is exactly the state `file_surgery_ticket` was in on three live
        // calls: invoked, never completed, nothing written anywhere. The same
        // handler filed VA-51058 in 4.9s over HTTP with identical arguments, so
        // the difference is the process, and the process had no logging.
        //
        // These two lines are unconditional and cheap. A tool that starts and
        // never finishes now says so, with a name and a timestamp, in the only
        // place that was still dark.
        const started = Date.now();
        console.info(`[TOOLS] → ${def.name} (${telemetry?.agentSlug ?? 'no-slug'})`);
        try {
          const result = await runTool(def.name, { ...context, ...supplied });
          const outcome =
            result.success === true
              ? 'ok'
              : 'missingFields' in result
                ? `refused:${result.missingFields.join(',')}`
                : `error:${(result as { error: string }).error}`;
          console.info(`[TOOLS] ← ${def.name} ${Date.now() - started}ms ${outcome}`);

          // PERSIST NOW, not at hangup.
          //
          // The timeline reaches the database only when the call ends and
          // flushes. A tool still running at that moment leaves no record at
          // all — and `file_surgery_ticket` has a 30s budget while a caller who
          // has just been told there is a problem hangs up in about that long.
          // Four consecutive live calls produced three tool events and nothing
          // for the fourth, which reads identically to "never called" and cost
          // most of a day.
          //
          // Flushing per tool makes the record independent of how long the call
          // survives. It is safe to call repeatedly: the flush writes a
          // superset and is idempotent by event count, and it never throws into
          // the caller — a telemetry failure must not break a patient's call.
          void flushTimelineSafely(telemetry);

          return JSON.stringify(result);
        } catch (err) {
          // runTool does not throw, so this is a defect in the adapter itself
          // rather than in a tool — and it would otherwise be silent.
          console.error(
            `[TOOLS] ✗ ${def.name} threw after ${Date.now() - started}ms:`,
            err,
          );
          throw err;
        }
      }),
    } as unknown as Parameters<typeof tool>[0];

    return tool(options);
  });
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

/**
 * Write the timeline out now, and never let that failure reach the call.
 *
 * Keyed on whichever id the recorder registered the entry under; the flush
 * falls back to scanning by callSid or callLogId, so either works.
 */
async function flushTimelineSafely(telemetry: ToolTelemetry | undefined): Promise<void> {
  const key = telemetry?.callId ?? telemetry?.callSid;
  if (!key) return;
  try {
    await flushAzulTimeline(key);
  } catch (e) {
    console.warn('[TOOLS] timeline flush failed (call unaffected):', e);
  }
}
