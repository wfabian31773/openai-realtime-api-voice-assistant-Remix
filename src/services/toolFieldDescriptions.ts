/**
 * src/services/toolFieldDescriptions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A HAND-BUILT TOOL'S FIELD DESCRIPTIONS, CARRIED TO THE MODEL (v109).
 *
 * `tool()` from `@openai/agents` 0.3.7 turns a zod `parameters` object into
 * JSON Schema in `getSchemaAndParserFromInputType`
 * (`@openai/agents-core/dist/utils/tools.js`). It tries `openai/helpers/zod`'s
 * `zodResponsesFunction` first, and that helper REFUSES any schema with an
 * `.optional()` field, because strict mode allows none. The SDK then falls
 * back to its own `zodJsonSchemaCompat`, which keeps types, enums and the
 * required list and drops every `.describe()`. The FunctionTool it returns
 * keeps no reference to the zod object, so nothing downstream —
 * `agentBinding.toGrokTools` included — can get the words back.
 *
 * MEASURED 2026-10-21 through `resolveLane`, the runtime's own binding: on
 * no-ivr 1 of 31 field descriptions reached the wire, on pcp 1 of 2. So
 * `escalate_to_human.caller_type`'s "ONLY when the caller has said so in their
 * own words" (v99) had never been read by the model it was written for.
 *
 * THE FIX TAKES ONLY THE WORDS. It walks the zod shape beside the schema the
 * SDK already produced and copies each field's own description onto it, where
 * the schema has none. Nothing else moves — no type, enum, `required` entry or
 * `additionalProperties` — and the tool's parser is still the SDK's zod parse,
 * so what a call is refused for is exactly what it was.
 *
 * WHY NOT `zod-to-json-schema`, which `agentBinding` already imports and which
 * does keep descriptions: on the same tools it writes a different schema.
 * `type` on every enum, `minLength`/`maxLength`/`pattern` from the zod
 * checks, `default` — and on pcp's `create_pcp_task` and `handoff_to_pcp` it
 * takes `urgency` and `disposition` OUT of `required`, because they carry
 * `.default()`. That is a second change to what the model reads, riding inside
 * this one and measured by nothing. `toolFieldDescriptionsReachTheWire.test.ts`
 * pins the wire schema, descriptions aside, to the SDK's own.
 */

type JsonSchema = Record<string, unknown>;

interface ZodNode {
  description?: string;
  shape?: Record<string, unknown>;
  _def?: Record<string, unknown> & { typeName?: string };
}

/** Wrappers that add no shape of their own, and where each keeps its inner type. */
const WRAPPER_INNER: Record<string, string> = {
  ZodOptional: 'innerType',
  ZodNullable: 'innerType',
  ZodDefault: 'innerType',
  ZodCatch: 'innerType',
  ZodReadonly: 'innerType',
  ZodBranded: 'type',
  ZodEffects: 'schema',
  ZodPipeline: 'in',
};

/**
 * The type under a field's wrappers, and the field's description. The
 * OUTERMOST description wins: zod copies a description onto each wrapper it
 * builds, so the outermost one is the last `.describe()` the author wrote.
 */
function unwrap(node: unknown): { core: ZodNode | undefined; description: string | undefined } {
  let core = node as ZodNode | undefined;
  let description = core?.description;
  let inner = WRAPPER_INNER[core?._def?.typeName ?? ''];
  while (inner) {
    core = core?._def?.[inner] as ZodNode | undefined;
    description ??= core?.description;
    inner = WRAPPER_INNER[core?._def?.typeName ?? ''];
  }
  return { core, description };
}

/** The member of a schema that holds its structure: itself, or the non-null
 *  branch of the SDK's nullable form `anyOf: [inner, { type: 'null' }]`. */
function structural(schema: JsonSchema): JsonSchema {
  if (schema.properties || schema.items) return schema;
  const branches = Array.isArray(schema.anyOf) ? (schema.anyOf as JsonSchema[]) : [];
  return branches.find((b) => b && typeof b === 'object' && (b.properties || b.items)) ?? schema;
}

const isSchema = (v: unknown): v is JsonSchema => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function describeChildren(schema: JsonSchema, core: ZodNode | undefined): void {
  const target = structural(schema);
  const kind = core?._def?.typeName;
  if (kind === 'ZodObject') {
    const properties = isSchema(target.properties) ? target.properties : {};
    for (const [key, field] of Object.entries(core?.shape ?? {})) {
      if (isSchema(properties[key])) describeField(properties[key], field);
    }
  } else if (kind === 'ZodArray' && isSchema(target.items)) {
    describeField(target.items, core?._def?.type);
  }
}

function describeField(schema: JsonSchema, zod: unknown): void {
  const { core, description } = unwrap(zod);
  if (description && schema.description === undefined) schema.description = description;
  describeChildren(schema, core);
}

/**
 * `parameters` with every field description `zod` carries, on a copy. A
 * description the schema already has is kept as it is, and a `zod` that is
 * not a zod object (a tool declared with plain JSON Schema) returns
 * `parameters` unchanged.
 *
 * THE COPY MUST BREAK SHARING, which is why it is a JSON round trip and not
 * `structuredClone`. The SDK's converter returns ONE module-level object for
 * every leaf of a type (`SIMPLE_TYPE_MAPPING.boolean` is the `{ type:
 * 'boolean' }` of every boolean field of every tool). `structuredClone` keeps
 * that aliasing inside its copy, and the first version of this wrote
 * `appointment_today`'s description onto `post_op_prescription` and
 * `requires_callback` as well; writing into the SDK's object instead would
 * have put it on every boolean in the fleet.
 */
export function withFieldDescriptions(parameters: unknown, zod: unknown): unknown {
  const { core } = unwrap(zod);
  if (core?._def?.typeName !== 'ZodObject' || !isSchema(parameters)) return parameters;
  const copy = JSON.parse(JSON.stringify(parameters)) as JsonSchema;
  describeChildren(copy, core);
  return copy;
}

/** `tool()`'s result, its `parameters` carrying the descriptions its zod did. */
export function keepFieldDescriptions<T extends { parameters?: unknown }>(built: T, zod: unknown): T {
  return { ...built, parameters: withFieldDescriptions(built.parameters, zod) };
}
