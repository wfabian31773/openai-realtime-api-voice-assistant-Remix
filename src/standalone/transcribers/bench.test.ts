/**
 * The bench's own guarantees. If these are wrong, the comparison we spend an
 * evening on is wrong, and we pick the wrong vendor on bad evidence.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { configuredEngines, primaryEngine } from './index';

describe('engine selection', () => {
  it('defaults to openai alone — today’s behaviour, until someone opts in', () => {
    expect(configuredEngines({} as NodeJS.ProcessEnv)).toEqual(['openai']);
    expect(primaryEngine({} as NodeJS.ProcessEnv)).toBe('openai');
  });

  it('runs every named engine and lets the primary be any of them', () => {
    const env = { STT_ENGINES: 'openai, assemblyai ,deepgram', STT_PRIMARY: 'assemblyai' } as NodeJS.ProcessEnv;
    expect(configuredEngines(env)).toEqual(['openai', 'assemblyai', 'deepgram']);
    expect(primaryEngine(env)).toBe('assemblyai');
  });

  it('never leaves the agent deaf when the primary was not switched on', () => {
    // Naming a primary you forgot to enable is the obvious operator slip, and
    // silently having NO input is far worse than using the wrong engine.
    const env = { STT_ENGINES: 'openai', STT_PRIMARY: 'deepgram' } as NodeJS.ProcessEnv;
    expect(primaryEngine(env)).toBe('openai');
  });

  it('ignores a typo instead of failing the call', () => {
    const env = { STT_ENGINES: 'openai,assemblyia' } as NodeJS.ProcessEnv;
    expect(configuredEngines(env)).toEqual(['openai']);
  });
});

describe('what each vendor is actually sent', () => {
  const read = (f: string) => readFile(join(__dirname, f), 'utf8');
  /** Comments may DISCUSS the wrong scheme; code must not use it. */
  const codeOf = async (f: string) =>
    (await read(f)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('sends phone audio at its native 8kHz mu-law — never upsampled', async () => {
    const aai = await codeOf('assemblyai.ts');
    const dg = await codeOf('deepgram.ts');
    // Both vendors document that upsampling telephony audio hurts accuracy.
    expect(aai).toMatch(/encoding: 'pcm_mulaw'/);
    expect(aai).toMatch(/sample_rate: '8000'/);
    expect(dg).toMatch(/encoding: 'mulaw'/);
    expect(dg).toMatch(/sample_rate: '8000'/);
    // Nothing anywhere resamples.
    expect(/resample|upsample|16000/.test(aai + dg)).toBe(false);
  });

  it('uses each vendor’s own auth scheme — mixing them yields a silent 401', async () => {
    const aai = await codeOf('assemblyai.ts');
    const dg = await codeOf('deepgram.ts');
    // AssemblyAI: raw key, no Bearer.
    expect(aai).toMatch(/Authorization: key/);
    expect(/Bearer/.test(aai)).toBe(false);
    // Deepgram: "Token <key>".
    expect(dg).toMatch(/Authorization: `Token \$\{key\}`/);
  });

  it('always terminates a session — an abandoned one bills to the cap', async () => {
    expect(await read('assemblyai.ts')).toMatch(/type: 'Terminate'/);
    expect(await read('deepgram.ts')).toMatch(/type: 'CloseStream'/);
  });
});
