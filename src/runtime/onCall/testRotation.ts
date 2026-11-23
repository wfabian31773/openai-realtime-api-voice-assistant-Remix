/**
 * A synthetic rotation for tests: seven regions, five directors, a FINAL
 * director who is also San Diego's and Coachella Valley's, and two weeks.
 * Every phone is a 555 number and every name is made up.
 */
import { regionKey, type OnCallProvider, type RotationData } from "./rotation";

export function provider(id: number, region: string, over: Partial<OnCallProvider> = {}): OnCallProvider {
  return {
    id,
    fullName: `Provider ${id}`,
    npi: `10000000${String(id).padStart(2, "0")}`,
    phone: `+1555555${String(1000 + id).slice(-4)}`,
    email: null,
    region,
    rotationOrder: id,
    active: true,
    ...over,
  };
}

export const IE_DIRECTOR = 91;
export const LA_DIRECTOR = 92;
export const OC_DIRECTOR = 93;
export const VALLEYS_DIRECTOR = 94;
export const FINAL_DIRECTOR = 95;

export function syntheticRotation(over: Partial<RotationData> = {}): RotationData {
  const providers: OnCallProvider[] = [
    provider(1, "Inland Empire"),
    provider(2, "Los Angeles"),
    provider(3, "San Diego"),
    provider(4, "Coachella Valley"),
    provider(5, "Orange County"),
    provider(6, "San Gabriel Valley"),
    provider(IE_DIRECTOR, "Inland Empire", { rotationOrder: null }),
    provider(LA_DIRECTOR, "Los Angeles", { rotationOrder: null }),
    provider(OC_DIRECTOR, "Orange County", { rotationOrder: null }),
    provider(VALLEYS_DIRECTOR, "San Fernando Valley", { rotationOrder: null }),
    provider(FINAL_DIRECTOR, "San Diego", { rotationOrder: null }),
  ];
  const directors = new Map<string, number>([
    [regionKey("Inland Empire"), IE_DIRECTOR],
    [regionKey("Los Angeles"), LA_DIRECTOR],
    [regionKey("Orange County"), OC_DIRECTOR],
    [regionKey("San Fernando Valley"), VALLEYS_DIRECTOR],
    [regionKey("San Gabriel Valley"), VALLEYS_DIRECTOR],
    [regionKey("San Diego"), FINAL_DIRECTOR],
    [regionKey("Coachella Valley"), FINAL_DIRECTOR],
    [regionKey("FINAL"), FINAL_DIRECTOR],
  ]);
  const schedule = new Map<string, number>([
    ["2026-11-24", 6],
    ["2026-12-01", 1],
    ["2026-12-08", 2],
    ["2026-12-15", 5],
    ["2026-12-22", 3],
    ["2026-12-29", 4],
    ["2027-01-12", 1],
    ["2027-03-09", 2],
    ["2027-03-16", 5],
    ["2027-10-05", 6],
  ]);
  return { providers, schedule, overrides: [], directors, ...over };
}
