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
import { dncKey, rowToContact } from "./store";

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

  it("spends no cap on a dial Twilio refused (Codex round 4, #357)", () => {
    expect(method("priorAttempts")).toContain("AND a.status IS DISTINCT FROM ${NOT_PLACED}::varchar");
  });

  it("counts trailing not_placed attempts on this contact for the infra-retry cap", () => {
    const streak = method("consecutiveRefusedAttempts");
    expect(streak).toContain("a.contact_id = ${contactId}::varchar");
    expect(streak).toContain("a.direction = 'outbound'");
    expect(streak).toContain("a.status = ${NOT_PLACED}::varchar");
    expect(streak).toContain("newer.status IS DISTINCT FROM ${NOT_PLACED}::varchar");
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
    expect(open).toContain("a.direction = 'outbound'");
    expect(open).toContain("AND a.ended_at IS NULL");
    expect(open).toContain("AND a.attempted_at >= ${utc(since)}");
  });
});

describe("the do-not-contact list", () => {
  it("refuses a number it cannot read rather than dialling it", () => {
    const check = method("isDoNotContact");
    expect(check).toMatch(/if \(!key\) return true;/);
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
    for (const m of ["dialableContacts", "claimContact", "callsInFlight", "reapStaleClaims"]) {
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
    });
  });
});
