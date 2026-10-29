/**
 * A NODE 20 PROBE, NOT A TEST. Run by `perCallStoresHaveOneImportStyle.test.ts`
 * when NODE20_BIN names a Node 20 binary; vitest never collects this file.
 *
 * It does what production does: the bridge's own import style writes the
 * caller's words into the two per-call stores (a static import, as
 * `mediaStreamBridge.ts` has it), and then the REAL tools read them through
 * whatever import style they use. It prints one JSON line saying whether each
 * tool saw what was written. Synthetic words only.
 */
import { noteSpokenDob } from "../../tools/spokenDob";
import { notePatientStatus } from "../../tools/spokenPatientStatus";
import { runTool } from "../../tools/registry";
import "../../tools/sharedPatientTools";
import "../../tools/techTools";

const DOB_SID = "CA" + "0".repeat(29) + "d0b";
const NEW_SID = "CA" + "0".repeat(29) + "ae1";

async function main(): Promise<void> {
  // The ticketing client the tool reaches through its own import, so the
  // filing never leaves this process.
  const { ticketingApiClient } = await import("../../../server/services/ticketingApiClient");
  const api = ticketingApiClient as unknown as Record<string, unknown>;
  api.createTicket = async () => ({ success: true, ticketNumber: "VA-PROBE" });
  api.lookupProviderAndLocation = async () => ({ success: true });

  noteSpokenDob(DOB_SID, [
    "AGENT: And may I please have your date of birth, starting with the month, then the day, then the year?",
    "CALLER: March 4th, 1970.",
  ]);
  const filed = (await runTool("file_tech_ticket", {
    first_name: "Pat",
    last_name: "Example",
    callback_number: "760-555-0100",
    call_sid: DOB_SID,
    request_description: "I need my eye drops refilled",
  })) as Record<string, unknown>;
  const missing = (filed.missingFields ?? (filed.outcome as Record<string, unknown> | undefined)?.missingFields) as
    | string[]
    | undefined;

  notePatientStatus(NEW_SID, ["AGENT: Are you a new patient or an existing patient?", "CALLER: New."]);
  const looked = (await Promise.race([
    runTool("lookup_patient", { call_sid: NEW_SID, lane: "optical", phone: "+17605550100" }),
    new Promise((r) => setTimeout(() => r({ timedOut: true }), 4000)),
  ])) as Record<string, unknown>;

  console.log(
    JSON.stringify({
      node: process.version,
      spokenDobReachedTheFilingTool: !(missing ?? []).includes("date_of_birth"),
      newAnswerReachedTheLookup: looked.suppressed === "caller_said_new",
    }),
  );
  process.exit(0);
}

void main();
