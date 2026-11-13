/**
 * src/services/toolInputRefusal.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A HAND-BUILT TOOL'S INPUT ERROR NAMES THE FIELD (v177; v173 while #426 was open).
 *
 * `tool()` from `@openai/agents` 0.3.7 parses the model's arguments with the
 * tool's zod schema inside `invoke` (`@openai/agents-core/dist/tool.js`). When
 * the parse fails it throws `ModelBehaviorError('Invalid JSON input for tool')`
 * — the zod issues are dropped — and the default error function turns that
 * into a STRING: "An error occurred while running the tool. Please try again.
 * Error: ModelBehaviorError: Invalid JSON input for tool".
 *
 * Three things go wrong at once, and all three were on one call:
 *
 *   1. The model is told nothing about WHICH field, and is told to try again,
 *      so it sends the same arguments again.
 *   2. The runtime reads a string as a success (`toolSucceeded` looks for
 *      `success: false` in an object), so the tool ceiling counts the loop as
 *      a SUCCESS loop: 10 identical, then 20 per tool.
 *   3. `execute` never runs, so `recordingExecute` never runs, and the call's
 *      `tool_timeline` holds no trace that the tool was called at all.
 *
 * CORPUS: `CAa36ae68ef6d5654594fe11253d30a942` (pcp, 2026-11-03 17:15 UTC).
 * The deployment log shows `record_pcp_intake not dispatched — 10 identical
 * successful calls` at 17:15:28 and four `20 successful calls` refusals by
 * 17:16:23; the timeline shows nine other tools refused
 * `call_purpose_required` and no `record_pcp_intake` at all. The intake never
 * recorded, the purpose was never set, every filing tool refused, and the
 * caller was told her request was with the team. No ticket exists. Which field
 * the model got wrong is not recoverable: the SDK logs it only at debug level.
 *
 * THE FIX checks the arguments against the SAME zod schema before the SDK
 * does, and on a failure answers with an object the runtime reads as a
 * failure: the field names, what each needs, and that nothing was recorded.
 * Arguments that pass are handed to the SDK's own `invoke` untouched, so what
 * a valid call does is exactly what it did. The wire schema is untouched too.
 *
 * Model-facing only: the answer carries `guidance` (PCP's channel for the
 * model) and `fix` (the registry tools' name for the same thing), and NO
 * spoken line — there is nothing for the caller to hear (v43).
 *
 * No value the model sent is repeated back: field NAMES, the type expected,
 * an enum's allowed values and a format. zod's own messages carry the
 * received value for an enum, so they are never used for one.
 */

export const INVALID_ARGUMENTS = 'invalid_arguments' as const;

export interface ToolInputRefusal {
  success: false;
  error: typeof INVALID_ARGUMENTS;
  refused: typeof INVALID_ARGUMENTS;
  /** Field NAMES only. On the timeline allow-list. */
  invalidFields: string[];
  guidance: string;
  fix: string;
}

interface ZodLike {
  safeParse(input: unknown): { success: true; data: unknown } | { success: false; error: { issues: ZodIssueLike[] } };
  shape?: Record<string, unknown>;
  _def?: Record<string, unknown>;
}

interface ZodIssueLike {
  code: string;
  path: (string | number)[];
  message: string;
  keys?: string[];
  options?: unknown[];
  expected?: string;
  received?: string;
  validation?: unknown;
  minimum?: number | bigint;
  maximum?: number | bigint;
  type?: string;
}

/** A field's zod type under its optional/default/effects wrappers. */
function fieldType(schema: ZodLike, field: string): Record<string, unknown> | undefined {
  const shape = typeof (schema as any).shape === 'object' ? (schema as any).shape : (schema as any)._def?.shape?.();
  let node = shape?.[field] as { _def?: Record<string, unknown> } | undefined;
  for (let i = 0; i < 6 && node?._def; i++) {
    const def = node._def;
    const inner = def.innerType ?? def.schema ?? (def.typeName === 'ZodPipeline' ? def.in : undefined);
    if (!inner) return def;
    node = inner as { _def?: Record<string, unknown> };
  }
  return node?._def;
}

/** The one string format the hand-built tools use, said the way a model can follow it. */
const KNOWN_PATTERNS: Record<string, string> = {
  '^\\d{4}-\\d{2}-\\d{2}$': 'YYYY-MM-DD, for example 1958-01-04',
};

function formatFor(schema: ZodLike, field: string): string | undefined {
  const checks = fieldType(schema, field)?.checks;
  if (!Array.isArray(checks)) return undefined;
  const regex = checks.find((c: any) => c?.kind === 'regex')?.regex as RegExp | undefined;
  if (!regex) return undefined;
  return KNOWN_PATTERNS[regex.source] ?? `text matching the pattern ${regex.source}`;
}

function fieldName(issue: ZodIssueLike): string {
  return issue.path.length ? issue.path.map(String).join('.') : '(arguments)';
}

/** One line per problem, with no value the model sent in it. */
function describeIssue(schema: ZodLike, issue: ZodIssueLike): Array<{ field: string; line: string }> {
  const field = fieldName(issue);
  switch (issue.code) {
    case 'unrecognized_keys':
      return (issue.keys ?? []).map((k) => ({
        field: k,
        line: `${k} is not a field of this tool — leave it out.`,
      }));
    case 'invalid_enum_value':
      return [{
        field,
        line: `${field} must be exactly one of: ${(issue.options ?? []).map(String).join(', ')}. If none fits, leave it out.`,
      }];
    case 'invalid_string': {
      const format = formatFor(schema, String(issue.path[0] ?? ''));
      return [{
        field,
        line: format
          ? `${field} must be ${format}. Convert what the caller said into that form, or leave it out.`
          : `${field} is not in the form this tool accepts. Correct it, or leave it out.`,
      }];
    }
    case 'too_small':
      return [{
        field,
        line: issue.type === 'string'
          ? `${field} is too short (at least ${String(issue.minimum)} characters). Send the full value, or leave it out.`
          : `${field} is too small. Correct it, or leave it out.`,
      }];
    case 'too_big':
      return [{ field, line: `${field} is too long. Shorten it, or leave it out.` }];
    case 'invalid_type':
      return [{
        field,
        line: issue.received === 'null' || issue.received === 'undefined'
          ? `${field} must be a ${issue.expected} — leave it out instead of sending an empty value.`
          : `${field} must be a ${issue.expected}. Correct it, or leave it out.`,
      }];
    default:
      return [{ field, line: `${field} was not accepted. Correct it, or leave it out.` }];
  }
}

/**
 * The refusal for these arguments, or null when the schema accepts them (and
 * the SDK should run the tool exactly as it always has).
 *
 * `args` is what the model sent, parsed, so the caller can record it on the
 * timeline (whose own allow-list decides what is kept); `{}` when the input
 * was not JSON at all.
 */
export function inputRefusalFor(
  schema: ZodLike,
  raw: string,
): { args: Record<string, unknown>; refusal: ToolInputRefusal } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      args: {},
      refusal: refusal([{ field: '(arguments)', line: 'The arguments were not valid JSON. Send them again as one JSON object.' }]),
    };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return null;
  const lines = result.error.issues.flatMap((issue) => describeIssue(schema, issue));
  const args = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return { args, refusal: refusal(lines) };
}

function refusal(lines: Array<{ field: string; line: string }>): ToolInputRefusal {
  const invalidFields = [...new Set(lines.map((l) => l.field))];
  const text =
    `NOTHING WAS RECORDED — this call was refused before it ran, because of `
    + `${invalidFields.length === 1 ? 'this field' : 'these fields'}: ${invalidFields.join(', ')}. `
    + lines.map((l) => l.line).join(' ')
    + ' Call the tool again now with only that corrected and everything else the same. Do not tell the caller'
    + ' anything about this, and do not ask them again for something they already gave you.';
  return {
    success: false,
    error: INVALID_ARGUMENTS,
    refused: INVALID_ARGUMENTS,
    invalidFields,
    guidance: text,
    fix: text,
  };
}

/**
 * A BLANK FIELD IS A FIELD THE MODEL DID NOT FILL (v219).
 *
 * The model fills every key it is shown, and for a fact it does not have it
 * often sends `""` (or `null`) instead of leaving the key out. On an
 * `.optional()` field with a minimum length or a format, zod refuses that, and
 * the refusal throws away EVERY fact on the call, the good ones included.
 *
 * MEASURED, PCP runtime, 2026-11-05..12, `duration >= 30`: 92 of 1,093
 * substantive calls took 204 `record_pcp_intake` refusals. Read from the
 * timeline (`recorded` lists the non-blank keys, the refusal names the
 * refused ones): on 2026-11-12, 98 of 99 refusals named only fields the model
 * had sent blank (the guidance reads "too short (at least 1 characters)" and
 * the date-of-birth format, the shapes of `""`), and one named a date of birth
 * in the wrong form. On 28 calls the LAST intake attempt was refused this way
 * and not repeated; 14 of those carried facts beside the blanks, and these
 * never reached the director on any other attempt: whether the caller is the
 * patient (10 calls), the facility type, which routes a professional's records
 * request (9), the patient's last name (3), the caller's name and organisation
 * (2 each), the call's purpose (1).
 *
 * So a key whose value is blank (null, or a string of nothing but spaces) AND
 * which the schema refused is dropped, and the rest is checked again. When
 * that passes, the tool runs on what the model did fill, which is exactly what
 * a call that left the key out would have done; the field reads as not given,
 * and nothing held earlier is overwritten by an empty value (RULE ZERO step
 * 5). When it still fails, the refusal is the one the original arguments got,
 * unchanged. A blank the schema ACCEPTS (a nullable field, a string with no
 * minimum) is not touched, and a REQUIRED field sent blank is still refused.
 * Top-level keys only: every hand-built tool here takes a flat object.
 *
 * Not touched: a placeholder word ("unknown", "N/A"). It is not blank, the
 * measurement found none, and reading one as absent would be a guess.
 */
function isBlank(v: unknown): boolean {
  return v === null || (typeof v === 'string' && v.trim() === '');
}

export function withoutRefusedBlankFields(
  schema: ZodLike,
  raw: string,
): { input: string; dropped: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = schema.safeParse(parsed);
  if (result.success) return null;
  const args = parsed as Record<string, unknown>;
  const refusedKeys = new Set(
    result.error.issues
      .filter((issue) => issue.path.length === 1)
      .map((issue) => String(issue.path[0])),
  );
  const dropped = Object.keys(args).filter((k) => refusedKeys.has(k) && isBlank(args[k])).sort();
  const cleaned = Object.fromEntries(Object.entries(args).filter(([k]) => !dropped.includes(k)));
  if (!schema.safeParse(cleaned).success) return null;
  return { input: JSON.stringify(cleaned), dropped };
}

type Invoke = (ctx: unknown, input: string, details?: unknown) => Promise<unknown>;

/**
 * The SDK tool with its `invoke` checking the arguments first. A refusal is
 * handed to `onRefusal` (the lane records it on the timeline) and returned as
 * the tool's answer; anything the schema accepts goes to the SDK's own
 * `invoke`, unchanged.
 */
export function refuseInvalidInputByName<T extends { invoke?: (...args: any[]) => Promise<any> }>(
  built: T,
  schema: unknown,
  onRefusal?: (args: Record<string, unknown>, refusal: ToolInputRefusal) => unknown,
): T {
  const original = built.invoke as Invoke | undefined;
  const zod = schema as ZodLike | undefined;
  if (typeof original !== 'function' || typeof zod?.safeParse !== 'function') return built;
  const toolName = (built as { name?: unknown }).name;
  const invoke: Invoke = async (ctx, input, details) => {
    const verdict = inputRefusalFor(zod, input);
    if (!verdict) return original.call(built, ctx, input, details);
    const filled = withoutRefusedBlankFields(zod, input);
    if (filled) {
      // Field NAMES only — the count of these lines is the after-number.
      console.info(
        `[TOOL INPUT] ${typeof toolName === 'string' ? toolName : 'tool'}: ran without `
        + `${filled.dropped.length} blank field(s) the schema refused: ${filled.dropped.join(', ')}`,
      );
      return original.call(built, ctx, filled.input, details);
    }
    try {
      await onRefusal?.(verdict.args, verdict.refusal);
    } catch { /* telemetry must never change the answer */ }
    return verdict.refusal;
  };
  return { ...built, invoke };
}
