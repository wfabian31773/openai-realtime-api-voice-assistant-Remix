# Grok Speech to Speech API — the complete reference

**This is the transport both new pipelines run on.** The 5Star DRS line runs it
today (`server/scheduling-core/providers/grok/grokSession.ts`); the Remix runtime
(`src/runtime/`) is the same wire layer ported across. Every barge-in complaint,
every "the agent talked over the patient", every disclosure question and every
Spanish-caller problem on those two lines is a question about the parameters
below.

Read this before changing anything in `providers/grok/`, `telephony/`,
`src/runtime/`, or any `session.update` payload. It is the vendor contract, not
a summary of our code — where our code differs from it, that difference is
called out in [What we actually send](#what-we-actually-send-and-what-we-leave-on-the-table).

---

## Contents

- [Connection and auth](#connection-and-auth)
- [Models](#models)
- [Session parameters — the complete table](#session-parameters--the-complete-table)
- [Turn detection and barge-in](#turn-detection-and-barge-in)
- [Audio: codecs, sample rates, transport](#audio-codecs-sample-rates-transport)
- [force_message — verbatim scripted speech](#force_message--verbatim-scripted-speech)
- [Per-response instructions](#per-response-instructions)
- [Session resumption](#session-resumption)
- [Pronunciation replacements](#pronunciation-replacements)
- [Language hint and keyterms](#language-hint-and-keyterms)
- [Supported languages](#supported-languages)
- [Tools](#tools)
- [Function-call flow, parallel calls, audio overlap](#function-call-flow-parallel-calls-audio-overlap)
- [Prompting and migration](#prompting-and-migration)
- [OpenAI Realtime compatibility](#openai-realtime-compatibility)
- [Best practices](#best-practices)
- [SIP](#sip)
- [What we actually send, and what we leave on the table](#what-we-actually-send-and-what-we-leave-on-the-table)

---

## Connection and auth

A single WebSocket carries the whole session — audio in, audio out, transcripts,
tool calls, lifecycle events.

```
wss://api.x.ai/v1/realtime?model=<model>
Authorization: Bearer $XAI_API_KEY
```

Two auth methods:

- **API key** in the `Authorization` header. **Server-side only.**
- **Ephemeral tokens** (recommended for anything client-side). Browsers cannot
  set WebSocket headers, so the token rides the WebSocket subprotocol instead:

  ```js
  new WebSocket("wss://api.x.ai/v1/realtime",
    [`xai-client-secret.${XAI_EPHEMERAL_TOKEN}`]);
  ```

Our lines are server-side (Twilio Media Streams → our bridge → xAI), so we use
the API key. Ephemeral tokens matter only if a browser or mobile client ever
talks to xAI directly.

## Models

`model` is a **query parameter on the connection URL**, not a field in
`session.update`.

| Model | Description |
|---|---|
| `grok-voice-latest` | Alias for `grok-voice-think-fast-2.0` |
| `grok-voice-think-fast-2.0` | Flagship voice model |
| `grok-voice-think-fast-1.0` | Previous generation |

**Pin a versioned name in production.** `grok-voice-latest` moves under you.
We pin `grok-voice-think-fast-2.0` (`providers/grok/config.ts`) — correct.

## Session parameters — the complete table

Sent via `session.update` after the session is created. Echoed back on
`session.updated`.

| Parameter | Type | Description |
|---|---|---|
| `instructions` | string | System prompt. Second person, fixed section order. |
| `reasoning.effort` | `"high"` \| `"none"` | Whether the model reasons. **Defaults to `"high"`.** |
| `voice` | string | Built-in voice id (e.g. `eve`) or a custom voice id. |
| `tools` | array | `file_search`, `web_search`, `x_search`, `mcp`, `function`. |
| `turn_detection.type` | `"server_vad"` \| `null` | `null` = manual text turns. |
| `turn_detection.threshold` | number 0.1–0.9 | VAD activation. Higher = louder audio required to trigger. **Default `0.85`.** |
| `turn_detection.silence_duration_ms` | number 0–10000 | Silence before the server ends the caller's turn. Higher = the caller can pause longer without being cut off. |
| `turn_detection.prefix_padding_ms` | number 0–10000 | Audio included *before* detected speech onset, so first syllables are not clipped. **Default `333`.** |
| `turn_detection.idle_timeout_ms` | number \| null | Server proactively re-engages if the caller is silent this long after the assistant finishes. **Re-arms after every response** and fires repeatedly until the caller speaks. Default `null`. |
| `resumption.enabled` | boolean | Cache turns by `conversation_id` and replay on reconnect. Default `false`. |
| `audio.input.format.type` | string | `audio/pcm` \| `audio/pcmu` \| `audio/pcma` \| `audio/opus` |
| `audio.input.format.rate` | number | PCM only: 8000, 16000, 22050, 24000, 32000, 44100, 48000 |
| `audio.input.transport` | `"json"` \| `"binary"` | Wire path for input audio. Default `"json"`. |
| `audio.output.format.type` | string | Same codec set as input; **input and output need not match**. |
| `audio.output.format.rate` | number | PCM only, same set. |
| `audio.output.transport` | `"json"` \| `"binary"` | Default `"json"`. Mid-session changes apply at the **next response boundary**. |
| `audio.input.transcription.language_hint` | string | BCP-47 code to bias ASR. Updatable mid-session. |
| `audio.input.transcription.keyterms` | array | Bias transcription toward these terms. **Max 100 terms, 50 chars each.** Updatable mid-session. |
| `audio.output.speed` | number 0.7–1.5 | Playback speed. Default `1.0`. |
| `replace` | object | Phrase → spoken substitution, applied before TTS. Audio changes, transcript does not. |

## Turn detection and barge-in

With `turn_detection.type: "server_vad"` the server does voice activity
detection and emits `input_audio_buffer.speech_started` /
`speech_stopped`. You then only need `input_audio_buffer.append` — no manual
`commit`.

With `turn_detection: null` you must send `input_audio_buffer.commit` when the
caller stops, and `input_audio_buffer.clear` to discard appended-but-uncommitted
audio.

The docs describe `server_vad` as giving "automatic, natural barge-in".

### The three knobs, and the one that does not exist

**There is no server-side "require sustained speech before cancelling"
parameter.** The full set of levers the API gives you over barge-in sensitivity
is:

1. `threshold` — 0.1 to 0.9, default 0.85. This is the only sensitivity control.
   **We already run 0.85, i.e. the default; 0.9 is the ceiling.**
2. `prefix_padding_ms` — affects *capture*, not sensitivity. Raising it does not
   make barge-in less trigger-happy.
3. `silence_duration_ms` — governs when the caller's turn *ends*, not when the
   assistant gets cut off.

**Consequence, and this matters for the SG-01 defect:** a hold-off between
`speech_started` and cancelling assistant playback cannot be bought from the
API. It has to be implemented locally in the bridge — wait a short window after
`speech_started`, and only cancel the response and send Twilio `clear` if speech
is still present. See
[What we actually send](#what-we-actually-send-and-what-we-leave-on-the-table).

## Audio: codecs, sample rates, transport

**Codec (`format`) and wire path (`transport`) are independent settings.**

| Format | Encoding | Sample rate |
|---|---|---|
| `audio/pcm` (default) | Linear16 little-endian | Configurable (below) |
| `audio/pcmu` | G.711 μ-law | 8000 Hz |
| `audio/pcma` | G.711 A-law | 8000 Hz |
| `audio/opus` | Opus, one packet per payload | 24000 Hz |

PCM rates: 8000 (telephone), 16000 (wideband), 22050, **24000 (default,
recommended)**, 32000, 44100, 48000.

**Telephony: `audio/pcmu` at 8000 Hz on both legs matches Twilio Media Streams
exactly and passes through with no transcoding.** That is what we do, and it is
the right call — native G.711 μ-law/A-law support is one of the API's stated
enterprise features.

### Transport

|  | Input | Output |
|---|---|---|
| `json` (default) | Base64 in `input_audio_buffer.append` | Base64 in `response.output_audio.delta` / `response.audio.delta` |
| `binary` | Raw codec bytes as WebSocket **binary** frames, no protocol header | Same; lifecycle events stay JSON |

- **Input dual-accepts.** Once the input format is configured the server takes
  both JSON append *and* binary frames for that codec. You do not have to drain
  one before using the other.
- **Output is strict.** Assistant audio is emitted only on `output.transport`.
  A mid-session change applies at the next response boundary, so one utterance
  never mixes base64 deltas and binary frames.
- **Opus:** one raw 24 kHz mono packet per delta field or per binary frame. No
  extra framing header.

## force_message — verbatim scripted speech

**An xAI extension. Not in the OpenAI Realtime API.** Makes the agent speak a
hard-coded, TTS-synthesised line **without involving the model at all**.

```json
{ "type": "conversation.item.create",
  "item": { "type": "force_message", "role": "assistant",
            "interruptible": false,
            "content": [{ "type": "output_text",
                          "text": "This call is being recorded." }] } }
```

**Do NOT send `response.create` afterwards — the force_message *is* the turn.**

| Field | Required | Default | Description |
|---|---|---|---|
| `item.type` | yes | — | must be `"force_message"` |
| `item.content[].text` | yes | — | verbatim text, synthesised via TTS |
| `item.interruptible` | no | `true` | **when `false`, caller audio is dropped until playback completes** |

The server injects a full response lifecycle (`response.created` →
`response.output_audio.delta` → `response.done`) so it looks like a normal model
turn to the client.

The docs name the exact use case: **scripted greetings, compliance disclosures
("This call is being recorded"), IVR prompts** — anything that must be delivered
verbatim.

## Per-response instructions

Override the session prompt for **one** response:

```json
{ "type": "response.create",
  "response": { "instructions": "Respond in Spanish for this turn only." } }
```

Reverts on the next response. The documented use is injecting dynamic context —
CRM data, caller info — or temporarily changing behaviour without a
`session.update`.

## Session resumption

By default a `/v1/realtime` connection loses its history when the socket closes.

1. Send `resumption: { enabled: true }` on `session.update`. Read
   `conversation.created.conversation.id` and store it.
2. Reconnect to `wss://api.x.ai/v1/realtime?model=<model>&conversation_id=<id>`
   **and opt in again**. Cached turns replay as `conversation.item.created`
   events before your first new turn.

- Persisted: user and assistant transcripts, assistant tool calls, and your
  `function_call_output` results.
- **Opt-in both ways** — nothing replays unless the resuming session also sets
  `resumption.enabled: true`.
- **History is dropped after 30 minutes of inactivity.**

## Pronunciation replacements

`replace` maps phrases to spoken substitutions applied **before TTS**. Only the
audio changes; the transcript keeps the original text.

```json
{ "type": "session.update",
  "session": { "replace": { "Acme Mobile": "Acme Mobull" } } }
```

- Case-insensitive match; the replacement is spoken with the casing you give.
- **Whole-word boundaries required** — `Acme, Mobile`, `Acme-Mobile` and
  `Acme Mobiles` do **not** match.
- Longest match wins among shared prefixes.
- Updatable mid-session; the applied map is echoed on `session.updated`.

## Language hint and keyterms

Both live under `audio.input.transcription` and both are updatable mid-session.

**`language_hint`** — a BCP-47 code biasing ASR toward one language.
**Spanish and Portuguese require a regional variant**: `es-MX`, `es-ES`,
`pt-BR`, `pt-PT`. Bare `es` and `pt` are **not accepted**. Unrecognised codes
are **silently ignored** and fall back to auto-detection — so a typo here fails
invisibly, which is exactly the failure shape recorded in
[measurement-traps.md](measurement-traps.md).

**`keyterms`** — an array biasing transcription toward domain vocabulary:
product names, proper nouns, brand names, technical terms. **Max 100 terms,
each up to 50 characters.**

## Supported languages

20+ with native-quality accents. **The model auto-detects the input language and
replies in it — no configuration required.** It also handles code-switching
within a conversation.

`en`, `ar-EG`, `ar-SA`, `ar-AE`, `bn`, `zh`, `fr`, `de`, `hi`, `id`, `it`, `ja`,
`ko`, `pt-BR`, `pt-PT`, `ru`, `es-MX`, `es-ES`, `tr`, `vi`.

Other languages work with varying accuracy. You can pin a preferred language or
accent in the system instructions for consistency.

## Tools

Five tool types in `session.tools`:

| Type | Executed by | Client handling needed |
|---|---|---|
| `file_search` (Collections) | xAI, server-side | no |
| `web_search` | xAI, server-side | no |
| `x_search` | xAI, server-side | no |
| `mcp` (remote MCP server) | xAI, server-side | no |
| `function` (custom) | **you** | **yes** |

### file_search

```json
{ "type": "file_search", "vector_store_ids": ["<collection-id>"],
  "max_num_results": 10 }
```

### web_search

| Parameter | Description |
|---|---|
| `allowed_domains` | Domains only, no protocol or path. Max 5. **Mutually exclusive with `excluded_domains`.** |
| `excluded_domains` | Max 5. Mutually exclusive with `allowed_domains`. |
| `enable_image_understanding` | Let the agent view images found. |
| `location` | `country` (ISO 3166-1 alpha-2 or full name), `city`, `region`, `timezone` (IANA). Also accepted as `user_location`. |

### x_search

| Parameter | Description |
|---|---|
| `allowed_x_handles` | No `@`. Max 20. **Mutually exclusive with `excluded_x_handles`.** |
| `excluded_x_handles` | Max 20. |
| `from_date` / `to_date` | ISO-8601 `YYYY-MM-DD`. `from_date` must not be later than `to_date`. |
| `enable_image_understanding` / `enable_video_understanding` | View media in posts. |

An invalid configuration — too many entries, `allowed_*` and `excluded_*`
together, a malformed or inverted date window — is rejected with an `error`
event describing the problem. **The session stays connected and its previous
configuration remains in effect.**

### mcp

| Parameter | Required | Description |
|---|---|---|
| `server_url` | yes | Streaming HTTP and SSE transports only. |
| `server_label` | yes | Used for tool-call prefixing. |
| `server_description` | no | |
| `allowed_tools` | no | Omit to expose all of the server's tools. |
| `authorization` | no | Sent as the `Authorization` header to the MCP server. |
| `headers` | no | Additional headers. |

Multiple MCP servers can be connected simultaneously.

### function

```json
{ "type": "function", "name": "generate_random_number",
  "description": "...",
  "parameters": { "type": "object",
                  "properties": { "min": {"type":"number"},
                                  "max": {"type":"number"} },
                  "required": ["min","max"] } }
```

Server-side and client-side tools can be combined in one `tools` array.

## Function-call flow, parallel calls, audio overlap

| Event | Direction | Meaning |
|---|---|---|
| `response.function_call_arguments.done` | server → client | Call triggered, arguments complete |
| `conversation.item.create` (`function_call_output`) | client → server | Your result |
| `response.create` | client → server | Continue |

Flow: agent calls → you execute → you send `function_call_output` with the
matching `call_id` → you send `response.create`.

### Parallel tool calling

When several calls are needed the model emits **multiple**
`response.function_call_arguments.done` events **before any audio**.

> **Do not send `response.create` until every function output has been
> submitted.** Sending it early makes the model respond without the complete
> context from the remaining tool results.

### Avoiding overlapping audio

The server delivers all audio deltas first, then the function-call events
alongside `response.done`. If the client immediately sends the output and then
`response.create`, generation starts while the client is **still playing the
previous turn's audio** — the caller hears two things at once.

Recommended sequence:

1. `response.function_call_arguments.done` → execute the tool
2. send `conversation.item.create` with `function_call_output`
3. **wait until playback of the current turn is complete (or nearly)**
4. then send `response.create`

Show a thinking indicator during step 3 in a UI. On a phone line, the equivalent
is that playback completion is gated on Twilio `mark` events — the only ground
truth that audio reached the caller.

## Prompting and migration

`instructions` is the system prompt: second person, fixed section order, so the
agent stays near the training distribution. There is a separate xAI prompting
guide covering structure, tool hygiene and escalation.

Migrating from OpenAI Realtime is three changes: base URL, API key, model name.
The OpenAI SDK works against `https://api.x.ai/v1` / `wss://api.x.ai/v1/realtime`.

For `grok-voice-think-fast-2.0` the vendor's own migration guidance is:

- **Simplify the system prompt.** The model is significantly more capable; the
  prompt should be much *shorter*. Generalise the existing prompt rather than
  porting it verbatim.
- **Remove workaround prompting.** Prompt hacks and edge-case patches written
  for GPT models are unnecessary — strip instructions that exist only to paper
  over the previous model's bugs.
- **Reasoning is on by default** (`reasoning.effort: "high"`) for multi-step
  instructions, nuanced tone and ambiguous queries. Set `"none"` to disable.

This is directly relevant to task #25 (trim the queue-agent prompts for Grok):
a long prompt full of anti-repetition workarounds written against the OpenAI
Realtime model is, per the vendor, actively the wrong thing to carry over.

## OpenAI Realtime compatibility

Most OpenAI Realtime client libraries work by changing the base URL. Differences:

### Renamed events

- OpenAI's `conversation.item.input_audio_transcription.delta` is
  **`conversation.item.input_audio_transcription.updated`** on xAI, and the
  payload differs: `updated` carries the **cumulative** transcript, which **may
  correct earlier updates**, rather than an incremental delta. Only emitted when
  `audio.input.transcription.model` is `"grok-transcribe"`.

### Unsupported client events

| Event | Note |
|---|---|
| `conversation.item.retrieve` | Not supported |
| `output_audio_buffer.clear` | WebRTC/SIP only |

### Unsupported server events

| Event | Note |
|---|---|
| `conversation.item.done` | Not emitted |
| `conversation.item.input_audio_transcription.failed` | **Not emitted** |
| `conversation.item.input_audio_transcription.segment` | Not supported |
| `conversation.item.retrieved` | Not supported |
| `output_audio_buffer.started` / `.stopped` / `.cleared` | WebRTC/SIP only |
| `rate_limits.updated` | Not emitted |

**`input_audio_transcription.failed` is never emitted.** Do not write a handler
for it and do not treat its absence as evidence transcription succeeded — that
is the zero-means-not-instrumented trap in
[measurement-traps.md](measurement-traps.md).

### xAI extensions

| Feature | Description |
|---|---|
| `force_message` | Verbatim TTS utterance, model bypassed |
| `resumption` | Cache and replay conversation turns across reconnects |
| `replace` | Pre-TTS pronunciation substitutions |

## Best practices

- **Parallel initialisation.** Open the WebSocket *and* start capturing
  microphone audio at the same time. Do not wait for the socket's `open` event
  to begin buffering; flush the buffer once connected.
- Convert to the target format before buffering; flush in ~100 ms chunks.
- **Prefer ephemeral tokens** for anything client-side.
- **Enable `server_vad`** for automatic barge-in.
- **Match input and output format** to avoid resampling.
- **Stream output deltas to the speaker immediately** — never wait for the full
  response.
- Implement graceful reconnection, continuing to buffer during it.
- Monitor socket health; exponential backoff.

## SIP

PSTN, contact-centre and PBX calls can be routed straight into a session —
`CreatePhoneNumberV2`, call control, DTMF. Note that `output_audio_buffer.*`
events are **WebRTC/SIP only** and do not exist on the WebSocket path we use.

---

## What we actually send, and what we leave on the table

Measured against `server/scheduling-core/` in the 5Star repo (the DRS line) and
the ported runtime in `src/runtime/`.

### Correct today

| Thing | Where | Note |
|---|---|---|
| Pinned model | `providers/grok/config.ts` — `grok-voice-think-fast-2.0` | Vendor says pin in production. |
| μ-law 8 kHz both legs | `grokSession.ts` `AUDIO_FORMAT` | Matches Twilio exactly, no transcoding. |
| `server_vad`, `prefix_padding_ms: 333` | `grokSession.ts` `TURN_DETECTION` | 333 is the documented default. |
| `force_message` for scripted EN/ES copy | `grokSession.ts` | The right mechanism — the model cannot paraphrase it. |
| `language_hint`, retargetable mid-call | `grokSession.ts` | Correct mechanism for a mid-call language switch (task #74). |
| `response.cancel` gated on an open response | `grokSession.ts` | The wire only accepts it while a response is open. |

### Available and unused

| Capability | Status in our code | What it would buy |
|---|---|---|
| `keyterms` | **typed in `wireTypes.ts`, never sent** | Bias ASR toward surgeon names, drug names, office names — the exact vocabulary identity capture keys on (#48). Max 100 terms × 50 chars. |
| `idle_timeout_ms` | **typed in `wireTypes.ts`, never sent** | Server re-engages a silent caller instead of the line sitting dead. Compare our local `deadAirWatchdog` ([zombie-calls-dead-air.md](zombie-calls-dead-air.md)) — this is the server-side version, and it re-arms after every response. |
| `resumption` | mentioned in a comment only | Conversation survives a socket drop. 30-minute inactivity window. |
| `replace` | not used | Pronunciation of practice, office and surgeon names. |
| `audio.output.speed` | not used | 0.7–1.5. |
| `transport: "binary"` | not used | Removes base64 overhead on every audio frame both directions. |

### Where the API cannot help, and local code must

**SG-01 (12 abandoned DRS calls on 2026-09-02; 82 interruptions across 25
inbound and 58 across 18 outbound).** The bridge cancels the response and sends
Twilio `clear` synchronously inside `handleCallerSpeechStarted` the instant
Grok's server VAD emits `speech_started`.

Our session config is **not** misconfigured: `threshold` is 0.85, which is the
documented default, and 0.9 is the ceiling. **The API exposes no "wait for
sustained speech before cancelling" parameter.** So the remedy is local: a short
hold-off between `speech_started` and the cancel-plus-clear, abandoned if
`speech_stopped` arrives first. Nudging `threshold` to 0.9 is the only tuning
the vendor offers and is not on its own a fix.

Recorded here so the next agent does not go looking for a session parameter that
does not exist.

**Recording disclosure (AS-08 / SG-R1 / tasks #79, #54).** The mechanism is
already in the codebase and already used: `force_message`. The disclosure needs
**`interruptible: false`** — our existing `sendSay` path sends
`interruptible: true`. `false` drops caller audio until playback completes,
which is what a compliance line requires. The vendor documentation names "This
call is being recorded" as the example use of the flag. Whether to say it, and
with what wording, is Wayne's and compliance's decision — but nobody should
report this as needing new plumbing.

---

## See also

- [Realtime tool schemas](realtime-tool-schemas.md) — **never `strict: true` on
  a generated schema.** The xAI `function` tool takes a plain JSON Schema; the
  same failure mode applies to anything that converts one.
- [Input transcription](transcription-config.md) — the hard `language:'en'`
  default that garbled every Spanish caller. `language_hint` is the equivalent
  knob here, and unrecognised codes fail **silently**.
- [Zombie calls / dead air](zombie-calls-dead-air.md) — our local watchdog;
  `idle_timeout_ms` is the server-side counterpart.
- [Measurement traps](measurement-traps.md) — accepted ≠ delivered, and
  absence-in-a-log ≠ absence-in-the-world. Several events in this API are
  documented as never emitted.
