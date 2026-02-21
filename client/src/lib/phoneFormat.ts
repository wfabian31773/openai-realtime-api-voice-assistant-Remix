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

/**
 * Format phone number with country code display
 * @param phoneNumber - Phone number in E.164 format
 * @returns Formatted with country code label (e.g., +1 (626) 222-9400)
 */
export function formatPhoneNumberWithCountry(phoneNumber: string | null | undefined): string {
  if (!phoneNumber) return 'No number assigned'
  
  const cleaned = phoneNumber.replace(/[^\d+]/g, '')
  const usMatch = cleaned.match(/^\+?1?(\d{3})(\d{3})(\d{4})$/)
  
  if (usMatch) {
    return `+1 (${usMatch[1]}) ${usMatch[2]}-${usMatch[3]}`
  }
  
  return phoneNumber
}

/**
 * Get the raw E.164 format from any phone number input
 * @param phoneNumber - Phone number in any format
 * @returns E.164 format (e.g., +16262229400) or null if invalid
 */
export function normalizePhoneNumber(phoneNumber: string | null | undefined): string | null {
  if (!phoneNumber) return null
  
  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, '')
  
  // Check if it's a valid US number (10 or 11 digits)
  if (digits.length === 10) {
    return `+1${digits}`
  } else if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  } else if (digits.length >= 11 && digits.length <= 15) {
    // International number
    return `+${digits}`
  }
  
  return null
}

/**
 * Validate if a phone number is in valid E.164 format
 * @param phoneNumber - Phone number to validate
 * @returns true if valid E.164 format
 */
export function isValidE164(phoneNumber: string | null | undefined): boolean {
  if (!phoneNumber) return false
  
  // E.164 format: +[country code][number] (max 15 digits total)
  const e164Regex = /^\+[1-9]\d{1,14}$/
  return e164Regex.test(phoneNumber)
}
