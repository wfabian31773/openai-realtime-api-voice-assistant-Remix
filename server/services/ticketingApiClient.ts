import { getEnvironmentConfig } from '../../src/config/environment';

interface CallData {
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

interface CreateTicketParams {
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
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
}

interface CreateTicketResponse {
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
  patientFullName: string;
  patientDOB: string; // Any format: "March 15, 1980" or "03/15/1980"
  reasonForCalling: string;
  preferredContactMethod: 'phone' | 'sms' | 'email';
  patientPhone?: string;
  patientEmail?: string;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalDetails?: string;
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

interface LookupResponse {
  success: boolean;
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

export class TicketingApiClient {
  private baseUrl: string | null = null;
  private apiKey: string | null = null;
  private initialized = false;
  private lastInitTime: number = 0;
  private static CONFIG_REFRESH_INTERVAL_MS = 60000; // Refresh config every 60 seconds

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
      const url = `${this.baseUrl}/api/health`;
      const response = await fetch(url, { 
        method: 'GET',
        headers: { 'X-API-Key': this.apiKey! },
      });
      if (response.ok) {
        console.info("[TICKETING API] ✓ Health check passed");
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
    timeoutMs: number = 15000
  ): Promise<T> {
    this.ensureInitialized();

    if (!this.baseUrl || !this.apiKey) {
      throw new Error("Ticketing API client not properly initialized");
    }

    const url = `${this.baseUrl}${endpoint}`;
    console.info(`[TICKETING API] Request: ${method} ${url} (timeout: ${timeoutMs}ms)`);

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
        console.error(`[TICKETING API] Error ${response.status}:`, data);
        throw new Error(data.error || `HTTP ${response.status} error`);
      }

      return data as T;
    } catch (networkError) {
      clearTimeout(timeoutId);
      
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
      patient: `${params.patientFirstName} ${params.patientLastName}`,
      phone: params.patientPhone,
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

    // Warm up the ticketing service before creating ticket (handles sleeping deployments)
    const warmedUp = await this.warmUpWithRetry(3, 2000);
    if (!warmedUp) {
      console.error("[TICKETING API] ✗ Ticketing service unreachable after warm-up attempts");
      return {
        success: false,
        error: "Ticketing service is temporarily unavailable. Please try again.",
      };
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
   * NEW SIMPLIFIED ENDPOINT - Submit ticket with conversational data
   * The external API handles all mapping (DOB parsing, reason categorization, provider/location matching)
   * This is the preferred method for voice agents - more reliable than the legacy createTicket
   */
  async submitTicket(params: SubmitTicketParams): Promise<SubmitTicketResponse> {
    console.info("[TICKETING API] Submitting ticket (simplified endpoint):", {
      patientName: params.patientFullName,
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
    const warmedUp = await this.warmUpWithRetry(3, 2000);
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
        params
      );

      if (response.success) {
        console.info(
          `[TICKETING API] ✓ Call data updated for ticket ${response.ticketNumber || params.callSid}`
        );
      }

      return response;
    } catch (error) {
      console.error("[TICKETING API] ✗ Failed to update ticket call data:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Look up provider and location IDs by name from the external ticketing system.
   * This ensures we use IDs that exist in the external database, preventing FK violations.
   */
  async lookupProviderAndLocation(params: LookupParams): Promise<LookupResponse> {
    // Skip lookup if neither provider nor location specified
    if (!params.providerName && !params.locationName) {
      return { success: true };
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

      return response;
    } catch (error) {
      console.warn("[TICKETING API] ⚠️ Lookup failed, will create ticket without IDs:", error);
      // Don't fail ticket creation if lookup fails - just proceed without IDs
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const ticketingApiClient = new TicketingApiClient();
