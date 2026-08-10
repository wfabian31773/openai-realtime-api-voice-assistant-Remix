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
  model?: string;
  /**
   * TIME TO FIRST TOKEN — the number that decides whether a call feels alive.
   * A voice pipeline streams and starts speaking at the first clause; it never
   * waits for the whole answer. The first probe measured total completion,
   * which is the wrong metric and made this look worse than it is.
   */
  ttftMs?: number;
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
  model: string,
): Promise<Timing> {
  const started = Date.now();
  let ttftMs: number | undefined;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        stream: true,
        system: cache
          ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
          : system,
        tools: TOOLS,
        messages: TURNS,
      }),
    });
    if (!res.ok || !res.body) {
      return { label, model, ms: Date.now() - started, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
    }

    // Read the SSE stream and stop the clock the moment the FIRST piece of
    // content arrives — text or the start of a tool call. That is the instant
    // a real pipeline could begin speaking.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let usage: Record<string, number> = {};
    let stopReason: string | undefined;
    let toolCalled: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let evt: Record<string, any>;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ttftMs === undefined && (evt.type === 'content_block_delta' || evt.type === 'content_block_start')) {
          ttftMs = Date.now() - started;
        }
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          toolCalled = evt.content_block.name ?? null;
        }
        if (evt.type === 'message_start' && evt.message?.usage) usage = { ...usage, ...evt.message.usage };
        if (evt.type === 'message_delta') {
          if (evt.usage) usage = { ...usage, ...evt.usage };
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        }
      }
    }
    return {
      label,
      model,
      ttftMs,
      ms: Date.now() - started,
      stopReason,
      toolCalled,
      inputTokens: usage.input_tokens,
      cachedRead: usage.cache_read_input_tokens,
      cachedWrite: usage.cache_creation_input_tokens,
      outputTokens: usage.output_tokens,
    };
  } catch (e) {
    return { label, model, ms: Date.now() - started, ttftMs, error: (e as Error).message };
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

    // Sonnet and Haiku side by side. Haiku is the obvious lever if Sonnet's
    // first token is too slow, and asking for both in one hit costs one page
    // refresh instead of two.
    const FAST = process.env.CLAUDE_FAST_MODEL ?? 'claude-haiku-4-5-20251001';
    const runs: Timing[] = [];
    runs.push(await timeOne(apiKey, system, 'sonnet cache write', true, MODEL));
    runs.push(await timeOne(apiKey, system, 'sonnet cached #1', true, MODEL));
    runs.push(await timeOne(apiKey, system, 'sonnet cached #2', true, MODEL));
    runs.push(await timeOne(apiKey, system, 'haiku cache write', true, FAST));
    runs.push(await timeOne(apiKey, system, 'haiku cached #1', true, FAST));
    runs.push(await timeOne(apiKey, system, 'haiku cached #2', true, FAST));

    const ttfts = (m: string) =>
      runs.filter((r) => r.label.startsWith(m) && r.label.includes('cached') && r.ttftMs).map((r) => r.ttftMs!);
    const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    res.json({
      ok: runs.every((r) => !r.error),
      model: MODEL,
      promptChars: system.length,
      approxPromptTokens: Math.round(system.length / 4),
      runs,
      verdict: {
        sonnetFirstTokenMs: avg(ttfts('sonnet')),
        haikuFirstTokenMs: avg(ttfts('haiku')),
        note:
          'FIRST TOKEN is the number that matters — a voice pipeline starts speaking at the ' +
          'first clause and never waits for the whole answer. Add Deepgram endpointing (~300ms), ' +
          'the transcriber (~300-450ms), and the voice beginning (~200-400ms once streaming) ' +
          'to estimate what the caller actually experiences. Under about 1,500ms total feels ' +
          'normal; over about 2,500ms feels broken.',
      },
    });
  });
}

/* ── TOOL CHOICE — does it actually DO the thing? ───────────────────────── */

/**
 * Speed decided Sonnet is out. This decides whether Haiku is in.
 *
 * The first probe showed Haiku answering "when was my last appointment" with
 * 33 tokens of conversation and calling no tool at all, three times out of
 * three, while Sonnet reached for lookup_schedule. Faster and wrong is not an
 * improvement — talking without doing the lookup is the exact failure we spent
 * today on.
 *
 * So this replays REAL caller turns from tonight's calls, as short
 * conversations rather than isolated sentences, because tool choice depends on
 * what has already been said: "03/17/1973" means nothing on its own and means
 * "verify me" after a name.
 *
 * It reports the tool AND its arguments, because the arguments are the whole
 * point of moving to tool calling. "Yeah. It's Wayne Fabian." has to arrive as
 * first_name "Wayne", last_name "Fabian" — not the "It's Wayne" that a regex
 * produced and that searched the patient mirror for a surname of Wayne.
 */
interface Scenario {
  name: string;
  /** Real words, from call_logs. The last entry is the turn under test. */
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Only set where the prompt makes it unambiguous. Otherwise judged by eye. */
  mustCallTool?: string;
  note?: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'opening: asks about last appointment',
    turns: [{ role: 'user', content: "Yeah. I'm calling to find out when my last appointment was." }],
    note: 'Either look it up or ask who is calling — both are defensible.',
  },
  {
    name: 'gives their name, in the way people actually do',
    turns: [
      { role: 'user', content: "Yeah. I'm calling to find out when my last appointment was." },
      { role: 'assistant', content: "I can help with that. May I have the patient's first and last name?" },
      { role: 'user', content: "Yeah. It's Wayne Fabian." },
    ],
    note: 'THE test. Any tool call must carry first_name Wayne, last_name Fabian — never "It\'s".',
  },
  {
    name: 'gives date of birth after the name',
    turns: [
      { role: 'user', content: "Yeah. I'm calling to find out when my last appointment was." },
      { role: 'assistant', content: "May I have the patient's first and last name?" },
      { role: 'user', content: "Yeah. It's Wayne Fabian." },
      { role: 'assistant', content: "And the patient's date of birth?" },
      { role: 'user', content: '03/17/1973.' },
    ],
    mustCallTool: 'lookup_schedule',
    note: 'It now has everything. Not looking it up here is the failure we are testing for.',
  },
  {
    name: 'name and date of birth in one breath',
    turns: [
      { role: 'user', content: "I'd like to put in for a medication refill, please." },
      { role: 'assistant', content: "May I have the patient's first and last name?" },
      { role: 'user', content: "Yes. Patient's name is Wayne Fabian. Date of birth is 03/17/1973." },
    ],
    note: 'Both facts in one sentence — the case the parser split in half.',
  },
  {
    name: 'the name arrives mid-ramble',
    turns: [
      { role: 'user', content: 'I need a refill' },
      { role: 'assistant', content: "May I have the patient's first and last name?" },
      { role: 'user', content: 'Well I was thinking, and you know what happened, and then — oh, my… yeah. My name is Wayne Fabian.' },
    ],
    note: "The operator's own example of what a regex can never do.",
  },
  {
    name: 'asks for a human',
    turns: [{ role: 'user', content: 'I want to talk to a real person.' }],
    note: 'Should explain the boundary, not reach for a tool.',
  },
];

async function runScenario(
  apiKey: string,
  system: string,
  model: string,
  sc: Scenario,
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: sc.turns,
      }),
    });
    if (!res.ok) return { model, error: `${res.status} ${(await res.text()).slice(0, 160)}` };
    const body = (await res.json()) as {
      content?: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
    };
    const call = body.content?.find((c) => c.type === 'tool_use');
    const said = body.content?.find((c) => c.type === 'text')?.text ?? '';
    const pass = sc.mustCallTool ? call?.name === sc.mustCallTool : undefined;
    return {
      model,
      toolCalled: call?.name ?? null,
      toolArgs: call?.input ?? null,
      said: said.slice(0, 220),
      ...(sc.mustCallTool ? { required: sc.mustCallTool, pass } : {}),
    };
  } catch (e) {
    return { model, error: (e as Error).message };
  }
}

export function mountToolCheck(app: Express): void {
  app.get('/demo/tool-check', async (_req: Request, res: Response) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.json({ ok: false, problem: 'ANTHROPIC_API_KEY is not set in this process.' });
      return;
    }
    let system: string;
    try {
      const { buildSystemPrompt } = await import('../agents/answeringServiceAgent');
      system = buildSystemPrompt({ callerPhone: '8455317471' });
    } catch (e) {
      res.json({ ok: false, problem: `could not load the real prompt: ${(e as Error).message}` });
      return;
    }

    const SONNET = process.env.CLAUDE_MODEL ?? 'claude-sonnet-5';
    const HAIKU = process.env.CLAUDE_FAST_MODEL ?? 'claude-haiku-4-5-20251001';

    const results = [];
    for (const sc of SCENARIOS) {
      const [sonnet, haiku] = await Promise.all([
        runScenario(apiKey, system, SONNET, sc),
        runScenario(apiKey, system, HAIKU, sc),
      ]);
      results.push({ scenario: sc.name, note: sc.note, sonnet, haiku });
    }

    // The only mechanical verdict available: did the required tool get called.
    const required = results.filter((r) => 'required' in (r.haiku as object));
    const score = (side: 'sonnet' | 'haiku') =>
      `${required.filter((r) => (r[side] as Record<string, unknown>).pass).length}/${required.length}`;

    res.json({
      ok: true,
      models: { sonnet: SONNET, haiku: HAIKU },
      requiredToolCalls: { sonnet: score('sonnet'), haiku: score('haiku') },
      results,
      readMe:
        'Look at toolArgs on the name scenarios. first_name must be "Wayne" and last_name "Fabian". ' +
        'If either model returns "It\'s" as a first name, tool calling has the same disease the parser had. ' +
        'Everything else is a judgement call and is printed rather than graded.',
    });
  });
}
