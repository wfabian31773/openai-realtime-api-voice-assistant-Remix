import { describe, it, expect } from "vitest";
import { buildKnowledgePack, KNOWLEDGE_PACK_VERSION } from "./knowledgePack";
import { AZUL_VISION_LOCATIONS } from "../config/azulVisionKnowledge";

describe("the knowledge pack every agent knows by heart", () => {
  it("is BYTE-IDENTICAL between calls — a prefix that varies is a prefix that is never cached", () => {
    expect(buildKnowledgePack()).toBe(buildKnowledgePack());
  });

  it("contains nothing volatile: no date, no time, no caller, no lane", () => {
    const pack = buildKnowledgePack();
    // A timestamp anywhere in the prefix would miss the cache on every
    // single call, which is the failure this test exists to catch.
    expect(pack).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
    expect(pack).not.toMatch(/\b\d{1,2}:\d{2}\s?(am|pm)\b/i);
    expect(pack).not.toMatch(/today|current date|right now/i);
  });

  it("carries every office with its address, phone, FAX and hours", () => {
    const pack = buildKnowledgePack();
    for (const loc of AZUL_VISION_LOCATIONS) {
      expect(pack).toContain(loc.address);
      expect(pack).toContain(loc.phone);
      // Fax numbers were named explicitly: an office asking where to send
      // a referral is a routine call, and the shared compact reference
      // drops them.
      expect(pack).toContain(loc.fax);
    }
    expect(pack).toContain(AZUL_VISION_LOCATIONS[0].hours);
  });

  it("tells the agent whose organization it works inside", () => {
    const pack = buildKnowledgePack();
    expect(pack).toContain("Azul Vision");
    expect(pack).toMatch(/eye-care organization/i);
    expect(pack).toMatch(/never a person/i);
  });

  it("names providers and services, so the agent is not guessing at either", () => {
    const pack = buildKnowledgePack();
    expect(pack).toMatch(/OPHTHALMOLOGISTS/);
    expect(pack).toMatch(/OPTOMETRISTS/);
    expect(pack).toMatch(/cataract/i);
    expect(pack).toMatch(/LASIK/);
  });

  it("ends with the accuracy floor — the model must not reconstruct a fact it was not given", () => {
    const pack = buildKnowledgePack();
    expect(pack).toMatch(/do not reconstruct an address/i);
    expect(pack.replace(/\s+/g, " ")).toMatch(
      /saying you do not know is the correct answer/i,
    );
  });

  it("contains no patient data of any kind — it is spoken to whoever dials", () => {
    const pack = buildKnowledgePack();
    expect(pack).not.toMatch(/date of birth|DOB|patient_id|MRN/i);
    expect(pack).not.toMatch(/\b\d{2}\/\d{2}\/\d{4}\b/);
  });

  it("declares a version, so a cache-rate change can be attributed rather than guessed", () => {
    expect(KNOWLEDGE_PACK_VERSION).toMatch(/^v\d+$/);
  });
});
