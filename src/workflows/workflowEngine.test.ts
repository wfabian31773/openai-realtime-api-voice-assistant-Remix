import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from './workflowEngine';
import { IntentType } from './workflowTypes';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine();
  });

  describe('classifyIntent', () => {
    it('classifies appointment confirmation correctly', () => {
      const result = engine.classifyIntent('I want to confirm my appointment');
      expect(result.intent).toBe('appointment_confirm');
      expect(result.requiresEscalation).toBe(false);
    });

    it('classifies new appointment scheduling', () => {
      const result = engine.classifyIntent('I need to schedule an appointment');
      expect(result.intent).toBe('appointment_schedule');
      expect(result.requiresEscalation).toBe(false);
    });

    it('classifies medication refill', () => {
      const result = engine.classifyIntent('I need a refill on my eye drops');
      expect(result.intent).toBe('medication_refill');
      expect(result.requiresEscalation).toBe(false);
    });

    it('classifies billing question', () => {
      const result = engine.classifyIntent('I have a question about my bill');
      expect(result.intent).toBe('billing_question');
      expect(result.requiresEscalation).toBe(false);
    });

    it('classifies general question about hours', () => {
      const result = engine.classifyIntent('what are your hours?');
      expect(result.intent).toBe('general_question');
      expect(result.requiresEscalation).toBe(false);
    });

    it('triggers escalation for vision loss', () => {
      const result = engine.classifyIntent("I can't see out of my right eye");
      expect(result.intent).toBe('urgent_medical');
      expect(result.requiresEscalation).toBe(true);
      expect(result.escalationReason).toBeDefined();
    });

    it('triggers escalation for severe pain', () => {
      const result = engine.classifyIntent('I have severe eye pain');
      expect(result.intent).toBe('urgent_medical');
      expect(result.requiresEscalation).toBe(true);
    });

    it('triggers escalation for chemical exposure', () => {
      const result = engine.classifyIntent('I got chemical in my eye');
      expect(result.intent).toBe('urgent_medical');
      expect(result.requiresEscalation).toBe(true);
    });

    it('triggers escalation for injury', () => {
      const result = engine.classifyIntent('I have an eye injury');
      expect(result.intent).toBe('urgent_medical');
      expect(result.requiresEscalation).toBe(true);
    });

    it('triggers escalation for flashes and floaters', () => {
      const result = engine.classifyIntent('I am seeing flashes and floaters');
      expect(result.intent).toBe('urgent_medical');
      expect(result.requiresEscalation).toBe(true);
    });

    it('does NOT escalate for "I want to speak to someone"', () => {
      const result = engine.classifyIntent('I want to speak to someone');
      expect(result.requiresEscalation).toBe(false);
    });

    it('returns unknown for unclear statements', () => {
      const result = engine.classifyIntent('hello');
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe('low');
    });
  });

  describe('createContext and setIntent', () => {
    it('creates context with identify_intent state', () => {
      const context = engine.createContext('test-call-123');
      expect(context.callId).toBe('test-call-123');
      expect(context.currentState).toBe('identify_intent');
      expect(context.currentIntent).toBeUndefined();
    });

    it('sets intent and transitions to collect_identity', () => {
      const context = engine.createContext('test-call-123');
      const updated = engine.setIntent(context, 'appointment_schedule');
      
      expect(updated.currentIntent).toBe('appointment_schedule');
      expect(updated.currentState).toBe('collect_identity');
      expect(updated.stateHistory.length).toBeGreaterThan(1);
    });

    it('logs transitions', () => {
      const context = engine.createContext('test-call-123');
      engine.setIntent(context, 'medication_refill');
      
      const log = engine.getTransitionLog();
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].toState).toBe('collect_identity');
    });
  });

  describe('updateSlot', () => {
    it('normalizes phone numbers', () => {
      const context = engine.createContext('test-call-123');
      const updated = engine.updateSlot(context, 'callback_number', '(626) 222-9400');
      
      expect(updated.slots.callback_number).toBe('6262229400');
    });

    it('capitalizes names', () => {
      const context = engine.createContext('test-call-123');
      let updated = engine.updateSlot(context, 'patient_first_name', 'john');
      updated = engine.updateSlot(updated, 'patient_last_name', 'SMITH');
      
      expect(updated.slots.patient_first_name).toBe('John');
      expect(updated.slots.patient_last_name).toBe('Smith');
    });
  });

  describe('getNextDirective', () => {
    it('returns collect_slot when intent not set', () => {
      const context = engine.createContext('test-call-123');
      const directive = engine.getNextDirective(context);
      
      expect(directive.action).toBe('collect_slot');
    });

    it('returns missing slots for appointment workflow', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'appointment_schedule');
      
      const directive = engine.getNextDirective(context);
      
      expect(directive.action).toBe('collect_slot');
      expect(directive.missingSlots).toContain('patient_first_name');
    });

    it('returns escalate for urgent_medical', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'urgent_medical');
      context = engine.updateSlot(context, 'patient_first_name', 'John');
      context = engine.updateSlot(context, 'callback_number', '6262229400');
      
      const directive = engine.getNextDirective(context);
      
      expect(directive.action).toBe('escalate');
    });

    it('returns execute when all slots filled', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'appointment_cancel');
      context = engine.updateSlot(context, 'patient_first_name', 'John');
      context = engine.updateSlot(context, 'patient_last_name', 'Smith');
      context = engine.updateSlot(context, 'date_of_birth', '01/15/1980');
      
      const directive = engine.getNextDirective(context);
      
      expect(directive.action).toBe('confirm_summary');
    });
  });

  describe('shouldEscalate', () => {
    it('returns true for urgent_medical', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'urgent_medical');
      
      const result = engine.shouldEscalate(context);
      expect(result.shouldEscalate).toBe(true);
    });

    it('returns true for provider_call', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'provider_call');
      
      const result = engine.shouldEscalate(context);
      expect(result.shouldEscalate).toBe(true);
    });

    it('returns false for appointment requests', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'appointment_schedule');
      
      const result = engine.shouldEscalate(context);
      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe('buildSummary', () => {
    it('builds readable summary from slots', () => {
      let context = engine.createContext('test-call-123');
      context = engine.updateSlot(context, 'patient_first_name', 'John');
      context = engine.updateSlot(context, 'patient_last_name', 'Smith');
      context = engine.updateSlot(context, 'date_of_birth', '01/15/1980');
      context = engine.updateSlot(context, 'callback_number', '6262229400');
      
      const summary = engine.buildSummary(context);
      
      expect(summary).toContain('John Smith');
      expect(summary).toContain('626-222-9400');
      expect(summary).toContain('01/15/1980');
    });
  });

  describe('state advancement', () => {
    it('advances from collect_identity to collect_details after identity slots filled', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'medication_refill');
      expect(context.currentState).toBe('collect_identity');
      
      context = engine.updateSlot(context, 'patient_first_name', 'John');
      context = engine.updateSlot(context, 'patient_last_name', 'Smith');
      context = engine.updateSlot(context, 'date_of_birth', '01/15/1980');
      
      expect(context.currentState).toBe('collect_details');
    });

    it('advances to confirm_summary when all required slots filled', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'medication_refill');
      
      context = engine.updateSlot(context, 'patient_first_name', 'John');
      context = engine.updateSlot(context, 'patient_last_name', 'Smith');
      context = engine.updateSlot(context, 'date_of_birth', '01/15/1980');
      context = engine.updateSlot(context, 'callback_number', '6262229400');
      context = engine.updateSlot(context, 'medication_name', 'Latanoprost');
      context = engine.updateSlot(context, 'pharmacy_name', 'CVS');
      
      expect(context.currentState).toBe('confirm_summary');
    });

    it('logs state transitions as slots are collected', () => {
      let context = engine.createContext('test-call-123');
      context = engine.setIntent(context, 'appointment_schedule');
      
      context = engine.updateSlot(context, 'patient_first_name', 'Jane');
      context = engine.updateSlot(context, 'patient_last_name', 'Doe');
      context = engine.updateSlot(context, 'date_of_birth', '05/20/1975');
      context = engine.updateSlot(context, 'callback_number', '8185551234');
      
      expect(context.stateHistory.length).toBeGreaterThanOrEqual(3);
      const states = context.stateHistory.map(h => h.state);
      expect(states).toContain('identify_intent');
      expect(states).toContain('collect_identity');
      expect(states).toContain('confirm_summary');
    });

    it('simulates full appointment flow through tool calls', () => {
      let context = engine.createContext('test-call-123');
      
      const classification = engine.classifyIntent('I need to schedule an appointment');
      expect(classification.intent).toBe('appointment_schedule');
      
      context = engine.setIntent(context, classification.intent);
      expect(context.currentState).toBe('collect_identity');
      
      let directive = engine.getNextDirective(context);
      expect(directive.action).toBe('collect_slot');
      expect(directive.missingSlots).toContain('patient_first_name');
      
      context = engine.updateSlot(context, 'patient_first_name', 'Alice');
      context = engine.updateSlot(context, 'patient_last_name', 'Johnson');
      context = engine.updateSlot(context, 'date_of_birth', '03/12/1990');
      
      expect(context.currentState).toBe('collect_details');
      
      context = engine.updateSlot(context, 'callback_number', '3105559999');
      
      expect(context.currentState).toBe('confirm_summary');
      
      directive = engine.getNextDirective(context);
      expect(directive.action).toBe('confirm_summary');
    });

    it('escalation workflow collects minimal info then escalates', () => {
      let context = engine.createContext('test-call-123');
      
      const classification = engine.classifyIntent("I can't see, I'm losing my vision");
      expect(classification.intent).toBe('urgent_medical');
      expect(classification.requiresEscalation).toBe(true);
      
      context = engine.setIntent(context, classification.intent);
      
      let directive = engine.getNextDirective(context);
      expect(directive.action).toBe('collect_slot');
      expect(directive.missingSlots).toContain('patient_first_name');
      
      context = engine.updateSlot(context, 'patient_first_name', 'Emergency');
      context = engine.updateSlot(context, 'callback_number', '9115551212');
      
      directive = engine.getNextDirective(context);
      expect(directive.action).toBe('escalate');
    });
  });
});
