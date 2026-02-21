import type { SchedulingWorkflow } from '../../shared/schema';

export type WorkflowStatus = NonNullable<SchedulingWorkflow['status']>;

export const WORKFLOW_STATUSES = {
  initiated: 'initiated',
  collecting_data: 'collecting_data',
  form_filling: 'form_filling',
  otp_requested: 'otp_requested',
  otp_verified: 'otp_verified',
  submitting: 'submitting',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

const TERMINAL_STATUSES: Set<WorkflowStatus> = new Set([
  WORKFLOW_STATUSES.completed,
  WORKFLOW_STATUSES.failed,
  WORKFLOW_STATUSES.cancelled,
]);

const ALLOWED_TRANSITIONS: Partial<Record<WorkflowStatus, WorkflowStatus[]>> = {
  initiated: ['collecting_data', 'form_filling', 'cancelled', 'failed'],
  collecting_data: ['form_filling', 'otp_requested', 'cancelled', 'failed'],
  form_filling: ['otp_requested', 'cancelled', 'failed'],
  otp_requested: ['otp_verified', 'cancelled', 'failed'],
  otp_verified: ['submitting', 'cancelled', 'failed'],
  submitting: ['completed', 'cancelled', 'failed'],
  completed: ['initiated', 'collecting_data'], // Allow reopen for corrections
  failed: ['initiated', 'collecting_data'], // Allow retry
  cancelled: ['initiated', 'collecting_data'], // Allow reopen
};

export class WorkflowStateHelper {
  static isTerminal(status: WorkflowStatus | null): boolean {
    if (!status) return false;
    return TERMINAL_STATUSES.has(status);
  }

  static canTransition(from: WorkflowStatus | null, to: WorkflowStatus | null): boolean {
    if (!from || !to) return false;
    const allowedNext = ALLOWED_TRANSITIONS[from] || [];
    return allowedNext.includes(to);
  }

  static canPause(workflow: Pick<SchedulingWorkflow, 'status' | 'manualOverrideEnabled'>): {
    allowed: boolean;
    reason?: string;
  } {
    if (!workflow.status) {
      return { allowed: false, reason: 'Workflow status is missing' };
    }

    if (workflow.manualOverrideEnabled) {
      return { allowed: false, reason: 'Workflow is already paused' };
    }

    if (this.isTerminal(workflow.status)) {
      return { allowed: false, reason: `Cannot pause terminal workflow (${workflow.status})` };
    }

    return { allowed: true };
  }

  static canResume(workflow: Pick<SchedulingWorkflow, 'status' | 'manualOverrideEnabled'>): {
    allowed: boolean;
    reason?: string;
  } {
    if (!workflow.status) {
      return { allowed: false, reason: 'Workflow status is missing' };
    }

    if (!workflow.manualOverrideEnabled) {
      return { allowed: false, reason: 'Workflow is not paused' };
    }

    return { allowed: true };
  }

  static canCancel(workflow: Pick<SchedulingWorkflow, 'status'>): {
    allowed: boolean;
    reason?: string;
  } {
    if (!workflow.status) {
      return { allowed: false, reason: 'Workflow status is missing' };
    }

    if (workflow.status === WORKFLOW_STATUSES.cancelled) {
      return { allowed: false, reason: 'Workflow is already cancelled' };
    }

    return { allowed: true };
  }

  static validateOperatorAction(
    currentWorkflow: Pick<SchedulingWorkflow, 'status' | 'manualOverrideEnabled'>,
    updates: {
      status?: WorkflowStatus | null;
      manualOverrideEnabled?: boolean;
      operatorNotes?: string | null;
    }
  ): {
    valid: boolean;
    error?: string;
    warnings?: string[];
  } {
    const warnings: string[] = [];

    // Normalize null status to 'initiated' for legacy data migration
    const currentStatus = currentWorkflow.status || WORKFLOW_STATUSES.initiated;
    
    if (!currentWorkflow.status) {
      warnings.push('Workflow had null status (legacy data) - normalized to "initiated"');
    }

    // Validate status transition if changing status
    if (updates.status && updates.status !== currentStatus) {
      if (!this.canTransition(currentStatus, updates.status)) {
        // Check if it's a reopen scenario (terminal → active)
        const isReopen = this.isTerminal(currentStatus) && 
                         !this.isTerminal(updates.status);
        
        if (isReopen) {
          warnings.push(
            `Reopening workflow from terminal state ${currentStatus} → ${updates.status}`
          );
        } else {
          const allowedTransitions = ALLOWED_TRANSITIONS[currentStatus]?.join(', ') || 'none';
          return {
            valid: false,
            error: `Invalid transition: ${currentStatus} → ${updates.status}. Allowed: ${allowedTransitions}`,
          };
        }
      }
    }

    // Validate pause action
    if (updates.manualOverrideEnabled === true) {
      const pauseCheck = this.canPause(currentWorkflow);
      if (!pauseCheck.allowed) {
        return { valid: false, error: pauseCheck.reason };
      }
    }

    // Validate resume action (only if explicitly resuming without status change)
    if (updates.manualOverrideEnabled === false && !updates.status) {
      const resumeCheck = this.canResume(currentWorkflow);
      if (!resumeCheck.allowed) {
        return { valid: false, error: resumeCheck.reason };
      }
    }

    // Validate cancellation
    if (updates.status === WORKFLOW_STATUSES.cancelled) {
      const cancelCheck = this.canCancel(currentWorkflow);
      if (!cancelCheck.allowed) {
        return { valid: false, error: cancelCheck.reason };
      }
    }

    return { valid: true, warnings };
  }

  static getTransitionMetadata(
    from: WorkflowStatus | null,
    to: WorkflowStatus | null
  ): {
    isBackward: boolean;
    isReopen: boolean;
    isTerminating: boolean;
  } {
    if (!from || !to) {
      return {
        isBackward: false,
        isReopen: false,
        isTerminating: false,
      };
    }

    return {
      isBackward: this.isTerminal(from) && !this.isTerminal(to),
      isReopen: this.isTerminal(from) && !this.isTerminal(to),
      isTerminating: !this.isTerminal(from) && this.isTerminal(to),
    };
  }
}
