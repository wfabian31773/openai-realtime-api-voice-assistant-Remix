import {
  IntentType,
  WorkflowContext,
  WorkflowState,
  ConversationSlots,
  INTENT_KEYWORDS,
  ESCALATION_KEYWORDS,
  SlotType,
} from './workflowTypes';
import {
  WorkflowDefinition,
  WORKFLOW_DEFINITIONS,
  getWorkflowForIntent,
  getMissingRequiredSlots,
  canCompleteWorkflow,
  SLOT_DEFINITIONS,
} from './workflowDefinitions';

export interface ClassificationResult {
  intent: IntentType;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
  requiresEscalation: boolean;
  escalationReason?: string;
}

export interface WorkflowTransition {
  fromState: WorkflowState;
  toState: WorkflowState;
  triggeredBy: string;
  timestamp: Date;
  slots: ConversationSlots;
}

export interface WorkflowDirective {
  action: 'collect_slot' | 'confirm_summary' | 'execute' | 'escalate' | 'answer' | 'complete';
  slotToCollect?: SlotType;
  missingSlots?: SlotType[];
  prompt?: string;
  summary?: string;
  escalationReason?: string;
  workflow: WorkflowDefinition;
  context: WorkflowContext;
}

export class WorkflowEngine {
  private transitionLog: WorkflowTransition[] = [];

  classifyIntent(utterance: string): ClassificationResult {
    const normalizedUtterance = utterance.toLowerCase();
    const matchedKeywords: string[] = [];
    const intentScores: Record<IntentType, number> = {} as Record<IntentType, number>;

    for (const escalationKeyword of ESCALATION_KEYWORDS) {
      if (normalizedUtterance.includes(escalationKeyword.toLowerCase())) {
        console.log(`[WORKFLOW] ⚠️ Escalation keyword detected: "${escalationKeyword}"`);
        return {
          intent: 'urgent_medical',
          confidence: 'high',
          matchedKeywords: [escalationKeyword],
          requiresEscalation: true,
          escalationReason: `Urgent symptom detected: ${escalationKeyword}`,
        };
      }
    }

    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      if (intent === 'unknown') continue;
      
      let score = 0;
      const intentType = intent as IntentType;
      
      for (const keyword of keywords) {
        if (normalizedUtterance.includes(keyword.toLowerCase())) {
          score += keyword.split(' ').length;
          matchedKeywords.push(keyword);
        }
      }
      
      intentScores[intentType] = score;
    }

    const sortedIntents = Object.entries(intentScores)
      .filter(([_, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);

    if (sortedIntents.length === 0) {
      return {
        intent: 'unknown',
        confidence: 'low',
        matchedKeywords: [],
        requiresEscalation: false,
      };
    }

    const [topIntent, topScore] = sortedIntents[0];
    const confidence = topScore >= 3 ? 'high' : topScore >= 2 ? 'medium' : 'low';
    const intentType = topIntent as IntentType;

    const requiresEscalation = 
      intentType === 'urgent_medical' || 
      intentType === 'provider_call';

    return {
      intent: intentType,
      confidence,
      matchedKeywords,
      requiresEscalation,
      escalationReason: requiresEscalation 
        ? WORKFLOW_DEFINITIONS[intentType].description 
        : undefined,
    };
  }

  createContext(callId: string): WorkflowContext {
    return {
      callId,
      currentState: 'identify_intent',
      slots: {},
      stateHistory: [{
        state: 'identify_intent',
        timestamp: new Date(),
        slots: {},
      }],
    };
  }

  setIntent(context: WorkflowContext, intent: IntentType): WorkflowContext {
    const workflow = getWorkflowForIntent(intent);
    const newState: WorkflowState = workflow.escalationGuards.length > 0 &&
      workflow.escalationGuards.some(g => g.action === 'escalate')
        ? 'collect_identity'
        : 'collect_identity';

    const updatedContext: WorkflowContext = {
      ...context,
      currentIntent: intent,
      currentState: newState,
      stateHistory: [
        ...context.stateHistory,
        {
          state: newState,
          timestamp: new Date(),
          slots: { ...context.slots },
        },
      ],
    };

    this.logTransition(context.currentState, newState, `intent_set:${intent}`, updatedContext.slots);
    console.log(`[WORKFLOW] Intent set: ${intent} → State: ${newState}`);

    return updatedContext;
  }

  updateSlot(
    context: WorkflowContext, 
    slotName: SlotType, 
    value: string
  ): WorkflowContext {
    const normalizedValue = this.normalizeSlotValue(slotName, value);
    
    const updatedContext: WorkflowContext = {
      ...context,
      slots: {
        ...context.slots,
        [slotName]: normalizedValue,
      },
    };

    return this.advanceStateIfReady(updatedContext);
  }

  private advanceStateIfReady(context: WorkflowContext): WorkflowContext {
    if (!context.currentIntent) return context;

    const workflow = getWorkflowForIntent(context.currentIntent);
    const missingSlots = getMissingRequiredSlots(workflow, context.slots);

    const identitySlots = ['patient_first_name', 'patient_last_name', 'date_of_birth'];
    const identityComplete = identitySlots.every(
      slot => context.slots[slot as keyof typeof context.slots]
    );

    if (context.currentState === 'collect_identity' && identityComplete) {
      const hasDetailSlots = workflow.requiredSlots.some(
        s => !identitySlots.includes(s) && !context.slots[s as keyof typeof context.slots]
      );
      
      if (hasDetailSlots) {
        this.logTransition(context.currentState, 'collect_details', 'identity_complete', context.slots);
        console.log(`[WORKFLOW] State advanced: collect_identity → collect_details`);
        return {
          ...context,
          currentState: 'collect_details',
          stateHistory: [
            ...context.stateHistory,
            {
              state: 'collect_details',
              timestamp: new Date(),
              slots: { ...context.slots },
            },
          ],
        };
      }
    }

    if (missingSlots.length === 0 && context.currentState !== 'confirm_summary' && context.currentState !== 'complete') {
      const newState: WorkflowState = workflow.requiresTicket ? 'confirm_summary' : 'execute_action';
      this.logTransition(context.currentState, newState, 'all_slots_filled', context.slots);
      console.log(`[WORKFLOW] State advanced: ${context.currentState} → ${newState}`);
      return {
        ...context,
        currentState: newState,
        stateHistory: [
          ...context.stateHistory,
          {
            state: newState,
            timestamp: new Date(),
            slots: { ...context.slots },
          },
        ],
      };
    }

    return context;
  }

  private normalizeSlotValue(slotName: SlotType, value: string): string {
    const slotDef = SLOT_DEFINITIONS[slotName];
    
    if (slotDef?.transformer) {
      return slotDef.transformer(value);
    }

    if (slotName === 'callback_number') {
      return value.replace(/\D/g, '').slice(-10);
    }

    if (slotName === 'patient_first_name' || slotName === 'patient_last_name') {
      return value.trim().charAt(0).toUpperCase() + value.trim().slice(1).toLowerCase();
    }

    return value.trim();
  }

  getNextDirective(context: WorkflowContext): WorkflowDirective {
    if (!context.currentIntent) {
      return {
        action: 'collect_slot',
        prompt: 'What can I help you with today?',
        workflow: WORKFLOW_DEFINITIONS.unknown,
        context,
      };
    }

    const workflow = getWorkflowForIntent(context.currentIntent);

    if (workflow.escalationGuards.some(g => g.action === 'escalate')) {
      const quickSlots = getMissingRequiredSlots(workflow, context.slots);
      if (quickSlots.length > 0) {
        return {
          action: 'collect_slot',
          slotToCollect: quickSlots[0] as SlotType,
          missingSlots: quickSlots as SlotType[],
          prompt: SLOT_DEFINITIONS[quickSlots[0]]?.prompt || `What is your ${quickSlots[0].replace(/_/g, ' ')}?`,
          workflow,
          context,
        };
      }
      return {
        action: 'escalate',
        escalationReason: context.escalationReason || workflow.description,
        workflow,
        context,
      };
    }

    if (workflow.completionAction === 'answer_directly' && 
        context.currentIntent === 'general_question') {
      return {
        action: 'answer',
        workflow,
        context,
      };
    }

    const missingSlots = getMissingRequiredSlots(workflow, context.slots);

    if (missingSlots.length > 0) {
      const nextSlot = missingSlots[0] as SlotType;
      return {
        action: 'collect_slot',
        slotToCollect: nextSlot,
        missingSlots: missingSlots as SlotType[],
        prompt: SLOT_DEFINITIONS[nextSlot]?.prompt || `What is your ${nextSlot.replace(/_/g, ' ')}?`,
        workflow,
        context,
      };
    }

    if (context.currentState === 'confirm_summary' && workflow.requiresTicket) {
      return {
        action: 'confirm_summary',
        summary: this.buildSummary(context),
        workflow,
        context,
      };
    }

    return {
      action: 'execute',
      workflow,
      context,
    };
  }

  transitionToState(context: WorkflowContext, newState: WorkflowState, reason: string): WorkflowContext {
    this.logTransition(context.currentState, newState, reason, context.slots);
    
    return {
      ...context,
      currentState: newState,
      stateHistory: [
        ...context.stateHistory,
        {
          state: newState,
          timestamp: new Date(),
          slots: { ...context.slots },
        },
      ],
    };
  }

  markComplete(context: WorkflowContext): WorkflowContext {
    return {
      ...context,
      currentState: 'complete',
      completedAt: new Date(),
      stateHistory: [
        ...context.stateHistory,
        {
          state: 'complete',
          timestamp: new Date(),
          slots: { ...context.slots },
        },
      ],
    };
  }

  markEscalated(context: WorkflowContext, reason: string): WorkflowContext {
    return {
      ...context,
      currentState: 'escalate',
      escalationReason: reason,
      stateHistory: [
        ...context.stateHistory,
        {
          state: 'escalate',
          timestamp: new Date(),
          slots: { ...context.slots },
        },
      ],
    };
  }

  buildSummary(context: WorkflowContext): string {
    const { slots } = context;
    const parts: string[] = [];

    if (slots.patient_first_name && slots.patient_last_name) {
      parts.push(`${slots.patient_first_name} ${slots.patient_last_name}`);
    }
    if (slots.date_of_birth) {
      parts.push(`date of birth ${slots.date_of_birth}`);
    }
    if (slots.callback_number) {
      const formatted = this.formatPhone(slots.callback_number);
      parts.push(`callback ${formatted}`);
    }
    if (slots.contact_preference) {
      parts.push(`prefers ${slots.contact_preference}`);
    }
    if (slots.medication_name) {
      parts.push(`medication: ${slots.medication_name}`);
    }
    if (slots.pharmacy_name) {
      parts.push(`pharmacy: ${slots.pharmacy_name}`);
    }
    if (slots.doctor_name) {
      parts.push(`doctor: ${slots.doctor_name}`);
    }
    if (slots.request_summary) {
      parts.push(`request: ${slots.request_summary}`);
    }

    return parts.join(', ');
  }

  private formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return phone;
  }

  private logTransition(
    from: WorkflowState, 
    to: WorkflowState, 
    trigger: string, 
    slots: ConversationSlots
  ): void {
    const transition: WorkflowTransition = {
      fromState: from,
      toState: to,
      triggeredBy: trigger,
      timestamp: new Date(),
      slots: { ...slots },
    };
    this.transitionLog.push(transition);
    console.log(`[WORKFLOW] Transition: ${from} → ${to} (${trigger})`);
  }

  getTransitionLog(): WorkflowTransition[] {
    return [...this.transitionLog];
  }

  shouldEscalate(context: WorkflowContext): { 
    shouldEscalate: boolean; 
    reason?: string 
  } {
    if (!context.currentIntent) {
      return { shouldEscalate: false };
    }

    const workflow = getWorkflowForIntent(context.currentIntent);

    for (const guard of workflow.escalationGuards) {
      if (guard.action === 'escalate') {
        if (guard.type === 'intent_match' && 
            guard.config.intentTypes?.includes(context.currentIntent)) {
          return { 
            shouldEscalate: true, 
            reason: guard.message || workflow.description 
          };
        }
      }
    }

    return { shouldEscalate: false };
  }

  canAutoResolve(context: WorkflowContext): boolean {
    if (!context.currentIntent) return false;
    
    const workflow = getWorkflowForIntent(context.currentIntent);
    
    if (workflow.completionAction === 'answer_directly') {
      return true;
    }

    if (context.currentIntent === 'appointment_confirm' && 
        context.scheduleContext?.upcomingAppointments?.length) {
      return true;
    }

    return false;
  }
}

export const workflowEngine = new WorkflowEngine();
