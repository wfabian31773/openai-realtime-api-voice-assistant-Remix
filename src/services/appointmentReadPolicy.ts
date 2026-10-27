/** The same read-only appointment rule on every patient-facing intake lane. */
export function appointmentReadPolicy(toolName: string): string {
  return `Before an appointment request, use ${toolName}. Use its existing result if already available; do not re-ask known identity details. Never claim no appointment access when available. Review bookings to avoid a duplicate. Validate provider and office on the SAME booking; clarify differences. A failed read is not empty. Read-only: never book, change or cancel.`;
}

/** Detailed instructions live in the tool description, keeping lane prompts small. */
export function appointmentReadReminder(toolName: string): string {
  return `Before an appointment request, use ${toolName}.`;
}
