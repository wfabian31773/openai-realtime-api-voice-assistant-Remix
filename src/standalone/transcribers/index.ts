/**
 * The bench: which ears are listening, and which one the agent believes.
 *
 *   STT_ENGINES=deepgram,assemblyai   who transcribes (all at once)
 *   STT_PRIMARY=deepgram              whose words drive the agent
 *
 * Every engine hears the same audio from the same call, so one phone call
 * produces a direct comparison instead of an argument. Switching which one
 * the agent believes is a secret change, not a deploy — say the word mid-test
 * and the next call runs on it.
 */
import type { Transcriber } from './types';
import { createAssemblyAiTranscriber } from './assemblyai';
import { createDeepgramTranscriber } from './deepgram';

export type EngineName = 'assemblyai' | 'deepgram';

const BUILDERS: Record<string, () => Transcriber> = {
  assemblyai: createAssemblyAiTranscriber,
  deepgram: createDeepgramTranscriber,
};

/**
 * OpenAI is not a transcriber here any more, and naming it does nothing.
 *
 * Its speech-to-text fabricates narrative fiction out of silence — not
 * garbled words, whole passages. Live production calls have it recorded as
 * the caller: "I sensed you were my fated master, so I traveled all this
 * way… what is this ice apocalypse you talked about?" (2026-07-29), and "the
 * room was filled with his old trophies. Russell's heart was filled with
 * regret" (2026-07-24). On the old core the transcriber and the agent are
 * one session, so the agent answers the fiction: on 2026-04-22 it told a
 * patient "I just got promoted at work today", and on 2026-05-05 a patient
 * rang back to ask what that had been. It repeats verbatim across calls
 * because it is the model's likeliest output given no real input.
 *
 * Keeping it as a fallback was not safe either. demoLine's failover acts on
 * a secondary engine when the primary is silent for PRIMARY_GRACE_MS, and a
 * long silence is precisely when Deepgram correctly reports nothing and this
 * one writes a novel. So the name is refused outright rather than quietly
 * demoted, and STT_ENGINES=openai deliberately yields an empty list — a line
 * that shouts about having no ears beats a line that invents a caller.
 */
export function configuredEngines(env: NodeJS.ProcessEnv = process.env): EngineName[] {
  const raw = (env.STT_ENGINES ?? 'deepgram').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: EngineName[] = [];
  for (const name of raw) {
    if (name === 'assemblyai' || name === 'deepgram') {
      if (!out.includes(name)) out.push(name);
    } else if (name === 'openai') {
      console.error(
        '[STT] REFUSING openai as a transcriber: it fabricates speech out of silence, and ' +
          'patients have heard the agent answer it. Remove it from STT_ENGINES.',
      );
    } else {
      console.warn(`[STT] unknown engine "${name}" in STT_ENGINES — ignored`);
    }
  }
  return out;
}

/**
 * Whose words the agent acts on. Falls back to the first configured engine
 * when the named primary was not actually turned on — a mismatch there would
 * silently leave the agent deaf, which is worse than any transcription error.
 */
export function primaryEngine(env: NodeJS.ProcessEnv = process.env): EngineName | null {
  const engines = configuredEngines(env);
  if (!engines.length) return null; // nothing is listening; the caller must be told
  const want = (env.STT_PRIMARY ?? engines[0]).trim().toLowerCase() as EngineName;
  if (engines.includes(want)) return want;
  console.warn(`[STT] STT_PRIMARY="${want}" is not in STT_ENGINES — falling back to "${engines[0]}"`);
  return engines[0];
}

/** Live sockets for every configured engine. Never throws. */
export function buildSideTranscribers(env: NodeJS.ProcessEnv = process.env): Transcriber[] {
  const out: Transcriber[] = [];
  for (const name of configuredEngines(env)) {
    const build = BUILDERS[name];
    if (!build) continue;
    try {
      out.push(build());
    } catch (e) {
      console.error(`[STT] could not build ${name} — continuing without it:`, e);
    }
  }
  return out;
}

export type { Transcriber, TranscriberOptions, TranscriptTurn } from './types';
