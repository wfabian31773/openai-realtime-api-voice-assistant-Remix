import { EventEmitter } from 'events';
import { storage } from '../storage';
import type { SchedulingWorkflow, InsertSchedulingWorkflow } from '../../shared/schema';
import { PHREESIA_CONFIG } from '../../src/config/phreesiaConfig';

export interface PatientData {
  firstName: string;
  lastName: string;
  middleName?: string;
  dateOfBirth: string;
  gender: 'male' | 'female';
  address: string;
  city: string;
  state: string;
  zip: string;
  homePhone: string;
  mobilePhone: string;
  email?: string;
  insuranceCompany?: string;
  policyId?: string;
  preferredDate?: string;
  preferredTime?: string;
}

export interface WorkflowEventMap {
  'workflow_created': { workflowId: string; callLogId: string };
  'status_changed': { workflowId: string; status: string; previousStatus: string };
  'step_changed': { workflowId: string; step: string; previousStep: string };
  'otp_requested': { workflowId: string; phoneNumber: string };
  'otp_collected': { workflowId: string; otp: string };
  'otp_verified': { workflowId: string; success: boolean };
  'form_submitted': { workflowId: string; success: boolean; confirmationNumber?: string; error?: string };
  'screenshot_captured': { workflowId: string; step: string; screenshot: string };
  'error_occurred': { workflowId: string; error: string; details: any };
  'fallback_triggered': { workflowId: string; reason: string };
  'manual_override': { workflowId: string; operatorId: string };
}

class SchedulingWorkflowManager extends EventEmitter {
  private activeWorkflows: Map<string, SchedulingWorkflow> = new Map();
  private otpPromises: Map<string, { resolve: (otp: string) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = new Map();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  async createWorkflow(data: {
    callLogId: string;
    campaignId?: string;
    contactId?: string;
    agentId: string;
    patientData: PatientData;
  }): Promise<SchedulingWorkflow> {
    console.info('[WORKFLOW MANAGER] Creating new scheduling workflow', {
      callLogId: data.callLogId,
      campaignId: data.campaignId,
    });

    const workflow = await storage.createSchedulingWorkflow({
      callLogId: data.callLogId,
      campaignId: data.campaignId || null,
      contactId: data.contactId || null,
      agentId: data.agentId,
      status: 'initiated',
      currentStep: 'patient_type',
      patientData: data.patientData as any,
      otpAttempts: 0,
      submissionSuccessful: false,
      fallbackLinkSent: false,
      manualOverrideEnabled: false,
      startedAt: new Date(),
    });

    this.activeWorkflows.set(workflow.id, workflow);

    this.emit('workflow_created', {
      workflowId: workflow.id,
      callLogId: data.callLogId,
    });

    console.info(`[WORKFLOW MANAGER] ✓ Workflow created: ${workflow.id}`);
    return workflow;
  }

  async updateWorkflowStatus(
    workflowId: string,
    status: SchedulingWorkflow['status']
  ): Promise<void> {
    // Validate status is a known value to prevent typos
    const { WorkflowStateHelper, WORKFLOW_STATUSES } = await import('./workflowStateHelper');
    const validStatuses = Object.values(WORKFLOW_STATUSES);
    
    if (status && !validStatuses.includes(status as any)) {
      console.error(`[WORKFLOW MANAGER] Invalid status attempted: ${status}. Allowed: ${validStatuses.join(', ')}`);
      throw new Error(`Invalid workflow status: ${status}`);
    }

    const currentWorkflow = this.activeWorkflows.get(workflowId);
    const previousStatus = currentWorkflow?.status;

    await storage.updateSchedulingWorkflow(workflowId, { status });

    const updated = await storage.getSchedulingWorkflow(workflowId);
    if (updated) {
      this.activeWorkflows.set(workflowId, updated);
    }

    this.emit('status_changed', {
      workflowId,
      status,
      previousStatus: previousStatus || 'unknown',
    });

    console.info(`[WORKFLOW MANAGER] Status updated: ${workflowId} → ${status}`);
  }

  async updateWorkflowStep(
    workflowId: string,
    step: string
  ): Promise<void> {
    const currentWorkflow = this.activeWorkflows.get(workflowId);
    const previousStep = currentWorkflow?.currentStep;

    await storage.updateSchedulingWorkflow(workflowId, { currentStep: step });

    const updated = await storage.getSchedulingWorkflow(workflowId);
    if (updated) {
      this.activeWorkflows.set(workflowId, updated);
    }

    this.emit('step_changed', {
      workflowId,
      step,
      previousStep: previousStep || 'unknown',
    });

    console.info(`[WORKFLOW MANAGER] Step updated: ${workflowId} → ${step}`);
  }

  async requestOTP(workflowId: string, phoneNumber: string): Promise<string> {
    console.info(`[WORKFLOW MANAGER] Requesting OTP for workflow: ${workflowId}`);
    console.info(`[WORKFLOW MANAGER] OTP will be sent to: ${phoneNumber}`);
    console.info(`[WORKFLOW MANAGER] Patient has ~${PHREESIA_CONFIG.otpWaitBeforePromptMs / 1000} seconds to receive SMS and read code to agent`);

    await storage.updateSchedulingWorkflow(workflowId, {
      otpRequested: true,
      otpRequestedAt: new Date(),
      otpAttempts: (this.activeWorkflows.get(workflowId)?.otpAttempts || 0) + 1,
    });

    this.emit('otp_requested', {
      workflowId,
      phoneNumber,
    });

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.otpPromises.delete(workflowId);
        reject(new Error(`OTP request timeout (${PHREESIA_CONFIG.otpTimeoutMs / 1000} seconds). Patient may not have received SMS.`));
      }, PHREESIA_CONFIG.otpTimeoutMs);

      this.otpPromises.set(workflowId, { resolve, reject, timeout });
    });
  }

  async submitOTP(workflowId: string, otp: string): Promise<void> {
    console.info(`[WORKFLOW MANAGER] OTP submitted for workflow: ${workflowId}`);

    const promise = this.otpPromises.get(workflowId);
    if (promise) {
      clearTimeout(promise.timeout);
      promise.resolve(otp);
      this.otpPromises.delete(workflowId);

      await storage.updateSchedulingWorkflow(workflowId, {
        otpVerified: true,
        otpVerifiedAt: new Date(),
      });

      this.emit('otp_verified', {
        workflowId,
        success: true,
      });
    } else {
      console.warn(`[WORKFLOW MANAGER] No pending OTP request for workflow: ${workflowId}`);
    }
  }

  async captureScreenshot(
    workflowId: string,
    step: string,
    screenshotBase64: string
  ): Promise<void> {
    const workflow = this.activeWorkflows.get(workflowId);
    const existingScreenshots = (workflow?.screenshots as any) || [];

    const newScreenshot = {
      step,
      timestamp: new Date().toISOString(),
      base64: screenshotBase64,
    };

    const updatedScreenshots = [...existingScreenshots, newScreenshot];

    await storage.updateSchedulingWorkflow(workflowId, {
      screenshots: updatedScreenshots as any,
    });

    this.emit('screenshot_captured', {
      workflowId,
      step,
      screenshot: screenshotBase64,
    });

    console.info(`[WORKFLOW MANAGER] Screenshot captured: ${workflowId} @ ${step}`);
  }

  async recordError(
    workflowId: string,
    error: string,
    details: any
  ): Promise<void> {
    console.error(`[WORKFLOW MANAGER] Error in workflow ${workflowId}:`, error);

    await storage.updateSchedulingWorkflow(workflowId, {
      status: 'failed',
      errorDetails: { error, details, timestamp: new Date().toISOString() } as any,
    });

    this.emit('error_occurred', {
      workflowId,
      error,
      details,
    });
  }

  async triggerFallback(
    workflowId: string,
    reason: string
  ): Promise<void> {
    console.warn(`[WORKFLOW MANAGER] Triggering fallback for workflow ${workflowId}: ${reason}`);

    await storage.updateSchedulingWorkflow(workflowId, {
      fallbackLinkSent: true,
      status: 'failed',
    });

    this.emit('fallback_triggered', {
      workflowId,
      reason,
    });
  }

  async completeWorkflow(
    workflowId: string,
    success: boolean,
    confirmationNumber?: string,
    appointmentDetails?: any
  ): Promise<void> {
    console.info(`[WORKFLOW MANAGER] Completing workflow ${workflowId}: success=${success}`);

    await storage.updateSchedulingWorkflow(workflowId, {
      status: success ? 'completed' : 'failed',
      submissionSuccessful: success,
      phreesiaConfirmationNumber: confirmationNumber || null,
      phreesiaAppointmentDetails: appointmentDetails || null,
      completedAt: new Date(),
    });

    this.emit('form_submitted', {
      workflowId,
      success,
      confirmationNumber,
      error: success ? undefined : 'Form submission failed',
    });

    this.activeWorkflows.delete(workflowId);
  }

  async enableManualOverride(
    workflowId: string,
    operatorId: string,
    notes?: string
  ): Promise<void> {
    console.info(`[WORKFLOW MANAGER] Manual override enabled: ${workflowId} by ${operatorId}`);

    await storage.updateSchedulingWorkflow(workflowId, {
      manualOverrideEnabled: true,
      operatorId,
      operatorNotes: notes || null,
    });

    this.emit('manual_override', {
      workflowId,
      operatorId,
    });
  }

  getActiveWorkflow(workflowId: string): SchedulingWorkflow | undefined {
    return this.activeWorkflows.get(workflowId);
  }

  getAllActiveWorkflows(): SchedulingWorkflow[] {
    return Array.from(this.activeWorkflows.values());
  }
}

export const workflowManager = new SchedulingWorkflowManager();
