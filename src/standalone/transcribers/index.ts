/**
 * The bench: which ears are listening, and which one the agent believes.
 *
 *   STT_ENGINES=openai,assemblyai,deepgram   who transcribes (all at once)
 *   STT_PRIMARY=openai                        whose words drive the agent
 *
 * Every engine hears the same audio from the same call, so one phone call
 * produces a direct comparison instead of an argument. Switching which one
 * the agent believes is a secret change, not a deploy — say the word mid-test
 * and the next call runs on it.
 *
 * 'openai' is not in this registry: it transcribes INSIDE the realtime
 * session we already hold, so it needs no socket of its own. It is a valid
 * value for both variables and the demo line handles it directly.
 */
import type { Transcriber } from './types';
import { createAssemblyAiTranscriber } from './assemblyai';
import { createDeepgramTranscriber } from './deepgram';

export type EngineName = 'openai' | 'assemblyai' | 'deepgram';

const BUILDERS: Record<string, () => Transcriber> = {
  assemblyai: createAssemblyAiTranscriber,
  deepgram: createDeepgramTranscriber,
};

/** Engines named by STT_ENGINES. Defaults to openai alone — today's behaviour. */
export function configuredEngines(env: NodeJS.ProcessEnv = process.env): EngineName[] {
  const raw = (env.STT_ENGINES ?? 'openai').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: EngineName[] = [];
  for (const name of raw) {
    if (name === 'openai' || name === 'assemblyai' || name === 'deepgram') {
      if (!out.includes(name)) out.push(name);
    } else {
      console.warn(`[STT] unknown engine "${name}" in STT_ENGINES — ignored`);
    }
  }
  return out.length ? out : ['openai'];
}

/**
 * Whose words the agent acts on. Falls back to the first configured engine
 * when the named primary was not actually turned on — a mismatch there would
 * silently leave the agent deaf, which is worse than any transcription error.
 */
export function primaryEngine(env: NodeJS.ProcessEnv = process.env): EngineName {
  const engines = configuredEngines(env);
  const want = (env.STT_PRIMARY ?? engines[0]).trim().toLowerCase() as EngineName;
  if (engines.includes(want)) return want;
  console.warn(`[STT] STT_PRIMARY="${want}" is not in STT_ENGINES — falling back to "${engines[0]}"`);
  return engines[0];
}

/** Live sockets for the non-OpenAI engines. Never throws. */
export function buildSideTranscribers(env: NodeJS.ProcessEnv = process.env): Transcriber[] {
  const out: Transcriber[] = [];
  for (const name of configuredEngines(env)) {
    const build = BUILDERS[name];
    if (!build) continue; // 'openai' rides the realtime session
    try {
      out.push(build());
    } catch (e) {
      console.error(`[STT] could not build ${name} — continuing without it:`, e);
    }
  }
  return out;
}

export type { Transcriber, TranscriberOptions, TranscriptTurn } from './types';
