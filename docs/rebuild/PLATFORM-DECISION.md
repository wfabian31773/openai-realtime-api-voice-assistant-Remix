# Platform decision — AssemblyAI Voice Agent API

**Part 2 of the rebuild spec.** Companion to `TOOL-LIBRARY-SPEC.md`.

Status: **decided in favour of AssemblyAI**, pending one live spike.
Vendor facts below were confirmed by Wayne against AssemblyAI's billing and
tools documentation on 2026-08-11 — they are not inferences.

---

## 1. Confirmed vendor facts

| Question | Answer |
|---|---|
| Session rate | **$0.075/min ($4.50/hr)**, all-inclusive: STT + LLM + TTS + turn detection + interruption + tool calling |
| HIPAA BAA | **Free.** Signable without a sales call. PCI-DSS certified end to end |
| Custom LLM | **Session still billed at the same $0.075/min.** Your LLM is billed separately by your own provider. AssemblyAI calls your endpoint at runtime |
| LLM Gateway | Billed **additively** on top of the session rate, per input/output token |
| Tool timeout | `timeout_seconds` accepts **1–300s**, default 120. On timeout the agent apologises and the session continues |
| Idle billing | **Idle time is billable.** Silence on an open connection bills at the full rate |
| Session close | **`session.end` must be sent.** Closing the socket alone leaves a **30-second grace window that is also billed** |

### What this settles

- **`sage_book`'s 75-second budget is fine.** Set `timeout_seconds: 75`. Well
  inside the 1–300 range, and a timeout degrades to an apology rather than a
  dropped call — better than what we have.
- **The managed LLM is free.** Since the session rate is identical either way,
  **start on their managed model.** Move to custom Claude only if quality
  demands it. That removes a variable and a bill from the first spike.
- **Vapi stays out.** $2,000/month for HIPAA, against $0 here.

---

## 2. The economics, with exact minutes

Measured from `call_logs`, 11 days to 2026-08-11. Total **41,642 min/month**.

| Call length | Calls | Avg | % of minutes | AssemblyAI $/mo |
|---|---|---|---|---|
| under 3 min | 3,786 | 1.5 min | 36.7% | $1,147 |
| 3–6 min | 1,085 | 4.0 min | 28.2% | $880 |
| 6–10 min | 221 | 7.7 min | 11.2% | $349 |
| **over 10 min** | **186** | **19.7 min** | **23.9%** | **$748** |

| Scenario | Monthly |
|---|---|
| **OpenAI today** | **$4,694** |
| AssemblyAI, no hygiene, +30s grace leak | $3,663 |
| AssemblyAI, managed LLM, hygiene applied | **~$2,604** |

**Saving: ~$2,090/month — about 45%, or $25,000/year.**

Custom Claude would add its own token cost on top of the same session rate;
budget for it only if the managed model proves insufficient.

---

## 3. Two hard engineering requirements

Idle billing turns both of these from hygiene into architecture. They are
**not optional** and they are worth more than any prompt tuning.

### 3.1 `session.end` on every terminal path — worth ~$540/month

~14,400 calls/month × 30 seconds of billable grace = **7,197 wasted minutes.**

Every path that ends a call must send `session.end` explicitly: normal
completion, caller hangup, error, timeout, guardrail trip, and every early
return. Closing the socket is **not** ending the session.

This is close to one line of code and it is **$6,480/year.**

### 3.2 A hard maximum call duration — worth ~$519/month

**186 calls averaged 19.7 minutes and consumed 24% of all minutes.** This is an
answering service that takes messages; nothing it does legitimately needs
twenty minutes. Those are stuck loops and open silent lines.

Capping at six minutes recovers ~6,900 minutes/month. The cap needs a graceful
exit — apologise, file what was gathered, end the session — not a hard drop.

**Both apply to the current OpenAI system too, where the same calls cost more.
Neither should wait for the migration.**

---

## 4. Why idle billing matters more here than it looks

On OpenAI, a silent line costs less than a talking one — no audio tokens flow.
On AssemblyAI it is **pure wall-clock**: a silent minute and a busy minute cost
exactly the same $0.075.

That is not a reason to avoid AssemblyAI — the all-in rate is still far below
today's $0.124/min. But it does mean **call-duration discipline becomes the
primary cost lever**, replacing prompt-size discipline. Design for it up front:
short turn timeouts, a maximum silence window, and an explicit end on every
path.

---

## 5. Open before commitment

1. **The live spike** — one agent, one department, two or three existing HTTP
   tools, one real call. Verifies the tool contract, latency, and `session.end`
   behaviour on a real line.
2. **Confirm the managed LLM handles the tool-calling load.** The extraction
   quality bar is already measured: `lookup_schedule` must fire with
   `first_name`, `last_name`, `date_of_birth` from ordinary speech.
3. **Sign the BAA before any call carries PHI.**
