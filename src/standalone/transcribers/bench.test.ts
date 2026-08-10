/**
 * The bench's own guarantees. If these are wrong, the comparison we spend an
 * evening on is wrong, and we pick the wrong vendor on bad evidence.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { configuredEngines, primaryEngine } from './index';

describe('engine selection', () => {
  it('defaults to deepgram alone', () => {
    expect(configuredEngines({} as NodeJS.ProcessEnv)).toEqual(['deepgram']);
    expect(primaryEngine({} as NodeJS.ProcessEnv)).toBe('deepgram');
  });

  it('runs every named engine and lets the primary be any of them', () => {
    const env = { STT_ENGINES: ' deepgram , assemblyai ', STT_PRIMARY: 'assemblyai' } as NodeJS.ProcessEnv;
    expect(configuredEngines(env)).toEqual(['deepgram', 'assemblyai']);
    expect(primaryEngine(env)).toBe('assemblyai');
  });

  it('refuses openai as a transcriber, however it is named', () => {
    // It fabricates speech out of silence and the agent answered it on live
    // patient calls ("I just got promoted at work today", 2026-04-22). Being
    // quietly demoted to a fallback is not enough: the failover in demoLine
    // acts on a secondary engine exactly when the primary is silent, which is
    // exactly when this one invents a caller.
    expect(configuredEngines({ STT_ENGINES: 'openai' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(configuredEngines({ STT_ENGINES: 'openai,deepgram' } as NodeJS.ProcessEnv)).toEqual(['deepgram']);
    expect(primaryEngine({ STT_ENGINES: 'openai', STT_PRIMARY: 'openai' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('never leaves the agent deaf when the primary was not switched on', () => {
    // Naming a primary you forgot to enable is the obvious operator slip, and
    // silently having NO input is far worse than using the wrong engine.
    const env = { STT_ENGINES: 'deepgram', STT_PRIMARY: 'assemblyai' } as NodeJS.ProcessEnv;
    expect(primaryEngine(env)).toBe('deepgram');
  });

  it('ignores a typo instead of failing the call', () => {
    const env = { STT_ENGINES: 'deepgram,assemblyia' } as NodeJS.ProcessEnv;
    expect(configuredEngines(env)).toEqual(['deepgram']);
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
