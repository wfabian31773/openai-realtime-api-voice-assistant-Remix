/**
 * Phone number formatting utilities
 * Converts E.164 format to human-readable format
 */

/**
 * Format a phone number from E.164 format to readable US format
 * @param phoneNumber - Phone number in E.164 format (e.g., +16262229400)
 * @returns Formatted phone number (e.g., (626) 222-9400) or original if invalid
 */
export function formatPhoneNumber(phoneNumber: string | null | undefined): string {
  if (!phoneNumber) return 'No number assigned'
  
  // Remove all non-digit characters except leading +
  const cleaned = phoneNumber.replace(/[^\d+]/g, '')
  
  // Check if it's E.164 format (starts with + and has 11-15 digits)
  const e164Match = cleaned.match(/^\+?1?(\d{3})(\d{3})(\d{4})$/)
  
  if (e164Match) {
    // US/Canada format: (XXX) XXX-XXXX
    return `(${e164Match[1]}) ${e164Match[2]}-${e164Match[3]}`
  }
  
  // International format - try to format as best we can
  const intlMatch = cleaned.match(/^\+(\d{1,3})(\d+)$/)
  if (intlMatch) {
    return `+${intlMatch[1]} ${intlMatch[2]}`
  }
  
  // Return original if no match
  return phoneNumber
}

