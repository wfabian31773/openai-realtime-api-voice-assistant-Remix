/**
 * THE STAND-IN NAME is one the ticketing app accepts, and "Unknown Caller" is
 * not. The app's rule lives in another repository, so it is held here as a
 * pinned copy (APP_PLACEHOLDER_NAME_WORDS); this file proves the stand-in and
 * the mirror against that copy.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_PLACEHOLDER_NAME_WORDS,
  appWouldRefuseName,
  nameOrStandIn,
  STAND_IN_FIRST_NAME,
  STAND_IN_FULL_NAME,
  STAND_IN_LAST_NAME,
  STAND_IN_NAME_NOTE,
} from "./standInName";

describe("the app's placeholder rule, mirrored", () => {
  it("REFUSES the old fallback — this is the defect, 22 connected transfers with no record", () => {
    expect(appWouldRefuseName("Unknown Caller")).toBe(true);
  });

  it("refuses blank, a lone placeholder, a doubled one and an all-placeholder pair", () => {
    for (const n of ["", "   ", "Unknown", "N/A", "unknown unknown", "Test Caller", "Anonymous  Patient"]) {
      expect(appWouldRefuseName(n), n).toBe(true);
    }
  });

  it("accepts a real name, a single real word, and a name with one placeholder word beside a real one", () => {
    for (const n of ["Dana Example", "Dana", "Dana Caller", "Unnamed Caller"]) {
      expect(appWouldRefuseName(n), n).toBe(false);
    }
  });

  it("the stand-in is NOT on the pinned list — if the app adds `unnamed`, this goes red first", () => {
    expect(APP_PLACEHOLDER_NAME_WORDS).not.toContain(STAND_IN_FIRST_NAME.toLowerCase());
    expect(appWouldRefuseName(STAND_IN_FULL_NAME)).toBe(false);
  });

  it("the pinned copy is the app's list as read on 2026-10-09", () => {
    expect([...APP_PLACEHOLDER_NAME_WORDS]).toEqual([
      "unknown", "anonymous", "n/a", "na", "none", "test", "patient",
      "caller", "customer", "user", "guest", "no name", "noname",
    ]);
  });
});

describe("nameOrStandIn", () => {
  it("keeps what the caller gave", () => {
    expect(nameOrStandIn("Dana", "Example")).toEqual({ fullName: "Dana Example", standIn: false });
    expect(nameOrStandIn("Dana", undefined)).toEqual({ fullName: "Dana", standIn: false });
  });

  it("stands in for nothing, and for a placeholder the model wrote", () => {
    expect(nameOrStandIn(undefined, undefined)).toEqual({ fullName: "Unnamed Caller", standIn: true });
    expect(nameOrStandIn("", "  ")).toEqual({ fullName: "Unnamed Caller", standIn: true });
    expect(nameOrStandIn("Unknown", undefined)).toEqual({ fullName: "Unnamed Caller", standIn: true });
    expect(nameOrStandIn("unknown", "caller")).toEqual({ fullName: "Unnamed Caller", standIn: true });
  });

  it("the note names the stand-in and sends the staffer to the recording and caller ID", () => {
    expect(STAND_IN_NAME_NOTE).toContain(STAND_IN_FULL_NAME);
    expect(STAND_IN_NAME_NOTE).toMatch(/stand-in/);
    expect(STAND_IN_NAME_NOTE).toMatch(/recording/);
    expect(STAND_IN_NAME_NOTE).toMatch(/caller ID/);
  });
});

describe("one stand-in across the fleet", () => {
  it("the setup-failure floor sends the same name", () => {
    const src = readFileSync(join(__dirname, "../runtime/setupFailureFloor.ts"), "utf8");
    expect(src).toMatch(/STAND_IN_FIRST\s*=\s*STAND_IN_FIRST_NAME/);
    expect(src).toMatch(/STAND_IN_LAST\s*=\s*STAND_IN_LAST_NAME/);
    expect(`${STAND_IN_FIRST_NAME} ${STAND_IN_LAST_NAME}`).toBe("Unnamed Caller");
  });

  it("the after-hours agent no longer files under the refused fallback", () => {
    const src = readFileSync(join(__dirname, "../agents/noIvrAgent.ts"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    expect(src).not.toMatch(/'Unknown Caller'/);
  });
});
