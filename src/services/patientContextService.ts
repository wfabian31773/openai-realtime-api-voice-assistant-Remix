export interface ScheduleContext {
  patientFound: boolean;
  upcomingAppointments: {
    date: string;
    dayOfWeek: string;
    timeOfDay: string;
    location: string;
    provider: string;
    status: string;
    category?: string;
  }[];
  pastAppointments: {
    date: string;
    dayOfWeek: string;
    timeOfDay: string;
    location: string;
    provider: string;
    status: string;
    category?: string;
  }[];
  lastLocationSeen?: string;
  lastProviderSeen?: string;
  lastVisitDate?: string;
  totalAppointmentsFound: number;
}

export interface PatientInfo {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: {
    month?: string;
    day?: string;
    year?: string;
    raw?: string;
  };
  phone?: string;
  email?: string;
  preferredContactMethod?: 'phone' | 'text' | 'email';
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
}

export interface CallContext {
  callId: string;
  callSid?: string;
  ivrSelection?: '1' | '2' | '3' | '4';
  language: 'english' | 'spanish';
  callerPhone?: string;
  dialedNumber?: string;
  startTime: Date;
}

export interface TriageAssessment {
  isUrgent: boolean;
  urgencyReason?: string;
  symptoms?: string[];
  triageOutcome?: string;
}

export interface PatientContext {
  callContext: CallContext;
  patientInfo: PatientInfo;
  scheduleContext?: ScheduleContext;
  callReason?: string;
  callReasonDetails?: string;
  triageAssessment?: TriageAssessment;
  conversationSummary?: string;
  collectedAt?: Date;
  handoffTo?: 'ticketing' | 'human' | 'complete';
  ticketNumber?: string;
}

class PatientContextService {
  private contexts: Map<string, PatientContext> = new Map();
  
  private cleanupInterval: NodeJS.Timeout;
  
  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupStaleContexts(), 30 * 60 * 1000);
  }

  createContext(callId: string, options: {
    callSid?: string;
    ivrSelection?: '1' | '2' | '3' | '4';
    language?: 'english' | 'spanish';
    callerPhone?: string;
    dialedNumber?: string;
  }): PatientContext {
    const context: PatientContext = {
      callContext: {
        callId,
        callSid: options.callSid,
        ivrSelection: options.ivrSelection,
        language: options.language || 'english',
        callerPhone: options.callerPhone,
        dialedNumber: options.dialedNumber,
        startTime: new Date(),
      },
      patientInfo: {},
    };
    
    this.contexts.set(callId, context);
    console.log(`[PatientContext] Created context for call ${callId}`, {
      ivrSelection: options.ivrSelection,
      language: options.language,
      hasCallerPhone: !!options.callerPhone,
    });
    
    return context;
  }

  getContext(callId: string): PatientContext | undefined {
    return this.contexts.get(callId);
  }

  updatePatientInfo(callId: string, info: Partial<PatientInfo>): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) {
      console.warn(`[PatientContext] No context found for call ${callId}`);
      return undefined;
    }
    
    context.patientInfo = { ...context.patientInfo, ...info };
    context.collectedAt = new Date();
    
    console.log(`[PatientContext] Updated patient info for ${callId}:`, {
      hasFirstName: !!context.patientInfo.firstName,
      hasLastName: !!context.patientInfo.lastName,
      hasDOB: !!context.patientInfo.dateOfBirth,
      hasPhone: !!context.patientInfo.phone,
    });
    
    return context;
  }

  setCallReason(callId: string, reason: string, details?: string): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) return undefined;
    
    context.callReason = reason;
    context.callReasonDetails = details;
    
    console.log(`[PatientContext] Set call reason for ${callId}: ${reason}`);
    return context;
  }

  setTriageAssessment(callId: string, assessment: TriageAssessment): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) return undefined;
    
    context.triageAssessment = assessment;
    
    console.log(`[PatientContext] Triage assessment for ${callId}:`, {
      isUrgent: assessment.isUrgent,
      reason: assessment.urgencyReason,
    });
    
    return context;
  }

  setConversationSummary(callId: string, summary: string): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) return undefined;
    
    context.conversationSummary = summary;
    return context;
  }

  prepareHandoff(callId: string, handoffTo: 'ticketing' | 'human'): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) return undefined;
    
    context.handoffTo = handoffTo;
    
    console.log(`[PatientContext] Preparing handoff for ${callId} to ${handoffTo}`);
    return context;
  }

  buildHandoffSummary(callId: string): string {
    const context = this.contexts.get(callId);
    if (!context) return 'No context available';
    
    const { patientInfo, callReason, triageAssessment, callContext } = context;
    
    const parts: string[] = [];
    
    if (patientInfo.firstName || patientInfo.lastName) {
      parts.push(`Patient: ${patientInfo.firstName || ''} ${patientInfo.lastName || ''}`.trim());
    }
    
    if (patientInfo.dateOfBirth?.raw) {
      parts.push(`DOB: ${patientInfo.dateOfBirth.raw}`);
    }
    
    if (patientInfo.phone || callContext.callerPhone) {
      parts.push(`Phone: ${patientInfo.phone || callContext.callerPhone}`);
    }
    
    if (callReason) {
      parts.push(`Reason: ${callReason}`);
    }
    
    if (triageAssessment?.isUrgent && triageAssessment.urgencyReason) {
      parts.push(`URGENT: ${triageAssessment.urgencyReason}`);
    }
    
    return parts.join(' | ') || 'No details collected';
  }

  buildWarmTransferScript(callId: string): string {
    const context = this.contexts.get(callId);
    if (!context) return 'Caller needs assistance.';
    
    const { patientInfo, callReason, triageAssessment } = context;
    
    const name = [patientInfo.firstName, patientInfo.lastName].filter(Boolean).join(' ') || 'The caller';
    const dob = patientInfo.dateOfBirth?.raw ? `, date of birth ${patientInfo.dateOfBirth.raw}` : '';
    const reason = callReason || 'an after-hours concern';
    const urgency = triageAssessment?.urgencyReason || '';
    
    if (triageAssessment?.isUrgent) {
      return `${name}${dob} is calling about ${reason}. ${urgency ? `They are experiencing ${urgency}.` : ''} This appears to be urgent.`;
    }
    
    return `${name}${dob} is calling about ${reason}.`;
  }

  setTicketNumber(callId: string, ticketNumber: string): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) return undefined;
    
    context.ticketNumber = ticketNumber;
    context.handoffTo = 'complete';
    
    console.log(`[PatientContext] Ticket ${ticketNumber} created for call ${callId}`);
    return context;
  }

  setScheduleContext(callId: string, scheduleContext: ScheduleContext): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) return undefined;
    
    context.scheduleContext = scheduleContext;
    
    if (scheduleContext.patientFound) {
      if (scheduleContext.lastProviderSeen && !context.patientInfo.lastProviderSeen) {
        context.patientInfo.lastProviderSeen = scheduleContext.lastProviderSeen;
      }
      if (scheduleContext.lastLocationSeen && !context.patientInfo.locationOfLastVisit) {
        context.patientInfo.locationOfLastVisit = scheduleContext.lastLocationSeen;
      }
    }
    
    console.log(`[PatientContext] Schedule context set for ${callId}:`, {
      patientFound: scheduleContext.patientFound,
      upcomingCount: scheduleContext.upcomingAppointments.length,
      pastCount: scheduleContext.pastAppointments.length,
    });
    
    return context;
  }

  getScheduleContext(callId: string): ScheduleContext | undefined {
    const context = this.contexts.get(callId);
    return context?.scheduleContext;
  }

  hasScheduleContext(callId: string): boolean {
    const context = this.contexts.get(callId);
    return !!context?.scheduleContext;
  }

  buildSchedulePromptContext(callId: string): string {
    const context = this.contexts.get(callId);
    if (!context?.scheduleContext) {
      return '';
    }

    const sc = context.scheduleContext;
    if (!sc.patientFound) {
      return 'SCHEDULE INFO: No appointment history found for this caller. They may be a new patient.';
    }

    const parts: string[] = ['===== PATIENT SCHEDULE CONTEXT ====='];
    parts.push('The following information was automatically retrieved from our scheduling system:');
    
    if (sc.upcomingAppointments.length > 0) {
      parts.push('\nUPCOMING APPOINTMENTS:');
      sc.upcomingAppointments.forEach((apt, i) => {
        parts.push(`  ${i + 1}. ${apt.date} (${apt.timeOfDay}) at ${apt.location} with ${apt.provider}`);
      });
    } else {
      parts.push('\nNo upcoming appointments scheduled.');
    }

    if (sc.pastAppointments.length > 0 && sc.lastVisitDate) {
      parts.push(`\nLast visit: ${sc.lastVisitDate}`);
    }

    if (sc.lastLocationSeen) {
      parts.push(`Last location seen: ${sc.lastLocationSeen}`);
    }
    if (sc.lastProviderSeen) {
      parts.push(`Last provider seen: ${sc.lastProviderSeen}`);
    }

    parts.push('\nUSE THIS INFORMATION to personalize the conversation:');
    parts.push('- Reference upcoming appointments if relevant');
    parts.push('- Use their usual location/provider when discussing scheduling');
    parts.push('- Do NOT ask questions if you already have the answer above');
    parts.push('=====================================');

    return parts.join('\n');
  }

  getMissingRequiredFields(callId: string): string[] {
    const context = this.contexts.get(callId);
    if (!context) return ['firstName', 'lastName', 'dateOfBirth', 'phone', 'callReason'];
    
    const missing: string[] = [];
    const { patientInfo, callReason, callContext } = context;
    
    if (!patientInfo.firstName) missing.push('firstName');
    if (!patientInfo.lastName) missing.push('lastName');
    if (!patientInfo.dateOfBirth?.month || !patientInfo.dateOfBirth?.day || !patientInfo.dateOfBirth?.year) {
      missing.push('dateOfBirth');
    }
    if (!patientInfo.phone && !callContext.callerPhone) missing.push('phone');
    if (!callReason) missing.push('callReason');
    
    return missing;
  }

  isReadyForTicketing(callId: string): boolean {
    return this.getMissingRequiredFields(callId).length === 0;
  }

  completeCall(callId: string): PatientContext | undefined {
    const context = this.contexts.get(callId);
    if (!context) return undefined;
    
    context.handoffTo = 'complete';
    console.log(`[PatientContext] Call ${callId} completed`);
    
    setTimeout(() => {
      this.contexts.delete(callId);
      console.log(`[PatientContext] Cleaned up context for ${callId}`);
    }, 5 * 60 * 1000);
    
    return context;
  }

  private cleanupStaleContexts(): void {
    const now = new Date();
    const maxAge = 2 * 60 * 60 * 1000;
    
    for (const [callId, context] of this.contexts.entries()) {
      const age = now.getTime() - context.callContext.startTime.getTime();
      if (age > maxAge) {
        this.contexts.delete(callId);
        console.log(`[PatientContext] Cleaned up stale context for ${callId}`);
      }
    }
  }

  getActiveCallCount(): number {
    return this.contexts.size;
  }

  shutdown(): void {
    clearInterval(this.cleanupInterval);
  }
}

export const patientContextService = new PatientContextService();
