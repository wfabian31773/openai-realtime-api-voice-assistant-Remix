/**
 * Custom error classes for structured error handling
 */

/**
 * Validation error for operator actions on scheduling workflows
 * Returns 400 HTTP status code
 */
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
    // Maintain proper prototype chain
    Object.setPrototypeOf(this, WorkflowValidationError.prototype);
  }
}

/**
 * Type guard to check if error is a WorkflowValidationError
 */
export function isWorkflowValidationError(error: unknown): error is WorkflowValidationError {
  return error instanceof WorkflowValidationError || 
         (error as any)?.name === 'WorkflowValidationError';
}
