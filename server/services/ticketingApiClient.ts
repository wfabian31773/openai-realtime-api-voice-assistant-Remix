import { getEnvironmentConfig } from '../../src/config/environment';
import { shadowTap } from '../../src/shadow/tap'; // observation-only tap; no-op unless SHADOW_MODE_ENABLED
import { isNoTicketError } from './ticketingSyncPolicy';
import type { PcpTicketPayload, PcpTicketResponse } from '../../src/pcp/pcpTicketing';

export interface CallData {
  callSid?: string;
  recordingUrl?: string;
  transcript?: string;
  callerPhone?: string;
  dialedNumber?: string;
  agentUsed?: string;
  callStartTime?: string;
  callEndTime?: string;
  callDurationSeconds?: number;
  humanHandoffOccurred?: boolean;
  qualityScore?: number;
  patientSentiment?: string;
  agentOutcome?: string;
}

export interface CreateTicketParams {
  /**
   * MEDICAL RECORDS / CAP ONLY.
   *
   * Azul Vision is under a Corrective Action Plan with HHS OCR over late
   * medical records, so a records request becomes an `mr_cases` row with a
   * statutory due date. Whether that clock APPLIES depends on who is asking:
   * a patient exercising their right of access, yes; a health plan, an
   * attorney or another clinic, no.
   *
   * Measured 2026-08-13: all 470 mr_cases rows read pathway 'roa_patient',
   * 421 of them created by the voice agent, and not one has a requestor
   * recorded — because nothing was ever sent. Every field took its database
   * default, so a statutory clock is being set by a column default.
   *
   * The voice side now sends these. The ticketing app has to READ them for the
   * clock to be right; until it does they are inert extra fields on the
   * payload, which is what makes sending them safe today.
   */
  requestorType?: 'patient' | 'personal_representative' | 'provider' | 'health_plan' | 'legal' | 'other';
  requestPathway?: 'roa_patient' | 'third_party_treatment' | 'third_party_plan' | 'third_party_legal' | 'third_party_other';
  capClockApplies?: boolean;
  requestorName?: string;
  departmentId: number;
  /**
   * Omit both when the request genuinely does not fit the department's
   * taxonomy. Sending 0 is NOT the same thing — create-ticket answers
   * "Validation failed" for it, measured 2026-08-12, because 0 is not a
   * foreign key. `tickets.request_type_id` and `request_reason_id` are both
   * nullable, and 736 real Optical tickets already carry null.
   */
  requestTypeId?: number;
  requestReasonId?: number;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string;
  patientEmail?: string;
  preferredContactMethod?: "phone" | "text" | "email";
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  patientBirthMonth?: string;
  patientBirthDay?: string;
  patientBirthYear?: string;
  locationId?: number;
  providerId?: number;
  description: string;
  priority?: "low" | "normal" | "medium" | "high" | "urgent";
  callData?: CallData;
  idempotencyKey?: string; // Undeclared here let a typo compile clean and send nothing — see PR #220.
}

export interface CreateTicketResponse {
  success: boolean;
  ticketId?: number;
  ticketNumber?: string;
  error?: string;
  // New fields from enhanced API (2026-01-13)
  providerSearched?: string;
  providerMatched?: boolean;
  locationSearched?: string;
  locationMatched?: boolean;
  lookupWarnings?: string[];
  usedFallbackReason?: boolean;
}

// NEW SIMPLIFIED ENDPOINT - accepts conversational data, handles all mapping server-side
export interface SubmitTicketParams {
  /**
   * A CLASSIFICATION HINT, not an instruction.
   *
   * This endpoint derives the department, request type and reason server-side,
   * which is why the voice side sends none of them. The cost of that shows up
   * in department 8: 413 of no-ivr's 687 tickets carry reason 159,
   * "Transferred to On-Call Provider", and almost none were transferred. They
   * are office-hours questions, broken glasses, a pharmacy asking for a phone
   * number.
   *
   * The cause is NOT the first-active-reason fallback I originally claimed and
   * the ticketing agent confirmed — neither of us read the code. It is a
   * two-character keyword, `er`, matched with String.includes at the highest
   * priority in their table: call-ER, h-ER, numb-ER, Qui-ER-o. Their fix
   * reclassifies 95.7% of a 300-ticket replay.
   *
   * The harm runs opposite to how it reads: routine calls recorded as urgent
   * transfers make the genuinely urgent ones unfindable. Sitting in the same
   * 413 is "Worsening pain in right eye over the past day".
   *
   * We are not taking the derivation over — doing that would mean this repo
   * choosing the DEPARTMENT for every overnight call. We send what our own
   * taxonomy concluded and let the ticketing app decide whether to use it.
   * Inert until read, which is what makes it safe on the line that carries
   * the night.
   */
  suggestedRequestTypeId?: number;
  suggestedRequestReasonId?: number;
  suggestedRequestReason?: string;
  /** Sight-threatening per `tools/afterHoursTaxonomy.ts`. */
  suggestedUrgent?: boolean;
  patientFullName: string;
  patientDOB: string; // Any format: "March 15, 1980" or "03/15/1980"
  reasonForCalling: string;
  preferredContactMethod: 'phone' | 'sms' | 'email';
  patientPhone?: string;
  patientEmail?: string;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalDetails?: string;
  /** Ticket priority — the app defaults urgent for Urgent/Emergency Transfer tickets and medium otherwise. */
  priority?: 'low' | 'normal' | 'medium' | 'high' | 'urgent';
  callData?: {
    callSid?: string;
    callerPhone?: string;
    dialedNumber?: string;
    agentUsed?: string;
    callStartTime?: string;
    callDurationSeconds?: number;
    transcript?: string;
  };
  idempotencyKey?: string; // Recommended: "call-{callSid}" to prevent duplicates
}

export interface SubmitTicketResponse {
  success: boolean;
  errorCode?: string;
  ticketId?: number;
  ticketNumber?: string;
  providerId?: number;
  providerMatched?: boolean;
  locationId?: number;
  locationMatched?: boolean;
  lookupWarnings?: string[];
  usedFallbackReason?: boolean;
  message?: string;
  error?: string;
  missingFields?: string[];
}

interface LogCallbackCampaignParams {
  ticketId: number;
  campaignType: string;
  status: "completed" | "failed" | "no_answer" | "voicemail";
  callDuration?: number;
  transcript?: string;
  notes?: string;
}

interface LogCallbackCampaignResponse {
  success: boolean;
  message?: string;
  error?: string;
}

interface UpdateTicketCallDataParams {
  callSid?: string;
  ticketNumber?: string; // Can identify by ticketNumber instead of callSid
  recordingUrl?: string;
  transcript?: string;
  callerPhone?: string;
  dialedNumber?: string;
  agentUsed?: string;
  callStartTime?: string;
  callEndTime?: string;
  callDurationSeconds?: number;
  humanHandoffOccurred?: boolean;
  qualityScore?: number;
  patientSentiment?: string;
  agentOutcome?: string;
}

interface UpdateTicketCallDataResponse {
  success: boolean;
  ticketNumber?: string;
  message?: string;
  error?: string;
}

interface LookupParams {
  providerName?: string;
  locationName?: string;
}

/**
 * WHY THIS CARRIES AN `outcome` AND NOT JUST A BOOLEAN.
 *
 * `lookupProviderAndLocation` catches its own transport error and answers
 * `{success:false}` — historically byte-identical to what it answers when a
 * name legitimately matched nobody. Every caller read only `providerId` /
 * `locationId`, so the two states collapsed into one branch, and the branch
 * said the caller's office or surgeon does not exist.
 *
 * On 2026-08-31 that collapse took optical to zero. `/api/voice-agent/lookup`
 * rode the n8n gateway; n8n hit its plan's execution cap at 20:16 UTC and
 * refused every execution at the webhook, answering 200 with a body that is
 * not JSON. Forty-three callers were told "I'm not finding an office by that
 * name" about Mission Hills, Downey, Glendale, Santa Ana and the rest of the
 * map. The sentence was false, so the caller repeated the office, so the tool
 * asked again: one call ran 19 tool calls over 8 minutes.
 *
 * Fixing that at the four call sites would have been four patches on one trap.
 * The trap is removed here instead, by making the two states impossible to
 * conflate: read `outcome`, or better, `lookupWasUnavailable()` below.
 *
 *   'unavailable'  the request never completed. NOT the caller's fault, and
 *                  they must never be told a name was not found.
 *   'no_match'     the request completed and returned no id. The name really
 *                  is one we do not hold.
 *   'matched'      at least one id came back.
 *
 * `outcome` describes the SERVICE, not a single field: a request for both a
 * provider and a location that resolves only one is still 'matched'. Which
 * fields resolved is still read from `providerId` / `locationId`, exactly as
 * before — the shape is unchanged and only widened.
 */
export type LookupOutcome = 'matched' | 'no_match' | 'unavailable';

interface LookupResponse {
  success: boolean;
  /**
   * Optional only because responses constructed elsewhere (test fixtures,
   * recorded payloads) predate the field. Anything this client returns sets
   * it. Use `lookupWasUnavailable()` rather than reading it raw.
   */
  outcome?: LookupOutcome;
  providerId?: number | null;
  provider?: {
    id: number;
    firstName: string;
    lastName: string;
    specialty: string;
  } | null;
  providerMatches?: Array<{ id: number; firstName: string; lastName: string }>;
  locationId?: number | null;
  location?: {
    id: number;
    name: string;
    city: string;
  } | null;
  locationMatches?: Array<{ id: number; name: string; city: string }>;
  error?: string;
}

// PHI-safe log helpers — never emit full patient identifiers to stdout. These
// masked forms are unconditional (they don't depend on DISABLE_PHI_LOGGING) so a
// misconfigured flag can't leak a patient name or full phone number. (R-6)
function maskPhone(phone?: string): string {
  if (!phone) return '(none)';
  const d = phone.replace(/\D/g, '');
  return d.length >= 4 ? `***${d.slice(-4)}` : '***';
}
function maskName(...parts: Array<string | undefined>): string {
  const initials = parts
    .flatMap((p) => (p ?? '').trim().split(/\s+/))
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  return initials ? `${initials}***` : '(none)';
}

export class TicketingApiClient {
  private baseUrl: string | null = null;
  // Direct-to-app base for post-call enrichment; falls back to baseUrl (n8n) when unset.
  private enrichmentBaseUrl: string | null = null;
  private apiKey: string | null = null;
  private initialized = false;
  private lastInitTime: number = 0;
  private static CONFIG_REFRESH_INTERVAL_MS = 60000; // Refresh config every 60 seconds

  /**
   * WHEN WE LAST HAD PROOF THE TICKETING APP WAS AWAKE.
   *
   * The warm-up probe fires before EVERY create and submit — healthCheck says
   * so in its own comment — and it is the single largest cost on the ticket
   * path. Measured across the fleet, 2026-08-17:
   *
   *     no-ivr             create_ticket   p50 8.3s  p90 19.2s  max 91.2s
   *     answering-service  create_ticket   p50 5.0s  p90 11.1s  max 67.9s
   *     optical / surgery  file_*_ticket   p50 ~4.0s p90 ~5.0s
   *     check_open_tickets (SAME API)      p50 0.17s
   *
   * The API is not slow — reads answer in 170ms. What every create pays for
   * first is `warmUpWithRetry(2, 500)`: a probe bounded at 3s, and on failure a
   * 500ms sleep and a second probe. Worst case 6.5 seconds before the POST is
   * even attempted.
   *
   * And the line that pays most is the one that can least afford it. The probe
   * exists to wake a sleeping Replit deployment; the deployment sleeps at
   * night; no-ivr is the after-hours line. Its p50 sits 3.3s above
   * answering-service for precisely that reason.
   *
   * So: remember when the app last answered. Inside the window, skip the probe
   * — we already know it is up, and asking again costs a caller seconds of
   * silence while the agent holds the line.
   *
   * NOTHING ABOUT FAILURE HANDLING CHANGES. The warm-up is already documented
   * as "ADVISORY, not a gate" and its failure never stopped a ticket. This only
   * skips a question we have just had answered. The POST keeps its own 15s
   * bound and reports its own error; the outbox still retries in the background.
   *
   * Sixty seconds is deliberately conservative — Replit deployments idle out in
   * minutes, not seconds, so a request within a minute of the last successful
   * one is certain to find the app awake. On a busy line that is nearly every
   * ticket; on a quiet night it is at least the rest of the burst.
   */
  private lastAliveAt = 0;
  private static LIVENESS_TTL_MS = 60_000;

  /**
   * Which host the warm-up probe actually wakes.
   *
   * `healthCheck` probes the DIRECT app when an enrichment base is configured,
   * and the n8n gateway otherwise. Liveness has to be recorded against the
   * same host or the cache answers the wrong question.
   */
  private probesDirectApp(): boolean {
    return !!this.enrichmentBaseUrl && this.enrichmentBaseUrl !== this.baseUrl;
  }

  /** The base the warm-up probe actually contacts. */
  private probeBase(): string | null {
    return this.probesDirectApp() ? this.enrichmentBaseUrl : this.baseUrl;
  }

  /**
   * Record proof of life — but only from the host the probe would have woken.
   *
   * The first version marked alive on ANY successful request. With
   * TICKETING_ENRICHMENT_URL set, that is wrong in the worst direction: a
   * successful call through the n8n gateway would suppress the probe of the
   * sleeping app for 60 seconds, so the create pays the cold start anyway and
   * the cache has bought nothing while hiding the reason.
   *
   * Not a live bug today — the enrichment URL is unset, so both are the same
   * host — but it arms itself the moment that secret is set, which is exactly
   * what I recommended doing this morning. Caught in review, 2026-08-17.
   */
  private markAlive(answeredBase: string | null | undefined): void {
    // COMPARE THE HOST, NOT THE INTENT.
    //
    // The first attempt compared boolean flags — "was this request meant for
    // the direct app?" against "does the probe use the direct app?". With
    // TICKETING_ENRICHMENT_URL unset those two are the SAME host, but the
    // flags disagree, so every createPcpTicket and updateTicketCallData
    // (which pass useEnrichmentBase=true) had its proof of life thrown away
    // and the next create paid the full probe the cache exists to skip.
    //
    // Comparing the resolved base is right in both configurations and needs
    // no reasoning about which flag means what. Found on the second review
    // pass, 2026-08-17.
    if (!answeredBase || answeredBase !== this.probeBase()) return;
    this.lastAliveAt = Date.now();
  }

  /**
   * Warm up ONLY when there is no recent proof the service is awake.
   *
   * Same contract as `warmUpWithRetry` — true means "believed live" — so call
   * sites change by name only.
   */
  private async warmUpIfStale(maxRetries: number, delayMs: number): Promise<boolean> {
    const since = Date.now() - this.lastAliveAt;
    if (this.lastAliveAt > 0 && since < TicketingApiClient.LIVENESS_TTL_MS) {
      console.info(`[TICKETING API] Warm-up skipped — service answered ${Math.round(since / 1000)}s ago`);
      return true;
    }
    // healthCheck records liveness itself, against the host it actually
    // probed. Marking again here would use the default `fromDirectApp=false`
    // and stamp the wrong host whenever the enrichment URL is configured.
    return this.warmUpWithRetry(maxRetries, delayMs);
  }

  private ensureInitialized(): void {
    const now = Date.now();
    const shouldRefresh = now - this.lastInitTime > TicketingApiClient.CONFIG_REFRESH_INTERVAL_MS;
    
    // Refresh config periodically to pick up any changes after redeploys
    if (this.initialized && !shouldRefresh) {
      return;
    }

    // Use getEnvironmentConfig() to properly load secrets in production
    // Production reads from .env file, development from Replit Secrets
    const config = getEnvironmentConfig();
    const ticketingUrl = config.ticketing.systemUrl;
    const enrichmentUrl = config.ticketing.enrichmentUrl;
    const apiKey = config.ticketing.apiKey;

    if (!this.initialized) {
      console.info("[TICKETING API] Initializing...");
      console.info(`[TICKETING API] Environment: ${config.isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    }
    
    console.info(`[TICKETING API] URL configured: ${ticketingUrl ? 'YES' : 'NO'}`);
    console.info(`[TICKETING API] API Key configured: ${apiKey ? 'YES (length: ' + apiKey.length + ')' : 'NO'}`);

    if (!ticketingUrl) {
      console.error("[TICKETING API] ✗ TICKETING_SYSTEM_URL not configured - check Replit Secrets");
      throw new Error("TICKETING_SYSTEM_URL not configured");
    }

    if (!apiKey) {
      console.error("[TICKETING API] ✗ TICKETING_API_KEY not configured - check Replit Secrets");
      throw new Error("TICKETING_API_KEY not configured");
    }

    this.baseUrl = ticketingUrl.replace(/\/$/, "");
    // Enrichment (update-call-data) goes direct to the app when configured, else through n8n.
    this.enrichmentBaseUrl = (enrichmentUrl || ticketingUrl).replace(/\/$/, "");
    this.apiKey = apiKey;
    this.initialized = true;
    this.lastInitTime = now;
    console.info("[TICKETING API] ✓ Initialized with URL:", this.baseUrl);
  }
  
  // Force refresh the configuration (call after redeploys)
  public refreshConfig(): void {
    this.initialized = false;
    this.lastInitTime = 0;
    console.info("[TICKETING API] Configuration cache cleared - will reload on next request");
  }
  
  // Health check to verify ticketing API is reachable
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.ensureInitialized();
      // Warm-up fires before EVERY create/submit, so routing it through the n8n
      // gateway cost one n8n execution per ticket (~half our monthly executions)
      // against the 10k cap. When a direct-to-app base is configured (the same
      // enrichment URL update-call-data uses), probe the app's static liveness
      // endpoint instead — that keeps warm-up off n8n entirely. Falls back to the
      // n8n health gateway only when no direct app URL is set.
      const useDirectApp = !!this.enrichmentBaseUrl && this.enrichmentBaseUrl !== this.baseUrl;
      const url = useDirectApp
        ? `${this.enrichmentBaseUrl}/api/voice-agent/ping`
        : `${this.baseUrl}/api/health`;
      // BOUNDED. This was the only fetch in this file without an
      // AbortController, and it is the one that runs BEFORE every ticket is
      // created — three times, via warmUpWithRetry. An unbounded probe there
      // does not degrade ticket creation, it prevents it: the request is never
      // sent, so nothing appears in the logs and nothing reaches the ticketing
      // app. On 2026-08-12 `file_surgery_ticket` produced no tool-timeline
      // event at all on three consecutive live calls, which is the signature of
      // a call that never settles rather than one that fails.
      //
      // Three seconds is generous for a liveness probe whose entire job is to
      // wake a sleeping deployment.
      const probe = new AbortController();
      const probeTimeout = setTimeout(() => probe.abort(), 3000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { 'X-API-Key': this.apiKey! },
          signal: probe.signal,
        });
      } finally {
        clearTimeout(probeTimeout);
      }
      if (response.ok) {
        console.info("[TICKETING API] ✓ Health check passed");
        this.markAlive(useDirectApp ? this.enrichmentBaseUrl : this.baseUrl);
        return { ok: true };
      } else {
        console.warn(`[TICKETING API] ⚠ Health check returned ${response.status}`);
        return { ok: false, error: `HTTP ${response.status}` };
      }
    } catch (error) {
      console.error("[TICKETING API] ✗ Health check failed:", error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async makeRequest<T>(
    endpoint: string,
    method: string,
    body?: any,
    timeoutMs: number = 15000,
    useEnrichmentBase: boolean = false
  ): Promise<T> {
    this.ensureInitialized();

    if (!this.baseUrl || !this.apiKey) {
      throw new Error("Ticketing API client not properly initialized");
    }

    // Resolve the base AFTER ensureInitialized() so enrichmentBaseUrl is populated
    // (reading it at the call site would capture null on the first request).
    const url = `${(useEnrichmentBase && this.enrichmentBaseUrl) || this.baseUrl}${endpoint}`;
    console.info(`[TICKETING API] Request: ${method} ${url} (timeout: ${timeoutMs}ms)`);

    // Shadow tap (observation only, default off): copies the production
    // gateway request/response so the shadow can replay n8n results without
    // ever re-triggering a workflow. emit never throws or blocks.
    const shadowSession = String(body?.callData?.callSid ?? body?.callSid ?? 'unknown-session');
    const shadowAgentRaw = String(body?.callData?.agentUsed ?? body?.agentUsed ?? 'unknown');
    const shadowAgent = shadowAgentRaw === 'urgent-triage' ? 'after-hours' : shadowAgentRaw;
    const shadowViaGateway = !(useEnrichmentBase && this.enrichmentBaseUrl);
    shadowTap.emit('n8n_workflow_requested', shadowSession, shadowAgent,
      { endpoint, method, viaGateway: shadowViaGateway, body: body ?? {} },
      { sensitive: true, component: 'ticketingApiClient' });
    let shadowReported = false;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.error(`[TICKETING API] ✗ Request timed out after ${timeoutMs}ms: ${endpoint}`);
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      console.info(`[TICKETING API] Response status: ${response.status} ${response.statusText}`);

      let data: any;
      try {
        data = await response.json();
      } catch (parseError) {
        console.error(`[TICKETING API] ✗ Failed to parse JSON response:`, parseError);
        throw new Error(`Invalid JSON response from ticketing API: ${response.status}`);
      }

      if (!response.ok) {
        // A 404 "no ticket found" is deterministic and expected for calls
        // that never created a ticket (see ticketingSyncPolicy) — info, not
        // an error dump.
        if (response.status === 404 && isNoTicketError(String(data?.error ?? ''))) {
          console.info(`[TICKETING API] 404 no-ticket for ${endpoint} (expected for info-only calls)`);
        } else {
          console.error(`[TICKETING API] Error ${response.status}:`, data);
        }
        shadowTap.emit('n8n_workflow_failed', shadowSession, shadowAgent,
          { endpoint, method, viaGateway: shadowViaGateway, status: response.status, body: body ?? {}, response: data ?? {} },
          { sensitive: true, component: 'ticketingApiClient' });
        shadowReported = true;
        throw new Error(data.error || `HTTP ${response.status} error`);
      }

      shadowTap.emit('n8n_workflow_completed', shadowSession, shadowAgent,
        { endpoint, method, viaGateway: shadowViaGateway, status: response.status, body: body ?? {}, response: data ?? {} },
        { sensitive: true, component: 'ticketingApiClient' });
      // A real answer is better proof of life than any probe — but only from
      // the host the probe would have woken (see markAlive).
      this.markAlive((useEnrichmentBase && this.enrichmentBaseUrl) || this.baseUrl);
      return data as T;
    } catch (networkError) {
      clearTimeout(timeoutId);
      if (!shadowReported) {
        shadowTap.emit('n8n_workflow_failed', shadowSession, shadowAgent,
          { endpoint, method, viaGateway: shadowViaGateway, status: 0, body: body ?? {}, error: networkError instanceof Error ? networkError.message : 'error' },
          { sensitive: true, component: 'ticketingApiClient' });
      }
      
      if (networkError instanceof Error && networkError.name === 'AbortError') {
        console.error(`[TICKETING API] ✗ Request aborted (timeout): ${endpoint}`);
        throw new Error(`Ticketing API timeout after ${timeoutMs}ms - please try again`);
      }
      if (networkError instanceof Error && networkError.message.includes('fetch')) {
        console.error(`[TICKETING API] ✗ Network error - ticketing system unreachable:`, networkError.message);
        throw new Error(`Ticketing system unreachable: ${networkError.message}`);
      }
      throw networkError;
    }
  }

  // Warm up the ticketing service with retries (handles sleeping Replit deployments)
  private async warmUpWithRetry(maxRetries: number = 3, delayMs: number = 2000): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.info(`[TICKETING API] Warming up service (attempt ${attempt}/${maxRetries})...`);
        const result = await this.healthCheck();
        if (result.ok) {
          console.info(`[TICKETING API] ✓ Service warmed up on attempt ${attempt}`);
          return true;
        }
        console.warn(`[TICKETING API] ⚠ Health check failed: ${result.error}`);
      } catch (err) {
        console.warn(`[TICKETING API] ⚠ Warm-up attempt ${attempt} failed:`, err);
      }
      
      if (attempt < maxRetries) {
        console.info(`[TICKETING API] Waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    console.error(`[TICKETING API] ✗ Failed to warm up service after ${maxRetries} attempts`);
    return false;
  }

  async createTicket(params: CreateTicketParams): Promise<CreateTicketResponse> {
    console.info("[TICKETING API] Creating ticket:", {
      patient: maskName(params.patientFirstName, params.patientLastName),
      phone: maskPhone(params.patientPhone),
      departmentId: params.departmentId,
      priority: params.priority || "medium",
      preferredContactMethod: params.preferredContactMethod,
      lastProviderSeen: params.lastProviderSeen,
      locationOfLastVisit: params.locationOfLastVisit,
      hasCallData: !!params.callData,
      callSid: params.callData?.callSid,
      hasRecording: !!params.callData?.recordingUrl,
      hasTranscript: !!params.callData?.transcript,
      callDuration: params.callData?.callDurationSeconds,
    });

    // Warm-up is ADVISORY, not a gate.
    //
    // It exists to wake a sleeping Replit deployment, which is an optimisation.
    // Treating its failure as fatal meant a health probe that could not answer
    // stopped a ticket that would otherwise have been filed — and returned a
    // synthetic "temporarily unavailable" instead of whatever the real endpoint
    // would have said, which is strictly less information. The request itself
    // is bounded at 15s by makeRequest and reports its own error.
    if (!(await this.warmUpIfStale(2, 500))) {
      console.warn("[TICKETING API] ⚠ Warm-up did not confirm liveness — sending anyway");
    }

    try {
      const response = await this.makeRequest<CreateTicketResponse>(
        "/api/voice-agent/create-ticket",
        "POST",
        params
      );

      console.info(
        `[TICKETING API] ✓ Ticket created: ${response.ticketNumber} (ID: ${response.ticketId})`
      );

      /**
       * WRITE THE TICKET NUMBER BACK TO THE CALL LOG — found 2026-08-13, and
       * it was the single biggest red number on the dashboard.
       *
       * Only the submit-ticket path ever did this (releaseTicketCreationLock
       * in syncAgentService). Every create-ticket caller — all four queue
       * lines, PCP, records — filed real tickets that call_logs never heard
       * about. The grader reads call_logs.ticket_number, so every queue call
       * looked ticketless: ticket_required_vs_created failed 46.2% of tech's
       * calls on a day tech filed 106 real tickets.
       *
       * The check was never measuring lost requests. It was measuring this
       * missing write.
       *
       * Reuses releaseTicketCreationLock because it already does exactly this
       * write; clearing a pending-lock the create-ticket path never set is a
       * no-op. Fire-and-forget: bookkeeping must never delay a filed ticket.
       */
      const sidForWriteback = params.callData?.callSid;
      if (sidForWriteback && response.ticketNumber) {
        void import('../storage')
          .then(({ storage }) => storage.releaseTicketCreationLock(sidForWriteback, response.ticketNumber))
          .catch((e) => console.warn('[TICKETING API] ticket_number writeback failed:', e));
      }

      // Log lookup results for visibility
      if (response.providerSearched !== undefined || response.locationSearched !== undefined) {
        console.info(`[TICKETING API] Lookup results:`, {
          providerSearched: response.providerSearched,
          providerMatched: response.providerMatched,
          locationSearched: response.locationSearched,
          locationMatched: response.locationMatched,
        });
      }
      
      // Log any lookup warnings for staff awareness
      if (response.lookupWarnings && response.lookupWarnings.length > 0) {
        console.warn(`[TICKETING API] ⚠️  Lookup warnings for ${response.ticketNumber}:`, response.lookupWarnings);
      }
      
      if (response.usedFallbackReason) {
        console.warn(`[TICKETING API] ⚠️  Used fallback reason for ${response.ticketNumber} - manual review needed`);
      }

      return response;
    } catch (error) {
      console.error("[TICKETING API] ✗ Failed to create ticket:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * THE LOCATION-QUEUE MODE of create-ticket — the third way in, and until
   * 2026-08-14 the only one that did not live in this file.
   *
   * The scheduling agent routes by OFFICE, not by department: it posts
   * `queue: 'location'` with a `locationName` and lets the server pick the
   * team. `createTicket` cannot express that — `departmentId` is required
   * there — so `azulSchedulingAgent` had its own raw `fetch`, and with it its
   * own timeout, its own writeback and no warm-up at all.
   *
   * That last one is the gap that mattered. Every other path calls
   * `warmUpWithRetry` first because the ticketing app is a Replit deployment
   * that sleeps; scheduling went straight to `fetch`, so a sleeping deployment
   * meant a lost ticket and a console line. This is the queue that books real
   * appointments and files the failed-transfer callbacks.
   *
   * Behaviour preserved exactly, because it was all load-bearing:
   *   - the 15s hard timeout (a hung POST must never wedge teardown)
   *   - the 422 re-file into the default queue when an office has no queue
   *     onboarded yet, with the real office named in the description
   *   - the ticket-number writeback onto the call log
   */
  async createLocationQueueTicket(params: {
    locationName: string;
    defaultLocationName: string;
    body: Record<string, unknown>;
    callSid?: string;
  }): Promise<{ ok: boolean; status: number; text: string; ticketNumber?: string; refiled?: boolean }> {
    this.ensureInitialized();
    if (!this.baseUrl || !this.apiKey) {
      // Same shape a failed POST returns, so the caller has one path to handle.
      console.warn('[TICKETING API] location-queue ticket skipped — client not configured');
      return { ok: false, status: 0, text: 'ticketing client not configured' };
    }
    const url = `${this.baseUrl}/api/voice-agent/create-ticket`;
    const apiKey = this.apiKey;

    // Advisory, exactly as elsewhere: a probe that cannot answer must not stop
    // a ticket that would otherwise be filed.
    await this.warmUpIfStale(2, 500);

    const post = (payload: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });

    let r = await post(params.body);
    let text = await r.text();
    let refiled = false;

    if (
      r.status === 422 &&
      params.locationName.toLowerCase() !== params.defaultLocationName.toLowerCase()
    ) {
      console.warn(
        `[TICKETING API] no queue for '${params.locationName}' — re-filing to ${params.defaultLocationName}`,
      );
      refiled = true;
      r = await post({
        ...params.body,
        locationName: params.defaultLocationName,
        description:
          `[For office: ${params.locationName} — no queue onboarded yet, routed to default]\n` +
          `${String(params.body.description ?? '')}`,
      });
      text = await r.text();
    }

    let ticketNumber: string | undefined;
    if (r.ok) {
      try {
        const parsed = JSON.parse(text);
        ticketNumber = parsed?.ticketNumber ?? parsed?.ticket?.ticketNumber;
      } catch {
        /* a non-JSON 200 is still a filed ticket */
      }
    }

    // Same writeback every other path now performs — the grader reads
    // call_logs.ticket_number, and a ticket it cannot see does not exist.
    if (ticketNumber && params.callSid) {
      try {
        const { storage } = await import('../storage');
        const log = await storage.getCallLogByCallSid(params.callSid);
        if (log && !log.ticketNumber) {
          await storage.updateCallLog(log.id, { ticketNumber: String(ticketNumber) });
        }
      } catch (e) {
        console.warn('[TICKETING API] location-queue writeback failed:', e);
      }
    }

    console.log(
      `[TICKETING API] location-queue ticket ${r.ok ? `created${refiled ? ' (re-filed)' : ''}` : `FAILED ${r.status}`}: ${text.slice(0, 200)}`,
    );
    return { ok: r.ok, status: r.status, text, ticketNumber, refiled };
  }

  /**
   * NEW SIMPLIFIED ENDPOINT - Submit ticket with conversational data
   * The external API handles all mapping (DOB parsing, reason categorization, provider/location matching)
   * This is the preferred method for voice agents - more reliable than the legacy createTicket
   */
  async submitTicket(params: SubmitTicketParams): Promise<SubmitTicketResponse> {
    console.info("[TICKETING API] Submitting ticket (simplified endpoint):", {
      patientName: maskName(params.patientFullName),
      hasPhone: !!params.patientPhone,
      hasEmail: !!params.patientEmail,
      preferredContact: params.preferredContactMethod,
      lastProvider: params.lastProviderSeen,
      lastLocation: params.locationOfLastVisit,
      hasCallData: !!params.callData,
      callSid: params.callData?.callSid,
      idempotencyKey: params.idempotencyKey,
    });

    // Warm up the ticketing service before submitting (handles sleeping deployments)
    const warmedUp = await this.warmUpIfStale(3, 2000);
    if (!warmedUp) {
      console.error("[TICKETING API] ✗ Ticketing service unreachable after warm-up attempts");
      return {
        success: false,
        errorCode: 'service_unavailable',
        error: "Ticketing service is temporarily unavailable. Please try again.",
      };
    }

    try {
      const response = await this.makeRequest<SubmitTicketResponse>(
        "/api/voice-agent/submit-ticket",
        "POST",
        params
      );

      if (response.success) {
        console.info(
          `[TICKETING API] ✓ Ticket submitted: ${response.ticketNumber} (ID: ${response.ticketId})`
        );

        // Log lookup results for visibility
        console.info(`[TICKETING API] Lookup results:`, {
          providerMatched: response.providerMatched,
          locationMatched: response.locationMatched,
        });
        
        // Log any lookup warnings for staff awareness
        if (response.lookupWarnings && response.lookupWarnings.length > 0) {
          console.warn(`[TICKETING API] ⚠️  Lookup warnings for ${response.ticketNumber}:`, response.lookupWarnings);
        }
        
        if (response.usedFallbackReason) {
          console.warn(`[TICKETING API] ⚠️  Used fallback reason for ${response.ticketNumber} - manual review needed`);
        }
      } else {
        console.error(`[TICKETING API] ✗ Ticket submission failed:`, {
          errorCode: response.errorCode,
          error: response.error,
          missingFields: response.missingFields,
        });
      }

      return response;
    } catch (error) {
      console.error("[TICKETING API] ✗ Failed to submit ticket:", error);
      return {
        success: false,
        errorCode: 'request_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async logCallbackCampaign(
    params: LogCallbackCampaignParams
  ): Promise<LogCallbackCampaignResponse> {
    console.info("[TICKETING API] Logging callback campaign result:", {
      ticketId: params.ticketId,
      status: params.status,
      duration: params.callDuration,
    });

    try {
      const response = await this.makeRequest<LogCallbackCampaignResponse>(
        "/api/voice-agent/callback-campaign",
        "POST",
        params
      );

      console.info(
        `[TICKETING API] ✓ Callback result logged for ticket ${params.ticketId}`
      );

      return response;
    } catch (error) {
      console.error("[TICKETING API] ✗ Failed to log callback result:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async updateTicketCallData(
    params: UpdateTicketCallDataParams
  ): Promise<UpdateTicketCallDataResponse> {
    console.info("[TICKETING API] Updating ticket with call data:", {
      ticketNumber: params.ticketNumber,
      callSid: params.callSid,
      hasRecording: !!params.recordingUrl,
      hasTranscript: !!params.transcript,
      callDuration: params.callDurationSeconds,
      qualityScore: params.qualityScore,
    });

    try {
      const response = await this.makeRequest<UpdateTicketCallDataResponse>(
        "/api/voice-agent/update-call-data",
        "POST",
        params,
        15000,
        true
      );

      if (response.success) {
        console.info(
          `[TICKETING API] ✓ Call data updated for ticket ${response.ticketNumber || params.callSid}`
        );
      }

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNoTicketError(message)) {
        // Deterministic outcome: this call created no ticket, so there is
        // nothing to enrich. The sync policy handles terminal classification.
        console.info(`[TICKETING API] No ticket to enrich for callSid ${params.callSid} (expected for info-only calls)`);
      } else {
        console.error("[TICKETING API] ✗ Failed to update ticket call data:", error);
      }
      return {
        success: false,
        error: message,
      };
    }
  }

  /** PCP uses a caller-first contract and always bypasses the n8n/patient path. */
  async createPcpTicket(params: PcpTicketPayload): Promise<PcpTicketResponse> {
    try {
      const response = await this.makeRequest<PcpTicketResponse>(
        '/api/voice-agent/pcp-ticket',
        'POST',
        params,
        15_000,
        true,
      );

      /**
       * THE WRITEBACK THIS PATH NEVER HAD — the last filing route without one.
       *
       * `createTicket` and `createLocationQueueTicket` both write the ticket
       * number onto call_logs. This one did not, so EVERY PCP ticket ever filed
       * left call_logs.ticket_number NULL. Two consequences, both live:
       *
       *   - No PCP call could be traced to the ticket it produced. On
       *     2026-08-14 the operator's own afternoon test calls show
       *     `create_pcp_task -> terminate_call` with a clean exit and a blank
       *     ticket column; the ticket exists, we just could not name it.
       *   - `ticket_required_vs_created` reads that column, so a filed ticket
       *     graded as no ticket. PCP fails that check on 23% of calls — the
       *     same false failure that `create_ticket` was producing until it got
       *     this writeback on 08-13.
       *
       * Guarded by `!log.ticketNumber` so a call that filed twice keeps the
       * first number rather than flapping, and wrapped so a telemetry failure
       * can never fail a ticket that was actually filed.
       */
      if (response?.success && response.ticketNumber && params.callSid) {
        try {
          const { storage } = await import('../storage');
          const log = await storage.getCallLogByCallSid(params.callSid);
          if (log && !log.ticketNumber) {
            await storage.updateCallLog(log.id, { ticketNumber: String(response.ticketNumber) });
          }
        } catch (e) {
          console.warn('[TICKETING API] pcp-ticket writeback failed:', e);
        }
      }

      return response;
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'pcp_ticket_request_failed' };
    }
  }

  /**
   * Look up provider and location IDs by name from the external ticketing system.
   * This ensures we use IDs that exist in the external database, preventing FK violations.
   */
  async lookupProviderAndLocation(params: LookupParams): Promise<LookupResponse> {
    // Skip lookup if neither provider nor location specified. Nothing was
    // asked, so nothing was found — but the service was never in question,
    // which is what 'no_match' says and 'unavailable' would not.
    if (!params.providerName && !params.locationName) {
      return { success: true, outcome: 'no_match' };
    }

    console.info("[TICKETING API] Looking up provider/location:", {
      providerName: params.providerName || '(none)',
      locationName: params.locationName || '(none)',
    });

    try {
      this.ensureInitialized();
      
      const response = await this.makeRequest<LookupResponse>(
        "/api/voice-agent/lookup",
        "POST",
        params
      );

      console.info("[TICKETING API] Lookup result:", {
        providerId: response.providerId,
        providerMatches: response.providerMatches?.length || 0,
        locationId: response.locationId,
        locationMatches: response.locationMatches?.length || 0,
      });

      /**
       * A body that says `success:false` is the far side declining to answer,
       * not a considered "no such name" — so it is 'unavailable' too. That
       * keeps the equivalence `outcome === 'unavailable'` <-> `success ===
       * false` exact, which is what lets `lookupWasUnavailable()` fall back
       * safely on a response that predates this field.
       */
      const outcome: LookupOutcome =
        response.success === false
          ? 'unavailable'
          : response.providerId || response.locationId
            ? 'matched'
            : 'no_match';

      return { ...response, outcome };
    } catch (error) {
      console.warn("[TICKETING API] ⚠️ Lookup failed, will create ticket without IDs:", error);
      // Don't fail ticket creation if lookup fails — but SAY SO, in a way the
      // caller cannot mistake for a name that matched nobody. Proceeding
      // without ids is right; telling the patient their office does not exist
      // is what cost 43 calls on 2026-08-31.
      return {
        success: false,
        outcome: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * THE ONE QUESTION EVERY CALLER OF THE LOOKUP HAS TO ASK.
 *
 * "Did the lookup actually run?" — because the answer decides whether the
 * caller's own words may be questioned back at them. Use this rather than
 * reading `outcome` or `success` directly, so the decision is made the same
 * way in all four queues.
 *
 * The `success === false` fallback covers responses built before `outcome`
 * existed (fixtures, recorded payloads, anything not minted by
 * `lookupProviderAndLocation`). The two are equivalent by construction above.
 */
export function lookupWasUnavailable(
  result: { outcome?: LookupOutcome; success?: boolean } | null | undefined,
): boolean {
  if (!result) return true;
  if (result.outcome) return result.outcome === 'unavailable';
  return result.success === false;
}

export const ticketingApiClient = new TicketingApiClient();
