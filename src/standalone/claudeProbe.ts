/**
 * LATENCY PROBE — the real number, before we build on top of it.
 *
 * Operator, 2026-08-10: "prove those two first."
 *
 * The plan is Deepgram ears -> Claude with the answering service's own prompt
 * and tools -> the voice we already have. The whole thing lives or dies on how
 * long Claude takes to answer, because that is the box that dominates a turn.
 * Vapi measured 1,097ms for a 629-token prompt. THIS prompt is about 4,900
 * tokens plus 530 of tool descriptions — roughly eight times the input — and
 * guessing what that costs is exactly the habit that wasted today.
 *
 * So this measures it, with the REAL prompt and the REAL tool schemas, against
 * a realistic caller turn. It runs on the deployment because that is where the
 * keys are; a browser hit is the whole interface.
 *
 * It also measures it twice: cold, and with the prompt cached. Caching a
 * 5,400-token preamble is the difference between a line that feels alive and
 * one that does not, and it is the first thing to reach for if the cold number
 * is bad.
 */
import type { Express, Request, Response } from 'express';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

/** The four tools the answering service actually has, as Claude sees them. */
const TOOLS = [
  {
    name: 'lookup_schedule',
    description:
      'Look up patient appointment context using phone, name, or date of birth. Returns full patient schedule data including upcoming and past appointments, provider and office.',
    input_schema: {
      type: 'object' as const,
      properties: {
        phone: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        date_of_birth: { type: 'string' },
      },
    },
  },
  {
    name: 'check_open_tickets',
    description: 'Check whether this caller already has an open ticket, so we do not file a duplicate.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'classify_request',
    description:
      'Classify the caller request into a department, request type, reason and priority before filing.',
    input_schema: {
      type: 'object' as const,
      properties: { request_description: { type: 'string' } },
      required: ['request_description'],
    },
  },
  {
    name: 'create_ticket',
    description:
      'File the ticket for the team to action. Requires the patient name, date of birth and a callback number.',
    input_schema: {
      type: 'object' as const,
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        date_of_birth: { type: 'string' },
        callback_number: { type: 'string' },
        request_description: { type: 'string' },
        priority: { type: 'string' },
      },
      required: ['first_name', 'last_name', 'callback_number'],
    },
  },
];

/** A realistic opening turn — the one that failed all evening. */
const TURNS = [
  { role: 'user' as const, content: "Yeah. I'm calling to find out when my last appointment was." },
];

interface Timing {
  label: string;
  ms: number;
  stopReason?: string;
  toolCalled?: string | null;
  inputTokens?: number;
  cachedRead?: number;
  cachedWrite?: number;
  outputTokens?: number;
  error?: string;
}

async function timeOne(
  apiKey: string,
  system: string,
  label: string,
  cache: boolean,
): Promise<Timing> {
  const started = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        // The system prompt as a cacheable block. Without the marker the whole
        // preamble is re-read on every single turn of every single call.
        system: cache
          ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
          : system,
        tools: TOOLS,
        messages: TURNS,
      }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      return { label, ms, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
    }
    const body = (await res.json()) as {
      stop_reason?: string;
      content?: Array<{ type: string; name?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    return {
      label,
      ms,
      stopReason: body.stop_reason,
      toolCalled: body.content?.find((c) => c.type === 'tool_use')?.name ?? null,
      inputTokens: body.usage?.input_tokens,
      cachedRead: body.usage?.cache_read_input_tokens,
      cachedWrite: body.usage?.cache_creation_input_tokens,
      outputTokens: body.usage?.output_tokens,
    };
  } catch (e) {
    return { label, ms: Date.now() - started, error: (e as Error).message };
  }
}

export function mountClaudeProbe(app: Express): void {
  app.get('/demo/claude-probe', async (_req: Request, res: Response) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.json({
        ok: false,
        model: MODEL,
        problem: 'ANTHROPIC_API_KEY is not set in this process — set it, republish, and hit this again.',
      });
      return;
    }

    // The REAL prompt, not a stand-in. If this import fails we want to know
    // that too, because it is the thing the whole plan moves.
    let system: string;
    try {
      const { buildSystemPrompt } = await import('../agents/answeringServiceAgent');
      // A caller phone, no schedule context, no memory: the leanest real call.
      // A recognised caller's prompt is LONGER than this, so this is the floor.
      system = buildSystemPrompt({ callerPhone: '8455317471' });
      if (!system) throw new Error('prompt came back empty — probing a placeholder would prove nothing');
    } catch (e) {
      res.json({
        ok: false,
        model: MODEL,
        problem: `could not load the real answering-service prompt: ${(e as Error).message}`,
      });
      return;
    }

    const runs: Timing[] = [];
    runs.push(await timeOne(apiKey, system, 'cold (no cache)', false));
    runs.push(await timeOne(apiKey, system, 'cache write', true));
    runs.push(await timeOne(apiKey, system, 'cache read #1', true));
    runs.push(await timeOne(apiKey, system, 'cache read #2', true));

    const cached = runs.filter((r) => r.label.startsWith('cache read') && !r.error).map((r) => r.ms);
    res.json({
      ok: runs.every((r) => !r.error),
      model: MODEL,
      promptChars: system.length,
      approxPromptTokens: Math.round(system.length / 4),
      runs,
      verdict: {
        coldMs: runs[0]?.ms ?? null,
        warmMs: cached.length ? Math.round(cached.reduce((a, b) => a + b, 0) / cached.length) : null,
        note:
          'This is the LLM box only. A full turn adds Deepgram endpointing (~300ms), ' +
          'the transcriber (~300-450ms) and the voice starting to speak (~500-900ms). ' +
          'Vapi measured 2,753ms end to end on a 629-token prompt.',
      },
    });
  });
}
