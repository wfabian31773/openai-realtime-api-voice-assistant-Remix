/**
 * src/runtime/outbound/bookingPage.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOOKING PAGE THE OUTREACH TEXT LINKS TO (v211). Operator, 2026-11-11:
 * "they should get a customized link that lets them book in 4 easy steps."
 *
 *   GET  /book/<token>          the page: four steps, no record data in it
 *   POST /book/<token>/verify   1. the date of birth (month, day, year)
 *   POST /book/<token>/days     2. the days and cities with openings
 *   POST /book/<token>/times    3. the times on one day in one city
 *   POST /book/<token>/book     4. book the one they confirmed
 *
 * THE LINK NAMES NOBODY. The token is random (outreachText.newBookingToken);
 * the row holds only its SHA-256. Until the date of birth matches, nothing
 * from the record is sent: not a name, not the visit, not its date. A wrong,
 * expired, undelivered or used link gets one plain page, "This link has
 * expired", whatever the reason, so a guessed link learns nothing.
 *
 * THE DATE OF BIRTH IS TRIED AT MOST TWICE PER LINK, then the link is locked
 * for good: the same limit as confirm_patient_birthdate on the call, counted
 * in the database (store.spendDobTry), so a reload or a second browser does
 * not get two more. A link already verified may verify again without
 * spending a try, but a wrong date still spends one.
 *
 * WHAT IT OFFERS AND BOOKS IS THE CALL'S, THE ONE COPY. The lane registers a
 * BookingPageLane on its text policy; for NPX that is npxBookingPageLane,
 * which reads the same availability find_sooner_exam reads and books through
 * the same bookOutreachSlot book_sooner_exam uses: NPX, then the Azul cancel,
 * then the cancel report, then the contact settled `completed` with
 * `npx_booking:<id>`. A demo call's rules are the call's too (isDemoNpxCall).
 *
 * BEFORE IT BOOKS, the page re-checks the appointment with the campaign's
 * source, as the dialler does before it rings: a cancelled or moved
 * appointment is never the reason anything is booked. One booking at a time
 * per link (store.claimLinkBooking).
 *
 * Rate-limited by token, in this process: LINK_REQUEST_LIMIT requests per
 * LINK_WINDOW_MS. Every answer is no-store and sends no referrer, because the
 * token is in the address.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes } from "node:crypto";
import type { OutboundContact, OutboundLanePolicy } from "./campaign";
import { dobOnFile } from "./callback";
import { TEXTABLE_STATUSES, type ContactRow, type OutboundStore } from "./store";
import {
  BOOKING_PATH_PREFIX,
  hashBookingToken,
  isBookingTokenShape,
  textRecordOf,
  type OutreachTextRecord,
} from "./outreachText";

/** Date-of-birth tries per link, then it is locked: confirm_patient_birthdate's limit. */
export const LINK_DOB_TRIES = 2;
/** How long a verified page may go on choosing before it must verify again. */
export const LINK_SESSION_MS = 30 * 60 * 1000;
/** Requests one link may make in LINK_WINDOW_MS. */
export const LINK_REQUEST_LIMIT = 40;
export const LINK_WINDOW_MS = 10 * 60 * 1000;
/** The whole booking answers inside this (BOOK_SEQUENCE_BUDGET_MS on the call). */
export const LINK_BOOK_BUDGET_MS = 36_000;
/** A booking hold older than this is a page that died; it may be taken over. */
export const LINK_BOOKING_HOLD_MS = 2 * 60 * 1000;

/** One opening, as the page shows it. Nothing here identifies the patient. */
export interface BookingOpening {
  id: string;
  /** YYYY-MM-DD in the practice's day. */
  day: string;
  /** "Thursday, December 3" */
  dayLabel: string;
  /** "9:40 AM" */
  timeLabel: string;
  city: string;
  /** The partner practice and its street address, without state or ZIP. */
  place: string;
  provider: string;
}

/** What a lane gives its booking page: the call's own rules, as functions. */
export interface BookingPageLane {
  /** A demo link: demo NPX, simulated cancel. */
  isDemo(contact: OutboundContact, campaignKey: string): boolean;
  /** Said once the date of birth matches: the appointment being replaced. */
  currentAppointment(contact: OutboundContact): string;
  openings(contact: OutboundContact, demo: boolean): Promise<{ openings: BookingOpening[] } | { error: string }>;
  book(args: {
    contact: OutboundContact;
    demo: boolean;
    openingId: string;
    callRef: string;
    deadline: number;
  }): Promise<{ ok: true; bookingId: string; confirmation: string } | { ok: false; error: string }>;
}

export interface BookingPageDeps {
  store: () => Promise<OutboundStore>;
  /** The lane's policy, when it registers a booking page; null otherwise. */
  policyFor: (lane: string) => Promise<OutboundLanePolicy | null>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PageResponse {
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

/** Every answer: never cached, never sent onward, never indexed. */
const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const json = (status: number, body: Record<string, unknown>): PageResponse => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
  headers: PRIVATE_HEADERS,
});
const html = (status: number, body: string): PageResponse => ({
  status,
  contentType: "text/html; charset=utf-8",
  body,
  headers: { ...PRIVATE_HEADERS, "Content-Security-Policy": PAGE_CSP },
});

// ── The rate limit, by token ────────────────────────────────────────────────

const hits = new Map<string, number[]>();
const MAX_TRACKED_LINKS = 2_000;

/** True when this link has made too many requests in the window. */
export function overLinkLimit(tokenHash: string, now: number): boolean {
  const recent = (hits.get(tokenHash) ?? []).filter((t) => now - t < LINK_WINDOW_MS);
  recent.push(now);
  hits.delete(tokenHash);
  while (hits.size >= MAX_TRACKED_LINKS) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
  hits.set(tokenHash, recent);
  return recent.length > LINK_REQUEST_LIMIT;
}

/** Tests only. */
export function resetLinkLimitsForTests(): void {
  hits.clear();
}

// ── Reading the link ────────────────────────────────────────────────────────

/** The token as it arrived: a phone's linkifier may keep the sentence's
 * full stop ("Book in 4 steps: <link>."). */
export function cleanToken(raw: string): string {
  return raw.trim().replace(/[.,;:!?)\]]+$/, "");
}

type Link =
  | {
      ok: true;
      hash: string;
      contact: ContactRow;
      record: OutreachTextRecord;
      campaignKey: string;
      policy: OutboundLanePolicy;
      page: BookingPageLane;
    }
  | { ok: false; reason: "expired" | "busy" | "too_many" };

/** States a link can have reached a phone in: sent, a send that may have
 * gone out, or a claim whose send never wrote back. */
const DELIVERED = new Set<OutreachTextRecord["state"]>(["sent", "unknown", "claimed"]);

async function readLink(rawToken: string, deps: BookingPageDeps, now: Date): Promise<Link> {
  const token = cleanToken(rawToken);
  if (!isBookingTokenShape(token)) return { ok: false, reason: "expired" };
  const hash = hashBookingToken(token);
  if (overLinkLimit(hash, now.getTime())) return { ok: false, reason: "too_many" };
  const store = await deps.store();
  const found = await store.contactByTextToken(hash);
  if (!found) return { ok: false, reason: "expired" };
  const { contact, campaignKey } = found;
  const record = textRecordOf(contact.customData);
  if (!record || record.token_hash !== hash || !DELIVERED.has(record.state)) return { ok: false, reason: "expired" };
  if (!record.expires_at || new Date(record.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (record.booked_at) return { ok: false, reason: "expired" };
  // On a call with us right now: the call decides, the link waits.
  if (contact.status === "calling") return { ok: false, reason: "busy" };
  if (!(TEXTABLE_STATUSES as readonly string[]).includes(contact.status)) return { ok: false, reason: "expired" };
  const policy = record.lane ? await deps.policyFor(record.lane) : null;
  const page = policy?.textOutreach?.page;
  if (!policy || !page) return { ok: false, reason: "expired" };
  return { ok: true, hash, contact, record, campaignKey, policy, page };
}

function asContact(c: ContactRow): OutboundContact {
  return {
    contactId: c.id,
    campaignId: c.campaignId,
    attemptId: "",
    phone: c.phone,
    firstName: c.firstName,
    lastName: c.lastName,
    data: c.customData,
  };
}

// ── The pages ───────────────────────────────────────────────────────────────

const SHELL_STYLE = `
  :root { color-scheme: light dark; --fg:#1b1f24; --muted:#57606a; --bg:#ffffff; --line:#d0d7de; --accent:#0b5cad; --error:#a40e26; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --muted:#9da7b3; --bg:#0d1117; --line:#30363d; --accent:#58a6ff; --error:#ff7b72; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font: 18px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 1.25rem 0 .5rem; }
  p { margin: .5rem 0; }
  .muted { color: var(--muted); font-size: .95rem; }
  label { display:block; font-weight:600; margin:.75rem 0 .25rem; }
  input, select { font: inherit; width:100%; padding:.6rem .7rem; border:1px solid var(--line); border-radius:.5rem; background:var(--bg); color:var(--fg); }
  .row { display:flex; gap:.6rem; } .row > div { flex:1; }
  button { font: inherit; font-weight:600; width:100%; margin-top:1rem; padding:.8rem 1rem; border:0; border-radius:.5rem; background:var(--accent); color:#fff; cursor:pointer; }
  button.choice { background:transparent; color:var(--fg); border:1px solid var(--line); text-align:left; font-weight:500; margin-top:.5rem; }
  button.choice[aria-pressed="true"] { border:2px solid var(--accent); }
  button:disabled { opacity:.6; cursor:wait; }
  .error { color: var(--error); font-weight:600; }
  [hidden] { display:none !important; }
`;

function shell(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>${SHELL_STYLE}</style>
</head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body>
</html>`;
}

/** The one page a link that cannot be used gets, whatever the reason. */
export const EXPIRED_PAGE = shell(
  "Link expired",
  `<h1>This link has expired</h1><p>Nothing has been changed. Your current appointment stays as it is.</p>`,
);
const BUSY_PAGE = shell(
  "Please try again shortly",
  `<h1>Please try again in a few minutes</h1><p>This link can't be used right now. Nothing has been changed.</p>`,
);
const TOO_MANY_PAGE = shell(
  "Please wait",
  `<h1>Please wait a few minutes</h1><p>This link has been used many times in a short while. Try again in ten minutes.</p>`,
);

const STEPS_BODY = `
<h1>Book a sooner appointment</h1>
<p class="muted">Azul Vision &middot; four short steps</p>
<p id="error" class="error" role="alert" aria-live="assertive" hidden></p>

<section id="step-dob" aria-labelledby="h-dob">
  <h2 id="h-dob">Step 1 of 4: confirm your date of birth</h2>
  <form id="dob-form" novalidate>
    <div class="row">
      <div><label for="dob-month">Month</label>
        <select id="dob-month" required autocomplete="bday-month">
          <option value="">Month</option>
          <option value="1">January</option><option value="2">February</option><option value="3">March</option>
          <option value="4">April</option><option value="5">May</option><option value="6">June</option>
          <option value="7">July</option><option value="8">August</option><option value="9">September</option>
          <option value="10">October</option><option value="11">November</option><option value="12">December</option>
        </select></div>
      <div><label for="dob-day">Day</label><input id="dob-day" inputmode="numeric" pattern="[0-9]*" maxlength="2" required autocomplete="bday-day"></div>
      <div><label for="dob-year">Year</label><input id="dob-year" inputmode="numeric" pattern="[0-9]*" maxlength="4" required autocomplete="bday-year"></div>
    </div>
    <button type="submit">Continue</button>
  </form>
</section>

<section id="step-day" aria-labelledby="h-day" hidden>
  <p id="current" class="muted"></p>
  <h2 id="h-day">Step 2 of 4: choose a day and a city</h2>
  <div id="days"></div>
</section>

<section id="step-time" aria-labelledby="h-time" hidden>
  <h2 id="h-time">Step 3 of 4: choose a time</h2>
  <div id="times"></div>
  <button type="button" class="choice" id="back-to-days">Choose a different day</button>
</section>

<section id="step-confirm" aria-labelledby="h-confirm" hidden>
  <h2 id="h-confirm">Step 4 of 4: confirm</h2>
  <p id="summary"></p>
  <p class="muted">Booking this cancels your current appointment with Azul Vision.</p>
  <button type="button" id="book">Book this appointment</button>
  <button type="button" class="choice" id="back-to-times">Choose a different time</button>
</section>

<section id="done" aria-labelledby="h-done" hidden>
  <h2 id="h-done">You're booked</h2>
  <p id="confirmation"></p>
</section>

<section id="stopped" hidden>
  <h2>We couldn't continue</h2>
  <p id="stopped-text"></p>
</section>
`;

/** The page's script. It holds the session in memory only, never in storage. */
const STEPS_SCRIPT = `
(function () {
  var base = location.pathname.replace(/\\/+$/, "");
  var session = null, days = [], chosen = null;
  function $(id) { return document.getElementById(id); }
  function show(id) {
    ["step-dob","step-day","step-time","step-confirm","done","stopped"].forEach(function (s) { $(s).hidden = s !== id; });
    var h = $(id).querySelector("h2"); if (h) { h.setAttribute("tabindex","-1"); h.focus(); }
  }
  function error(text) { var e = $("error"); e.textContent = text || ""; e.hidden = !text; }
  function stop(text) { error(""); $("stopped-text").textContent = text; show("stopped"); }
  function post(action, body) {
    return fetch(base + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ session: session }, body || {})), credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "unavailable" }; }); })
      .catch(function () { return { ok: false, error: "unavailable" }; });
  }
  var STOP = {
    expired: "This link has expired. Nothing has been changed; your current appointment stays as it is.",
    locked: "We couldn't confirm your date of birth, so this link can't be used. Nothing has been changed; your current appointment stays as it is.",
    busy: "This link can't be used right now. Please try again in a few minutes.",
    too_many: "This link has been used many times in a short while. Please try again in ten minutes.",
    appointment_changed: "Your appointment has changed since we texted you, so this link can't book. Nothing has been changed by this link.",
    not_booked: "We couldn't book that online. Your current appointment stays exactly as it is.",
    no_openings: "There are no sooner openings right now. Your current appointment stays as it is."
  };
  function choice(text, onPick) {
    var b = document.createElement("button"); b.type = "button"; b.className = "choice"; b.textContent = text;
    b.addEventListener("click", onPick); return b;
  }
  function sessionLost(r) {
    if (r.error === "session") { session = null; error("For your security, please confirm your date of birth again."); show("step-dob"); return true; }
    if (STOP[r.error] && r.error !== "not_booked") { stop(STOP[r.error]); return true; }
    return false;
  }
  $("dob-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var m = $("dob-month").value, d = $("dob-day").value.trim(), y = $("dob-year").value.trim();
    if (!m || !/^\\d{1,2}$/.test(d) || !/^\\d{4}$/.test(y)) { error("Please choose the month and enter the day and the four-digit year."); return; }
    var btn = this.querySelector("button"); btn.disabled = true;
    post("verify", { month: m, day: d, year: y }).then(function (r) {
      btn.disabled = false;
      if (r.ok) { session = r.session; error(""); $("current").textContent = r.current ? "Your current appointment: " + r.current + "." : ""; loadDays(); return; }
      if (r.error === "mismatch") { error("That date of birth doesn't match our records. Please check it and try once more."); return; }
      if (!sessionLost(r)) error("Something went wrong. Please try again.");
    });
  });
  function loadDays() {
    post("days").then(function (r) {
      if (!r.ok) { if (!sessionLost(r)) error("We couldn't load the openings. Please try again."); return; }
      days = r.days || [];
      var box = $("days"); box.textContent = "";
      if (days.length === 0) { stop(STOP.no_openings); return; }
      days.forEach(function (d) {
        d.cities.forEach(function (city) {
          box.appendChild(choice(d.label + " \\u2014 " + city, function () { loadTimes(d.day, city); }));
        });
      });
      error(""); show("step-day");
    });
  }
  function loadTimes(day, city) {
    post("times", { day: day, city: city }).then(function (r) {
      if (!r.ok) { if (!sessionLost(r)) error("We couldn't load the times. Please try again."); return; }
      var box = $("times"); box.textContent = "";
      (r.times || []).forEach(function (t) {
        box.appendChild(choice(t.time + " with " + t.provider + ", " + t.place, function () {
          chosen = t; $("summary").textContent = t.dayLabel + " at " + t.time + " with " + t.provider + ", at " + t.place + ".";
          error(""); show("step-confirm");
        }));
      });
      if (!(r.times || []).length) { error("That day just filled up. Please choose another."); show("step-day"); return; }
      error(""); show("step-time");
    });
  }
  $("back-to-days").addEventListener("click", function () { error(""); show("step-day"); });
  $("back-to-times").addEventListener("click", function () { error(""); show("step-time"); });
  $("book").addEventListener("click", function () {
    if (!chosen) return;
    var btn = this; btn.disabled = true; btn.textContent = "Booking\\u2026";
    post("book", { id: chosen.id }).then(function (r) {
      btn.disabled = false; btn.textContent = "Book this appointment";
      if (r.ok) { $("confirmation").textContent = r.confirmation; error(""); show("done"); return; }
      if (r.error === "taken") { error("Sorry, that time was just taken. Please choose another."); loadDays(); return; }
      if (r.error === "not_booked") { stop(STOP.not_booked); return; }
      if (!sessionLost(r)) error("Something went wrong. Please try again.");
    });
  });
})();
`;

export const STEPS_PAGE = shell("Book a sooner appointment", STEPS_BODY, STEPS_SCRIPT);

/** GET /book/<token>. */
export async function handleBookingPage(token: string, deps: BookingPageDeps): Promise<PageResponse> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    const link = await readLink(token, deps, now);
    if (!link.ok) {
      if (link.reason === "too_many") return html(429, TOO_MANY_PAGE);
      if (link.reason === "busy") return html(200, BUSY_PAGE);
      return html(200, EXPIRED_PAGE);
    }
    return html(200, STEPS_PAGE);
  } catch (error) {
    (deps.log ?? console.warn)(`[booking page] could not read a link — ${error instanceof Error ? error.message : String(error)}`);
    return html(200, BUSY_PAGE);
  }
}

// ── The JSON steps ──────────────────────────────────────────────────────────

const day2 = (v: unknown): number | null => {
  const s = String(v ?? "").trim();
  return /^\d{1,4}$/.test(s) ? Number(s) : null;
};

function sessionOk(record: OutreachTextRecord, session: unknown, now: Date): boolean {
  if (typeof session !== "string" || !session || !record.session_hash || !record.session_expires_at) return false;
  if (new Date(record.session_expires_at).getTime() <= now.getTime()) return false;
  return hashBookingToken(session) === record.session_hash;
}

/** POST /book/<token>/<action>. */
export async function handleBookingStep(
  token: string,
  action: string,
  body: Record<string, unknown>,
  deps: BookingPageDeps,
): Promise<PageResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    const link = await readLink(token, deps, now);
    if (!link.ok) return json(link.reason === "too_many" ? 429 : 200, { ok: false, error: link.reason });
    const store = await deps.store();
    const contact = asContact(link.contact);
    const tag = `[booking page] ${link.policy.campaignKey}`;

    if (action === "verify") {
      const onFile = dobOnFile(contact);
      const said = { month: day2(body.month), day: day2(body.day), year: day2(body.year) };
      const matches =
        !!onFile &&
        said.month === Number(onFile.month) &&
        said.day === Number(onFile.day) &&
        said.year === Number(onFile.year);
      // Two tries spent is locked for good, verified or not: otherwise a
      // verified link would let anyone go on guessing after the lock.
      if ((link.record.dob_tries ?? 0) >= LINK_DOB_TRIES) {
        log(`${tag}: date of birth locked`);
        return json(200, { ok: false, error: "locked" });
      }
      // Already verified: a matching date opens a new session for free, but
      // a wrong one still spends a try.
      if (!(link.record.verified_at && matches)) {
        const tries = await store.spendDobTry(contact.contactId, link.hash, LINK_DOB_TRIES);
        if (tries === null) {
          log(`${tag}: date of birth locked`);
          return json(200, { ok: false, error: "locked" });
        }
        if (!matches) {
          log(`${tag}: date of birth did not match (${tries} of ${LINK_DOB_TRIES})`);
          return json(200, tries >= LINK_DOB_TRIES ? { ok: false, error: "locked" } : { ok: false, error: "mismatch" });
        }
      }
      const session = randomBytes(32).toString("base64url");
      await store.patchText(contact.contactId, {
        verified_at: link.record.verified_at ?? now.toISOString(),
        session_hash: hashBookingToken(session),
        session_expires_at: new Date(now.getTime() + LINK_SESSION_MS).toISOString(),
      });
      log(`${tag}: date of birth verified`);
      return json(200, { ok: true, session, current: link.page.currentAppointment(contact) });
    }

    // Every step after the first needs the session the date of birth opened.
    if (!sessionOk(link.record, body.session, now)) return json(200, { ok: false, error: "session" });
    const demo = link.page.isDemo(contact, link.campaignKey);

    if (action === "days" || action === "times") {
      const read = await link.page.openings(contact, demo);
      if ("error" in read) return json(200, { ok: false, error: "unavailable" });
      if (action === "days") {
        const byDay = new Map<string, { day: string; label: string; cities: string[] }>();
        for (const o of read.openings) {
          const d = byDay.get(o.day) ?? { day: o.day, label: o.dayLabel, cities: [] };
          if (o.city && !d.cities.includes(o.city)) d.cities.push(o.city);
          byDay.set(o.day, d);
        }
        const days = [...byDay.values()].filter((d) => d.cities.length > 0).sort((a, b) => (a.day < b.day ? -1 : 1));
        return json(200, { ok: true, days });
      }
      const day = String(body.day ?? "");
      const city = String(body.city ?? "");
      const times = read.openings
        .filter((o) => o.day === day && o.city === city)
        .map((o) => ({ id: o.id, dayLabel: o.dayLabel, time: o.timeLabel, place: o.place, provider: o.provider }));
      return json(200, { ok: true, times });
    }

    if (action === "book") {
      const openingId = String(body.id ?? "");
      if (!openingId) return json(200, { ok: false, error: "taken" });
      if (!(await store.claimLinkBooking(contact.contactId, link.hash, now, new Date(now.getTime() - LINK_BOOKING_HOLD_MS)))) {
        return json(200, { ok: false, error: "busy" });
      }
      const release = () => store.patchText(contact.contactId, { booking_started_at: null }).catch(() => undefined);
      // The dialler's rule at the dial: a cancelled or moved appointment is
      // never the reason anything is booked, and a source that cannot answer
      // books nothing.
      let bookFor = contact;
      if (link.policy.source && link.contact.externalRef) {
        const source = await link.policy.source().catch(() => null);
        if (!source) {
          await release();
          return json(200, { ok: false, error: "busy" });
        }
        let live;
        try {
          live = await source.recheck(link.contact.externalRef, now);
        } catch {
          await release();
          return json(200, { ok: false, error: "busy" });
        }
        if (live.state !== "current") {
          await release();
          log(`${tag}: booking refused — the appointment is ${live.state === "gone" ? "over" : "off the list"}`);
          return json(200, { ok: false, error: "appointment_changed" });
        }
        if (live.contact.phone) bookFor = { ...contact, phone: live.contact.phone };
      }
      const booked = await link.page.book({
        contact: bookFor,
        demo,
        openingId,
        callRef: `text-link:${contact.contactId}`,
        deadline: Date.now() + LINK_BOOK_BUDGET_MS,
      });
      if (!booked.ok) {
        await release();
        log(`${tag}: booking not made (${booked.error})`);
        return json(200, { ok: false, error: booked.error === "slot_unavailable" ? "taken" : "not_booked" });
      }
      await store
        .patchText(contact.contactId, { booked_at: now.toISOString(), booking_id: booked.bookingId })
        .catch(() => undefined);
      log(`${tag}: booked by text link`);
      return json(200, { ok: true, confirmation: booked.confirmation });
    }

    return json(404, { ok: false, error: "unknown_step" });
  } catch (error) {
    log(`[booking page] a step failed — ${error instanceof Error ? error.message : String(error)}`);
    return json(200, { ok: false, error: "busy" });
  }
}

export { BOOKING_PATH_PREFIX };
