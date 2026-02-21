/**
 * OpenAI Agents SDK - Language Configuration Reference
 * 
 * CRITICAL: Language is configured at the API level via inputAudioTranscription.language
 * This is the proper way to set language - NOT through prompt engineering.
 * 
 * Reference: https://openai.github.io/openai-agents-js/guides/voice-agents/build/
 */

import { RealtimeSession, RealtimeAgent, OpenAIRealtimeSIP } from '@openai/agents/realtime';

// Example: Creating a session with language-specific transcription
const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'You are a helpful assistant.',
});

// CORRECT: Set language via session config
const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
  config: {
    // This is the API-level language setting
    input_audio_transcription: {
      model: 'gpt-4o-transcribe', // or 'whisper-1'
      language: 'en',             // ISO 639-1: 'en', 'es', 'fr', 'de', 'ja', etc.
    },
    audio: {
      output: {
        voice: 'sage', // English voice
      },
    },
  },
});

// For SIP calls, use buildInitialConfig with language:
/*
const initialConfig = await OpenAIRealtimeSIP.buildInitialConfig(agent, {
  config: {
    input_audio_transcription: {
      model: 'gpt-4o-transcribe',
      language: 'es', // Spanish
    },
  },
});
await openai.realtime.calls.accept(callId, initialConfig);
*/

/**
 * Language codes (ISO 639-1):
 * - 'en' = English
 * - 'es' = Spanish  
 * - 'fr' = French
 * - 'de' = German
 * - 'ja' = Japanese
 * - 'zh' = Chinese
 * - etc.
 */
