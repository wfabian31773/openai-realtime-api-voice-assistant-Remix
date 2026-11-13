/**
 * The production store's SQL, pinned from the source.
 *
 * Every behavioural test drives FakeOutboundStore, so a predicate dropped
 * from the real SQL would leave the suite green while the database did the
 * wrong thing — failure mode 10, testing the sink instead of the source. The
 * statements themselves were PREPAREd against the live Hub on 2026-10-20
 * (all sixteen that touch existing tables parsed, nothing executed); these
 * pins keep the predicates that make them safe from being edited away.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURNAME_INITIAL_FOLD, dncKey, rowToContact } from "./store";
import { nameKey } from "../../tools/verifiedIdentity";

const SRC = readFileSync("src/runtime/outbound/store.ts", "utf8");

/** The body of one store method, from its name to the next method. */
function method(name: string): string {
  const start = SRC.indexOf(`async ${name}(`);
  expect(start, `${name} not found in store.ts`).toBeGreaterThan(0);
  const next = SRC.indexOf("\n    async ", start + 1);
  return SRC.slice(start, next > 0 ? next : undefined);
}

describe("the claim is the only door to a dial", () => {
  it("re-checks the dialable statuses and the due time inside the UPDATE", () => {
    const claim = method("claimContact");
    expect(claim).toContain("SET outreach_status = 'calling'");
    expect(claim).toContain("outreach_status::text IN ('pending', 'no_answer', 'voicemail', 'callback_scheduled')");
    expect(claim).toContain("next_attempt_at IS NULL OR next_attempt_at <=");
    expect(claim).toContain("RETURNING *");
  });

  it("hands a row back only while this process still holds it", () => {
    expect(method("releaseContact")).toContain("AND outreach_status = 'calling'");
  });

  it("lets a settle that must not overwrite an outcome say so", () => {
    expect(method("settleContact")).toContain("::boolean OR outreach_status = 'calling')");
  });

  it("lets a callback settle only the call it belongs to: the contact's newest attempt", () => {
    const settle = method("settleContact");
    expect(settle).toContain("${opts.onlyIfCurrentAttempt ?? null}::varchar IS NULL");
    expect(settle).toContain("WHERE x.contact_id = campaign_contacts.id AND x.direction = 'outbound'");
    expect(settle).toContain("ORDER BY x.attempted_at DESC, x.id DESC");
    expect(settle).toContain("LIMIT 1))");
  });

  it("reaps only rows stuck in 'calling' since before the cut-off", () => {
    const reap = method("reapStaleClaims");
    expect(reap).toContain("outreach_status = 'calling'");
    expect(reap).toContain("updated_at <");
    expect(reap).toContain("next_attempt_at = ${utc(nextAttemptAt)}");
  });
});

describe("the attempt row keeps the answer webhook's verdict", () => {
  it("never lets a later 'completed' overwrite a voicemail, fax or not-ready", () => {
    expect(method("finishAttempt")).toContain(
      "CASE WHEN status IN ('voicemail', 'fax', 'not_ready') THEN status",
    );
  });

  it("ends an attempt only when told the call is over", () => {
    expect(method("finishAttempt")).toContain(
      "ended_at = CASE WHEN ${f.ended ?? true}::boolean THEN COALESCE(ended_at, NOW()) ELSE ended_at END",
    );
  });

  it("counts the live attempt for concurrency, not the contact's status", () => {
    const inFlight = method("callsInFlight");
    expect(inFlight).toContain("FROM campaign_contact_attempts");
    expect(inFlight).toContain("ended_at IS NULL");
    expect(inFlight).not.toContain("outreach_status");
  });

  it("counts only outbound attempts against the caps", () => {
    expect(method("priorAttempts")).toContain("a.direction = 'outbound'");
  });

  it("counts the caps over the PHONE across the campaign, not over one row", () => {
    const prior = method("priorAttempts");
    expect(prior).toContain("ON c.campaign_id = me.campaign_id");
    expect(prior).toContain("right(regexp_replace(c.phone_number, '[^0-9]', '', 'g'), 10)");
    expect(prior).toContain("= right(regexp_replace(me.phone_number, '[^0-9]', '', 'g'), 10)");
    expect(prior).toContain("JOIN campaign_contact_attempts a ON a.contact_id = c.id");
    expect(prior).toContain("WHERE me.id = ${contactId}::varchar");
    // Not filtered to the one row: the attempts come from every sibling.
    expect(prior).not.toMatch(/a\.contact_id = \$\{contactId\}/);
  });

  it("names each attempt's own row, so the place-by gate can ask whether THIS row was dialled (v115)", () => {
    const prior = method("priorAttempts");
    expect(prior).toContain("AS attempted_at, a.contact_id");
    expect(prior).toContain("contactId: String(r.contact_id)");
  });

  it("spends no cap on a dial Twilio refused (Codex round 4, #357)", () => {
    expect(method("priorAttempts")).toContain("AND a.status IS DISTINCT FROM ${NOT_PLACED}::varchar");
  });

  it("counts trailing not_placed attempts on this contact for the infra-retry cap", () => {
    const streak = method("consecutiveRefusedAttempts");
    expect(streak).toContain("a.contact_id = ${contactId}::varchar");
    expect(streak).toContain("a.direction = 'outbound'");
    expect(streak).toContain("a.status = ${NOT_PLACED}::varchar");
    expect(streak).toContain("newer.status IS DISTINCT FROM ${NOT_PLACED}::varchar");
    expect(streak).toContain("a.attempted_at >= ${utc(since)}");
    expect(streak).toContain("newer.attempted_at >= ${utc(since)}");
    expect(streak).not.toContain("campaign_id");
  });

  it("does not count the contact as attempted until Twilio accepts (Codex round 5, #357)", () => {
    const start = method("startAttempt");
    expect(start).toContain("INSERT INTO campaign_contact_attempts");
    expect(start).not.toContain("contacted");
    expect(start).not.toContain("attempts =");
    const marked = method("markContactDialled");
    expect(marked).toContain("attempts = COALESCE(attempts, 0) + 1");
    expect(marked).toContain("contacted = true");
    expect(marked).toContain("last_attempt_at = NOW()");
  });

  it("looks for a call still on the line across EVERY campaign, bounded by the stale window (Codex round 4, #357)", () => {
    const open = method("callOpenOnPhone");
    // The phone, matched exactly as the caps match it…
    expect(open).toContain("ON right(regexp_replace(c.phone_number, '[^0-9]', '', 'g'), 10)");
    expect(open).toContain("= right(regexp_replace(me.phone_number, '[^0-9]', '', 'g'), 10)");
    // …with no campaign restriction at all.
    expect(open).not.toContain("campaign_id");
    // A dial we placed, or the person calling us back (v106): either is a
    // call on that phone, and the dialler must not ring into it.
    expect(open).toContain("a.direction IN ('outbound', 'inbound')");
    expect(open).toContain("AND a.ended_at IS NULL");
    expect(open).toContain("AND a.attempted_at >= ${utc(since)}");
  });
});

describe("the do-not-contact list", () => {
  it("refuses a number it cannot read rather than dialling it", () => {
    const check = method("isDoNotContact");
    expect(check).toMatch(/if \(!key\) return true;/);
  });

  it("the call check reads any do_not_contact row, so an SMS STOP blocks calls", () => {
    const check = method("isDoNotContact");
    expect(check).not.toContain("source <> 'sms_stop'");
    expect(check).not.toMatch(/AND source/);
    expect(check).toContain("WHERE phone_key = ${key}::varchar");
  });

  it("writes one row per channel, on the unique index the Hub carries since 2026-10-22", () => {
    const stamp = method("stampDoNotContact");
    // The conflict target must be a unique index the live table has; one it
    // lacks is a 42P10 on every opt-out. The Hub's is (phone_key, source).
    expect(stamp).toContain("ON CONFLICT (phone_key, source) DO NOTHING");
    expect(stamp).not.toMatch(/ON CONFLICT \(phone_key\)/);
  });

  it("only ever creates do_not_contact and its index, and never alters the table (v115)", () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS do_not_contact \(\s*phone_key VARCHAR\(10\) NOT NULL,/);
    expect(SRC).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS do_not_contact_phone_source_uidx\s+ON do_not_contact \(phone_key, source\)/);
    expect(SRC).not.toMatch(/ALTER TABLE do_not_contact/);
    expect(SRC).not.toMatch(/DROP CONSTRAINT[^;`]*do_not_contact_pkey/);
  });

  it("keys every spelling of a US number on its ten digits", () => {
    expect(dncKey("+1 (714) 555-0100")).toBe("7145550100");
    expect(dncKey("714.555.0100")).toBe("7145550100");
    expect(dncKey("17145550100")).toBe("7145550100");
    expect(dncKey("anonymous")).toBeNull();
    expect(dncKey("555-0100")).toBeNull();
    expect(dncKey("+447911123456")).toBeNull();
  });
});

describe("the timestamps", () => {
  it("binds every instant as ISO and converts in SQL, never as a process-zone Date", () => {
    expect(SRC).toContain("::timestamptz AT TIME ZONE 'UTC')");
    // Every comparison against a campaign timestamp goes through utc().
    for (const m of ["dialableContacts", "claimContact", "callsInFlight", "reapStaleClaims", "consecutiveRefusedAttempts"]) {
      expect(method(m), m).toContain("${utc(");
    }
  });
});

describe("a row read back", () => {
  it("defaults what the table leaves null", () => {
    expect(
      rowToContact({ id: "c1", campaign_id: "k1", phone_number: "+15555550111", custom_data: null }),
    ).toEqual({
      id: "c1",
      campaignId: "k1",
      phone: "+15555550111",
      firstName: null,
      lastName: null,
      status: "pending",
      attempts: 0,
      contacted: false,
      nextAttemptAt: null,
      customData: {},
      // An imported row has no source id (v107).
      externalRef: null,
    });
  });
});

describe("a returned call (v106, ./callback.ts)", () => {
  it("finds the caller on this campaign's list by their ten digits, and never creates the campaign", () => {
    const found = method("callbackCandidates");
    expect(found).toContain("WHERE c.campaign_id = ${campaignId}::varchar");
    expect(found).toContain("right(regexp_replace(c.phone_number, '[^0-9]', '', 'g'), 10) = ${key}::varchar");
    expect(found).not.toContain("INSERT");
    // An unreadable number finds nobody rather than everybody.
    expect(found).toContain("if (!campaignId || !key) return { campaignId, candidates: [] };");
  });

  it("describes the last call by the newest dial that reached the network", () => {
    expect(SRC).toMatch(/LEFT JOIN LATERAL \(\s+SELECT \(a\.attempted_at AT TIME ZONE 'UTC'\) AS last_attempt_at/);
    const lateral = SRC.slice(SRC.indexOf("const lastPlacedDial"), SRC.indexOf("const campaignIdFor"));
    expect(lateral).toContain("a.direction = 'outbound'");
    expect(lateral).toContain("a.status IS DISTINCT FROM ${NOT_PLACED}::varchar");
    expect(lateral).toContain("ORDER BY a.attempted_at DESC, a.id DESC");
  });

  it("finds a caller ringing from another phone only within this campaign, matched exactly in code", () => {
    const byName = method("contactsByName");
    expect(byName).toContain("WHERE c.campaign_id = ${campaignId}::varchar");
    expect(byName).toContain("LIMIT 500");
    expect(byName).toContain("nameKey(c.firstName ?? undefined) === first && nameKey(c.lastName ?? undefined) === last");
  });

  it("writes the returned call as an INBOUND attempt that is not one of the person's dials", () => {
    const opened = method("openCallbackAttempt");
    expect(opened).toContain("'inbound', 'answered'");
    expect(opened).toContain("${CALLBACK_ATTEMPT_NUMBER}::int");
  });

  it("lets a settle skip a status it must never overwrite, and require one it may", () => {
    const settle = method("settleContact");
    expect(settle).toContain("NOT (outreach_status::text = ANY (string_to_array(${csv(opts.exceptStatus)}::text, ',')))");
    expect(settle).toContain("outreach_status::text = ANY (string_to_array(${csv(opts.onlyIfStatusIn)}::text, ','))");
  });
});

describe("a queue fed live from a source (v107)", () => {
  it("adds or refreshes by external_ref in one fixed statement, and never touches the status of a row it already has", () => {
    const up = method("upsertSourceContacts");
    expect(up).toContain("FROM jsonb_to_recordset(${payload}::jsonb)");
    expect(up).toContain("ON CONFLICT (campaign_id, external_ref) WHERE external_ref IS NOT NULL");
    const onConflict = up.slice(up.indexOf("DO UPDATE SET"), up.indexOf("RETURNING"));
    expect(onConflict).not.toContain("outreach_status");
    expect(onConflict).not.toContain("next_attempt_at");
  });

  it("parks only dialable rows, and never brings a later look forward", () => {
    const park = method("parkContacts");
    expect(park).toContain("GREATEST(COALESCE(next_attempt_at, ${utc(until)}), ${utc(until)})");
    expect(park).toContain("outreach_status::text IN ('pending', 'no_answer', 'voicemail', 'callback_scheduled')");
    expect(park).toContain("jsonb_array_elements_text(${JSON.stringify(externalRefs)}::jsonb)");
  });

  it("diffs against this campaign's source-fed rows only", () => {
    expect(method("sourceRows")).toContain("WHERE campaign_id = ${campaignId}::varchar AND external_ref IS NOT NULL");
  });
});

describe("the outreach text and its booking page (v211)", () => {
  it("a source refresh carries the text's state over instead of overwriting it", () => {
    const up = method("upsertSourceContacts");
    expect(up).toContain("WHEN campaign_contacts.custom_data -> ${OUTREACH_TEXT_KEY}::text IS NOT NULL");
    expect(up).toContain("|| jsonb_build_object(${OUTREACH_TEXT_KEY}::text,");
    expect(up).toContain("campaign_contacts.custom_data -> ${OUTREACH_TEXT_KEY}::text)");
    expect(up).toContain("ELSE EXCLUDED.custom_data");
  });

  it("claims a row's text in one statement, only while it is textable and none is held or a retry is due", () => {
    for (const name of ["claimText", "textableContacts"]) {
      const m = method(name);
      expect(m).toContain("AND outreach_status::text = ANY (string_to_array(${TEXTABLE_STATUSES.join(\",\")}::text, ','))");
      expect(m).toContain("AND COALESCE(custom_data->>'plugin_live', 'false') <> 'true'");
      // Every predicate is ANDed: an OR at the top level would let any row in.
      expect(m.replace(/\(custom_data -> \$\{OUTREACH_TEXT_KEY\}::text IS NULL[\s\S]*?::timestamptz\)\)/, "")).not.toMatch(/\bOR\b/);
      expect(m).toContain("custom_data -> ${OUTREACH_TEXT_KEY}::text IS NULL");
      expect(m).toContain("->> 'state' = 'retry'");
      expect(m).toContain("<= ${now.toISOString()}::timestamptz");
    }
    expect(method("claimText")).toContain("RETURNING *");
  });

  it("never moves updated_at, which the stale-claim reaper reads as a call's claim", () => {
    for (const name of ["claimText", "patchText", "spendDobTry", "claimLinkBooking"]) {
      expect(method(name)).not.toMatch(/updated_at\s*=/);
    }
  });

  it("merges a patch into the held record and nothing else", () => {
    const m = method("patchText");
    expect(m).toContain("(custom_data -> ${OUTREACH_TEXT_KEY}::text) || ${JSON.stringify(patch)}::jsonb");
    expect(m).toContain("jsonb_typeof(custom_data -> ${OUTREACH_TEXT_KEY}::text) = 'object'");
  });

  it("finds a link by its hash, among runtime campaigns, and refuses anything but one row", () => {
    const m = method("contactByTextToken");
    expect(m).toContain("->> 'token_hash' = ${tokenHash}::text");
    expect(m).toContain("k.campaign_type = ${RUNTIME_OUTBOUND_CAMPAIGN_TYPE}::varchar");
    expect(m).toContain("LIMIT 2");
    expect(m).toContain("if (found.length !== 1) return null;");
  });

  it("spends a date-of-birth try only while one is left, and only on the link's own row", () => {
    const m = method("spendDobTry");
    expect(m).toContain("->> 'token_hash' = ${tokenHash}::text");
    expect(m).toContain("->> 'dob_tries')::int, 0) < ${limit}::int");
    expect(m).toContain("RETURNING");
  });

  it("holds a booking one at a time, never on a link that has booked", () => {
    const m = method("claimLinkBooking");
    expect(m).toContain("->> 'booked_at' IS NULL");
    expect(m).toContain("->> 'booking_started_at' IS NULL");
    expect(m).toContain("< ${staleBefore.toISOString()}::timestamptz");
  });

  it("START deletes only the sms_stop row", () => {
    expect(method("clearSmsStop")).toContain(
      "DELETE FROM do_not_contact WHERE phone_key = ${key}::varchar AND source = ${SMS_DNC_SOURCE}::varchar",
    );
  });
});

describe("a caller ringing from another phone, whose surname begins with an accent (Codex P2, #358)", () => {
  it("is prefiltered on the surname initial FOLDED in SQL, the way the code folds it", () => {
    expect(method("contactsByName")).toContain(
      "translate(lower(left(trim(c.last_name), 1)),\n                           ${SURNAME_INITIAL_FOLD.from}::text, ${SURNAME_INITIAL_FOLD.to}::text) = ${initial}::varchar",
    );
  });

  it("folds every listed letter exactly as nameKey does, and nothing nameKey leaves alone", () => {
    const from = [...SURNAME_INITIAL_FOLD.from];
    const to = [...SURNAME_INITIAL_FOLD.to];
    expect(from).toHaveLength(to.length);
    from.forEach((ch, i) => expect(nameKey(ch), ch).toBe(to[i]));
    for (const ch of ["ø", "đ", "ł"]) expect(nameKey(ch)).toBe(ch);
    // The worked case: Álvarez's initial, lower-cased as SQL does, folds to nameKey's.
    const sqlInitial = "Álvarez".charAt(0).toLowerCase();
    expect(to[from.indexOf(sqlInitial)]).toBe(nameKey("Álvarez").charAt(0));
  });
});

describe("the booking confirmation (v222)", () => {
  it("queues a booking's confirmation once: never over the same booking's", () => {
    const m = method("queueConfirmation");
    expect(m).toContain("->> 'booking_id'");
    expect(m).toContain("IS DISTINCT FROM ${record.booking_id}::text");
    expect(m).toContain("-> ${CONFIRMATION_FIELD}::text IS NULL");
    // An outreach_text that is not an object is replaced, never concatenated.
    expect(m).toContain("jsonb_typeof(custom_data -> ${OUTREACH_TEXT_KEY}::text) = 'object'");
    expect(m).toContain("RETURNING id");
  });

  it("claims and lists only a due confirmation, or a retry whose time has come", () => {
    for (const name of ["claimConfirmation", "confirmationsDue"]) {
      const m = method(name);
      // v224: awaiting_cancel goes at its due_at too, if the hang-up never released it.
      expect(m).toContain("->> 'state' IN ('due', 'retry', 'awaiting_cancel')");
      expect(m).toContain("->> 'retry_after',");
      expect(m).toContain("->> 'due_at')::timestamptz");
      expect(m).toContain("<= ${now.toISOString()}::timestamptz");
    }
    expect(method("confirmationsDue")).toContain("campaign_id = ${campaignId}::varchar");
    expect(method("claimConfirmation")).toContain("jsonb_build_object('state', 'claimed'");
    expect(method("claimConfirmation")).toContain("RETURNING *");
  });

  it("holds only this booking's confirmation, and only before it is claimed", () => {
    const m = method("holdConfirmation");
    expect(m).toContain("->> 'booking_id' = ${bookingId}::text");
    expect(m).toContain("->> 'state' IN ('due', 'retry', 'awaiting_cancel')");
  });

  it("never moves updated_at, which the stale-claim reaper reads as a call's claim", () => {
    for (const name of [
      "queueConfirmation", "claimConfirmation", "patchConfirmation", "holdConfirmation",
      "releaseConfirmation", "skipConfirmation",
      "queueHeldCancel", "claimHeldCancel", "patchHeldCancel", "dropHeldCancel",
    ]) {
      expect(method(name)).not.toMatch(/updated_at\s*=/);
    }
  });

  it("releases this booking's confirmation with the real cancel, never one already claimed or sent (v224)", () => {
    const m = method("releaseConfirmation");
    expect(m).toContain("->> 'booking_id' = ${bookingId}::text");
    expect(m).toContain("->> 'state' NOT IN ('claimed', 'sent', 'unknown')");
    expect(m).toContain("jsonb_build_object('cancel', ${cancel}::text)");
    // Only one waiting for its cancel is made due now.
    expect(m).toContain("->> 'state' = 'awaiting_cancel'");
    expect(m).toContain("jsonb_build_object('state', 'due', 'due_at', ${now.toISOString()}::text)");
    expect(m).toContain("RETURNING id");
  });

  it("skips an undone booking's confirmation only before it is claimed (v224)", () => {
    const m = method("skipConfirmation");
    expect(m).toContain("->> 'booking_id' = ${bookingId}::text");
    expect(m).toContain("->> 'state' IN ('due', 'retry', 'awaiting_cancel', 'held')");
    expect(m).toContain("jsonb_build_object('state', 'skipped', 'reason', ${reason}::text)");
  });
});

describe("the held Azul cancel (v224)", () => {
  it("is written only where no cancel is still held or running", () => {
    const m = method("queueHeldCancel");
    expect(m).toContain("-> ${HELD_CANCEL_FIELD}::text IS NULL");
    expect(m).toContain("IS DISTINCT FROM ${record.booking_id}::text");
    expect(m).toContain("NOT IN ('held', 'claimed')");
    expect(m).toContain("jsonb_typeof(custom_data -> ${OUTREACH_TEXT_KEY}::text) = 'object'");
    expect(m).toContain("RETURNING id");
  });

  it("the fallback lists a held cancel past its run_after, or a claim gone stale, on this campaign", () => {
    const m = method("heldCancelsDue");
    expect(m).toContain("campaign_id = ${campaignId}::varchar");
    expect(m).toContain("->> 'state' = 'held'");
    expect(m).toContain("->> 'run_after')::timestamptz");
    expect(m).toContain("<= ${now.toISOString()}::timestamptz");
    expect(m).toContain("->> 'state' = 'claimed'");
    expect(m).toContain("<= ${staleBefore.toISOString()}::timestamptz");
    expect(m).toContain("LIMIT ${limit}::int");
  });

  it("is claimed in one statement: this booking's, held or stale", () => {
    const m = method("claimHeldCancel");
    expect(m).toContain("->> 'booking_id' = ${bookingId}::text");
    expect(m).toContain("->> 'state' = 'held'");
    expect(m).toContain("->> 'claimed_at')::timestamptz");
    expect(m).toContain("<= ${staleBefore.toISOString()}::timestamptz");
    expect(m).toContain("jsonb_build_object('state', 'claimed', 'claimed_at', ${now.toISOString()}::text)");
    expect(m).toContain("RETURNING *");
  });

  it("is patched only for its own booking", () => {
    expect(method("patchHeldCancel")).toContain("->> 'booking_id' = ${bookingId}::text");
  });

  it("is dropped only while held, or written dropped where it never landed, and never over a cancel running", () => {
    const m = method("dropHeldCancel");
    expect(m).toContain("-> ${HELD_CANCEL_FIELD}::text IS NULL");
    expect(m).toContain("->> 'booking_id' = ${record.booking_id}::text");
    expect(m).toContain("->> 'state' = 'held'");
    expect(m).toContain("NOT IN ('held', 'claimed')");
    expect(m).toContain("jsonb_build_object('state', 'dropped', 'reason', ${reason}::text, 'done_at', ${now.toISOString()}::text)");
    expect(m).toContain("RETURNING id");
  });
});
