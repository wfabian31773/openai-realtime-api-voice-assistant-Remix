<!-- Source: ai-bridge PR #32, branch claude/test-bench; vendored from /workspace/opline-pack-01.md. -->

# Pack 01 — the defects found 2026-10-28/29

Ten calls. Run once on the live build (baseline), and again after Wayne
publishes the build carrying v140/v141 and the fixes in flight. Same script both
times; the scorecard compares them.

Every caller's surname is **Benchmark**. Tag each call at the end:
*"Please note this was test call scenario <id>."* (skip on A4, which hangs up).

---

## A1 — optical, a plain request filed in one pass

- **Dial:** optical.
- **Caller:** Lena Benchmark, date of birth March 3, 1961, usual office Covina.
- **Script:** "I'd like to pick up my glasses." Answer each question as asked:
  last name (spell it if asked: B-E-N-C-H-M-A-R-K), first name, date of birth,
  office. Accept whatever the agent offers.
- **Expect:**
  - a ticket is filed and its number is read back or confirmed;
  - the date of birth is asked once, not twice;
  - the agent never says it could not hear you while you are talking.

## A2 — optical, an office we do not have

- **Dial:** optical.
- **Caller:** Marco Benchmark, date of birth July 19, 1974.
- **Script:** "I need to order more contact lenses." When asked for your
  office, say "Redmond". If asked again, say "I'm not sure, the one near my
  house."
- **Expect:**
  - the office is asked at most twice;
  - a ticket is still filed (unassigned is fine) — the call does not end with
    nothing filed;
  - the agent does not say "it's noted" or "a coordinator will follow up"
    without a ticket number.

## A3 — optical, a new patient

- **Dial:** optical.
- **Caller:** Nadia Benchmark, date of birth November 2, 1990.
- **Script:** "I'd like to make an appointment for an eye exam." When asked if
  you are a new or existing patient, say only "New."
- **Expect (build with v141):** the agent does not search for your record and
  never says "I couldn't find a record for you"; a request is taken.
- **Expect (baseline v136):** recorded for comparison only.

## A4 — tech, the caller who leaves mid-interview

- **Dial:** tech.
- **Caller:** Owen Benchmark, date of birth January 15, 1958.
- **Script:** "My right eye has been red and itchy for two days, can someone
  call me back?" Give your last name and first name when asked. **Hang up the
  moment the agent asks for your date of birth.** No tag on this one.
- **Expect:** a ticket exists afterwards anyway (filed at the end of the call
  with your name), because you stated a request and gave your name.

## A5 — tech, asking for a person

- **Dial:** tech.
- **Caller:** Priya Benchmark, date of birth May 30, 1983.
- **Script:** Open with "Can I talk to a representative?" When the agent
  answers, say "I really need a person." When it offers to take a message,
  say "Okay, fine." Then: "I need to reschedule my appointment next week."
  Answer what it asks.
- **Expect:**
  - the agent apologises, says it can only take a message, and says a team
    member will follow up;
  - it never says it will connect or transfer you;
  - a ticket is filed.

## A6 — surgery, a surgeon the caller cannot name

- **Dial:** surgery.
- **Caller:** Quinn Benchmark, date of birth August 8, 1952.
- **Script:** "I need to move my surgery date." When asked which surgeon, say
  "I don't remember." If asked again, say "I really don't know his name."
- **Expect:**
  - the surgeon is asked at most twice;
  - a ticket is filed anyway (unassigned is fine);
  - the call does not end with nothing filed.

## A7 — surgery line, a glasses question

- **Dial:** surgery.
- **Caller:** Rosa Benchmark, date of birth December 12, 1966, usual office
  Covina.
- **Script:** "I'm calling to check if my glasses are ready." Answer what it
  asks.
- **Expect:**
  - the request is filed to the optical team (the agent may say so);
  - the agent reads back or confirms a ticket number;
  - it never says "it's noted" or "a coordinator will follow up" without one.

## A8 — records, the patient asks for their own records

- **Dial:** records.
- **Caller:** Sofia Benchmark, date of birth April 4, 1979.
- **Script:** "I need a copy of my medical records." When asked how you'd like
  to receive the form or link, choose **text** to this number.
- **Expect:**
  - a records request is filed;
  - the agent says a link has been sent by text;
  - a text with a signing link arrives on the operator line (note in the
    "done" comment whether it arrived).

## A9 — records, an attorney's office

- **Dial:** records.
- **Caller:** Tomas Benchmark, a paralegal at "Benchmark and Hale LLP",
  requesting records for a client, Uma Benchmark, date of birth June 21, 1970.
- **Script:** "I'm calling from a law office to request medical records for a
  client." Answer what it asks; if asked where to send them, say "by fax"
  and give fax number 555-0100.
- **Expect:**
  - a records request is filed for the client, not for the caller;
  - no signing link is offered to the attorney;
  - the agent asks where the records should go.

## A10 — tech, a Spanish-speaking caller

- **Dial:** tech.
- **Caller:** Valeria Benchmark, fecha de nacimiento 9 de septiembre de 1965.
- **Script:** Speak Spanish throughout. "Hola, necesito una cita, me duele el
  ojo izquierdo." Answer what it asks, in Spanish.
- **Expect:**
  - the agent switches to Spanish and stays in it;
  - a ticket is filed;
  - the date of birth is asked once.
