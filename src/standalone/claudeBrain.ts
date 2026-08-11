/**
 * THE BRAIN — the real answering-service agent, on a pipeline we own.
 *
 * Operator, 2026-08-10: "I want you to replace the answering service voice
 * pipeline with our new STT model, that's all i've been asking you all day,
 * same exact agent, different voice pipeline. Nothing in the agent changes but
 * the voice pipeline." And then: "on the side without touching the real
 * agents."
 *
 * So this file touches nothing. It CALLS createAnsweringServiceAgent — the
 * same function the production line calls — and then borrows two things off
 * the object it returns:
 *
 *   agent.instructions  the real system prompt, already built with this
 *                       caller's pre-context, schedule and memory
 *   agent.tools         the real tools, with the real execute functions that
 *                       file real tickets
 *
 * Nothing is reimplemented and nothing is copied. If the prompt changes
 * tomorrow, this changes with it, because it is the same object.
 *
 * The pipeline around it is the part that is different:
 *
 *   Deepgram (ears) -> Claude Haiku + these tools (brain) -> OpenAI (voice)
 *
 * instead of one OpenAI realtime session being all three at once over SIP.
 *
 * WHY HAIKU, measured rather than assumed (2026-08-10, /demo/claude-probe):
 * Sonnet 5 takes 1,730ms to its first token with this prompt, which puts a
 * caller at 2.5-2.9s of silence once endpointing, transcription and speech are
 * added — past the point a call feels broken. Haiku is 791ms, landing near
 * 1.7s. On /demo/tool-check both models called lookup_schedule with
 * first_name "Wayne", last_name "Fabian" from "Yeah. It's Wayne Fabian." —
 * the sentence a regex turned into a first name of "It's" and a surname of
 * "Wayne", which then searched the patient mirror for a patient called Wayne
 * and found nobody, all evening.
 */
import { RunContext } from '@openai/agents-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AnsweringServiceMetadata } from '../agents/answeringServiceAgent';

const MODEL = process.env.CLAUDE_BRAIN_MODEL ?? 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * A caller is on the line. Past this we stop waiting and say something.
 *
 * This is the budget for the WHOLE turn, tool rounds included — it used to be
 * per round, which meant four rounds could hold a caller for 32 seconds and
 * once did. 8s was the right number for one round and is too tight for a turn:
 * a real lookup-then-answer turn measured 8.8s. 15s is the ceiling on how long
 * a caller waits before we give them words instead of silence.
 */
const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_BRAIN_TIMEOUT_MS ?? 15_000);
/** Tool -> model -> tool. Enough for a lookup then a file; not an infinite loop. */
const MAX_TOOL_ROUNDS = 4;

type Content =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface Message {
  role: 'user' | 'assistant';
  content: string | Content[];
}

export interface BrainTurn {
  /** Everything the caller should hear, in order. Already split for speaking. */
  sentences: string[];
  toolsUsed: string[];
  ms: number;
  /** First token, for the latency record on every single call. */
  ttftMs: number | null;
  error?: string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A live tool as the SDK holds it — name, schema, and the real implementation. */
interface LiveTool {
  name?: string;
  description?: string;
  parameters?: unknown;
  invoke?: (ctx: RunContext<unknown>, input: string) => Promise<unknown>;
}

/**
 * Speak in sentences, not paragraphs.
 *
 * The whole point of a 791ms first token is starting to talk before the answer
 * is finished. Splitting on sentence ends lets the first clause reach the
 * caller while the rest is still being written; waiting for the full response
 * throws that away and puts us back at three seconds.
 */
const NOT_A_SENTENCE_END =
  /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Ave|Blvd|Rd|Ste|Inc|Ltd|Co|Corp|Dept|Approx|vs|etc|a\.m|p\.m|[A-Z])\.$/;

export function splitForSpeech(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    // A title or an initial ends in a period but does not end a sentence.
    // Without this, "with Dr. Dwayne Logan" reaches the caller as two separate
    // utterances — the doctor's title, then their name. That is what happened
    // on the first live call.
    const prev = out[out.length - 1];
    if (prev !== undefined && NOT_A_SENTENCE_END.test(prev)) {
      out[out.length - 1] = `${prev} ${trimmed}`;
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

/**
 * Every tool_use MUST be answered by a tool_result in the very next message.
 * If it is not, the API rejects the WHOLE history — not just the offending
 * turn — so one malformed turn kills every later turn of the same call:
 *
 *   400 messages.20: `tool_use` ids were found without `tool_result` blocks
 *
 * On a live call that is the caller holding a silent phone for 31 seconds.
 * The loop is built so this cannot happen; this is the last line of defence
 * if it ever does. It repairs the history rather than letting it 400, and it
 * names what was wrong so the path that produced it is identified from the
 * log instead of guessed at.
 */
export function repairHistory(msgs: Message[]): number {
  let repaired = 0;
  for (let i = 0; i < msgs.length; i++) {
    const content = msgs[i].content;
    if (!Array.isArray(content)) continue;
    const uses = content.filter(
      (c) => typeof c === 'object' && c !== null && c.type === 'tool_use',
    ) as Array<Content & { id?: string; name?: string }>;
    if (!uses.length) continue;

    const next = msgs[i + 1]?.content;
    const answered = new Set(
      (Array.isArray(next) ? next : [])
        .filter((c) => typeof c === 'object' && c !== null && c.type === 'tool_result')
        .map((c) => (c as { tool_use_id?: string }).tool_use_id),
    );
    const orphans = uses.filter((u) => !answered.has(u.id));
    if (!orphans.length) continue;

    console.error(
      `[BRAIN] history malformed at messages.${i}: ${orphans.length} tool_use block(s) with ` +
        `no tool_result (${orphans.map((o) => o.name ?? '?').join(', ')}) — repairing`,
    );
    const repair = orphans.map((o) => ({
      type: 'tool_result' as const,
      tool_use_id: o.id as string,
      content: JSON.stringify({ success: false, error: 'tool did not run' }),
    })) as unknown as Content[];
    // The results have to land in the message IMMEDIATELY after the tool_use,
    // so they are folded into whatever is already there rather than inserted
    // as a message of their own — an extra user message would leave two of
    // them back to back.
    if (Array.isArray(next)) {
      (msgs[i + 1].content as Content[]).unshift(...repair);
    } else if (msgs[i + 1] !== undefined) {
      msgs[i + 1] = {
        role: 'user',
        content: [...repair, { type: 'text', text: String(next) } as unknown as Content],
      };
    } else {
      msgs.push({ role: 'user', content: repair });
    }
    repaired += orphans.length;
  }
  return repaired;
}

function toAnthropicTools(tools: LiveTool[]): AnthropicTool[] {
  const out: AnthropicTool[] = [];
  for (const t of tools) {
    if (!t.name || typeof t.invoke !== 'function') continue;
    let schema: Record<string, unknown> = { type: 'object', properties: {} };
    try {
      const p = t.parameters as { _def?: unknown } | undefined;
      if (p && typeof p === 'object' && '_def' in p) {
        // A zod schema. The SDK accepts either; convert only what needs it.
        const json = zodToJsonSchema(p as never, { target: 'openApi3' }) as Record<string, unknown>;
        delete json.$schema;
        schema = json;
      } else if (p && typeof p === 'object') {
        schema = p as Record<string, unknown>;
      }
    } catch {
      /* an unconvertible schema still gets the tool, just untyped */
    }
    out.push({ name: t.name, description: t.description ?? '', input_schema: schema });
  }
  return out;
}

export interface Brain {
  /** The agent's own greeting — its words, not ours. */
  greeting: string;
  /** The agent asked for a human at some point in this call. */
  readonly handoffRequested: boolean;
  /** One caller turn in, everything to say out. Never throws. */
  respond(said: string, onSentence?: (s: string) => void): Promise<BrainTurn>;
  release(): void;
}

/**
 * Build a brain for one call, wrapped around the real agent.
 *
 * Returns null when it cannot — no key, agent creation failed — so the caller
 * can fall back rather than answer a patient with an exception.
 */
export async function createClaudeBrain(
  metadata: AnsweringServiceMetadata,
): Promise<Brain | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[BRAIN] ANTHROPIC_API_KEY is not set — this line cannot think');
    return null;
  }

  let system: string;
  let tools: AnthropicTool[];
  let live: LiveTool[];
  /** Set if the agent ever asked to hand off. Surfaced on the call record. */
  let handoffRequested = false;
  try {
    const { createAnsweringServiceAgent, answeringServiceAgentConfig } = await import(
      '../agents/answeringServiceAgent'
    );
    // THE REAL AGENT. Creating it also runs the caller-ID pre-context, the
    // schedule lookup and the caller-memory read, exactly as production does —
    // which is why a recognised caller is recognised here too.
    // handoffToHuman: this transport has no conference to hand a caller into,
    // so it reports the request rather than dialling. That is the same choice
    // the scheduling line makes on this transport, and it is not a downgrade —
    // the agent's own instructions already tell it to take a message instead.
    const agent = await createAnsweringServiceAgent(async () => {
      handoffRequested = true;
      console.warn(`[BRAIN] ${metadata.callId ?? ''} handoff requested — no queue on this transport, taking a message`);
    }, metadata);
    const instructions = (agent as { instructions?: unknown }).instructions;
    system = typeof instructions === 'string' ? instructions : String(instructions ?? '');
    live = ((agent as { tools?: LiveTool[] }).tools ?? []) as LiveTool[];
    tools = toAnthropicTools(live);
    if (!system) throw new Error('the agent produced no instructions');
    console.info(
      `[BRAIN] ${metadata.callId ?? ''} built on the REAL answering-service agent ` +
        `v${answeringServiceAgentConfig.version}: ${tools.length} tools, ${Math.round(system.length / 4)} prompt tokens`,
    );
  } catch (e) {
    console.error('[BRAIN] could not build on the real agent:', e);
    return null;
  }

  const messages: Message[] = [];
  const runContext = new RunContext({});

  async function runTool(name: string, input: unknown): Promise<string> {
    const t = live.find((x) => x.name === name);
    if (!t?.invoke) return JSON.stringify({ error: `no such tool: ${name}` });
    try {
      const result = await t.invoke(runContext, JSON.stringify(input ?? {}));
      return typeof result === 'string' ? result : JSON.stringify(result ?? null);
    } catch (e) {
      // A failed tool is information for the model, not a dead call.
      console.warn(`[BRAIN] tool ${name} threw:`, e);
      return JSON.stringify({ success: false, error: (e as Error).message });
    }
  }

  /** One streamed request. Returns the text, any tool calls, and the timings. */
  async function once(
    onSentence: ((s: string) => void) | undefined,
    speak: boolean,
    /** Last round: answer in words. Another tool call would just burn the turn. */
    noMoreTools = false,
  ): Promise<{ text: string; toolUses: Array<{ id: string; name: string; input: unknown }>; ttftMs: number | null }> {
    const started = Date.now();
    let ttftMs: number | null = null;
    let text = '';
    let spokenUpTo = 0;
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    const partials = new Map<number, { id: string; name: string; json: string }>();

    repairHistory(messages);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey!,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        stream: true,
        // Cached: the prompt is ~10,500 tokens and re-reading it on every turn
        // of every call is pure waste. Measured at 99% of input tokens saved.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        ...(noMoreTools ? { tool_choice: { type: 'none' } } : {}),
        messages,
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
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
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ttftMs === null && (evt.type === 'content_block_start' || evt.type === 'content_block_delta')) {
          ttftMs = Date.now() - started;
        }
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          partials.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, json: '' });
        }
        if (evt.type === 'content_block_delta') {
          if (evt.delta?.type === 'text_delta') {
            text += evt.delta.text ?? '';
            // Speak each finished sentence the moment it is finished.
            if (speak && onSentence) {
              const ready = splitForSpeech(text);
              // The last one may still be growing, so hold it back.
              for (let i = spokenUpTo; i < ready.length - 1; i++) onSentence(ready[i]);
              spokenUpTo = Math.max(spokenUpTo, ready.length - 1);
            }
          }
          if (evt.delta?.type === 'input_json_delta') {
            const p = partials.get(evt.index);
            if (p) p.json += evt.delta.partial_json ?? '';
          }
        }
      }
    }

    // Whatever is left after the last sentence boundary.
    if (speak && onSentence) {
      const ready = splitForSpeech(text);
      for (let i = spokenUpTo; i < ready.length; i++) onSentence(ready[i]);
    }

    for (const p of partials.values()) {
      let input: unknown = {};
      try {
        input = p.json ? JSON.parse(p.json) : {};
      } catch {
        /* a malformed argument blob is an empty one; the tool will complain */
      }
      toolUses.push({ id: p.id, name: p.name, input });
    }
    return { text, toolUses, ttftMs };
  }

  async function respond(said: string, onSentence?: (s: string) => void): Promise<BrainTurn> {
    const started = Date.now();
    const toolsUsed: string[] = [];
    const sentences: string[] = [];
    const collect = (s: string) => {
      sentences.push(s);
      onSentence?.(s);
    };

    // Where this turn began. A turn that fails rewinds to here, so a caller
    // who says something that trips us up loses that ONE reply — not the rest
    // of the call. A live call spent 31 seconds in silence because a malformed
    // history stayed in the conversation and every later turn 400'd on it.
    const rewindTo = messages.length;

    messages.push({ role: 'user', content: said });
    let ttftMs: number | null = null;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // The budget is the whole turn, not each round of it. Four rounds at
        // eight seconds apiece is a caller holding a silent phone for half a
        // minute, which is what happened.
        const left = TURN_TIMEOUT_MS - (Date.now() - started);
        if (left <= 0) throw new Error('turn timeout');
        const lastRound = round === MAX_TOOL_ROUNDS - 1;

        // Only the LAST round speaks. A tool round's text is usually "let me
        // check" filler, and saying it before the answer doubles the wait.
        const turn = await Promise.race([
          once(collect, true, lastRound),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('turn timeout')), left)),
        ]);
        if (ttftMs === null) ttftMs = turn.ttftMs;

        if (!turn.toolUses.length) {
          messages.push({ role: 'assistant', content: turn.text || '(no reply)' });
          return { sentences, toolsUsed, ms: Date.now() - started, ttftMs };
        }

        const assistantContent: Content[] = [];
        if (turn.text) assistantContent.push({ type: 'text', text: turn.text });
        for (const u of turn.toolUses) {
          assistantContent.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input });
        }

        // Run the tools FIRST, then push the pair together. A tool_use that
        // reaches the history without its tool_result poisons every later turn
        // of the call, so the two must never be separable — not by a throw,
        // not by a timeout, not by a future edit to this loop.
        const results: Content[] = [];
        for (const u of turn.toolUses) {
          toolsUsed.push(u.name);
          console.info(`[BRAIN] tool ${u.name} ${JSON.stringify(u.input).slice(0, 120)}`);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(u.name, u.input) });
        }
        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({ role: 'user', content: results });
      }
      // Unreachable: the last round is asked for words, so it cannot come back
      // holding tools. Kept as a real failure rather than a silent one.
      console.warn('[BRAIN] hit the tool-round limit');
      messages.length = rewindTo;
      return { sentences, toolsUsed, ms: Date.now() - started, ttftMs, error: 'tool loop did not settle' };
    } catch (e) {
      console.error('[BRAIN] turn failed:', e);
      // Rewind. Whatever this turn added is not trustworthy, and leaving it in
      // place is what turns one bad turn into a dead call.
      messages.length = rewindTo;
      return {
        sentences,
        toolsUsed,
        ms: Date.now() - started,
        ttftMs,
        error: (e as Error).message,
      };
    }
  }

  const { answeringServiceAgentConfig } = await import('../agents/answeringServiceAgent');
  return {
    greeting: answeringServiceAgentConfig.greeting,
    respond,
    get handoffRequested() {
      return handoffRequested;
    },
    release() {
      messages.length = 0;
    },
  };
}
