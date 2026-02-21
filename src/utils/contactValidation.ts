/**
 * Contact Validation Utility
 * 
 * Provides tool-level validation for contact information
 * to ensure data integrity before persistence to database.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

/**
 * Validate phone number in E.164 format
 * Example: +12345678900
 */
export function validatePhoneNumber(phone: string): ValidationResult {
  const trimmed = phone.trim();
  
  // E.164 format: + followed by 1-15 digits
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  
  if (!e164Regex.test(trimmed)) {
    return {
      valid: false,
      error: 'Phone number must be in E.164 format (e.g., +12345678900). It should start with + followed by country code and number.',
    };
  }
  
  return {
    valid: true,
    sanitized: trimmed,
  };
}

/**
 * Validate email address format
 */
export function validateEmail(email: string): ValidationResult {
  const trimmed = email.trim().toLowerCase();
  
  // RFC 5322 compliant email regex (simplified)
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  
  if (!emailRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Email address is invalid. Please provide a valid email (e.g., patient@example.com).',
    };
  }
  
  if (trimmed.length > 254) {
    return {
      valid: false,
      error: 'Email address is too long (max 254 characters).',
    };
  }
  
  return {
    valid: true,
    sanitized: trimmed,
  };
}

/**
 * Validate date of birth
 * Accepts formats: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD
 * Ensures date is in the past and person is < 150 years old
 */
export function validateDateOfBirth(dob: string): ValidationResult {
  const trimmed = dob.trim();
  
  // Try parsing various date formats
  let parsedDate: Date | null = null;
  
  // Format: MM/DD/YYYY or MM-DD-YYYY
  const mdyRegex = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
  const mdyMatch = trimmed.match(mdyRegex);
  
  if (mdyMatch) {
    const [, month, day, year] = mdyMatch;
    parsedDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }
  
  // Format: YYYY-MM-DD
  const ymdRegex = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  const ymdMatch = trimmed.match(ymdRegex);
  
  if (ymdMatch) {
    const [, year, month, day] = ymdMatch;
    parsedDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }
  
  if (!parsedDate || isNaN(parsedDate.getTime())) {
    return {
      valid: false,
      error: 'Date of birth is invalid. Please provide in format MM/DD/YYYY (e.g., 05/15/1980).',
    };
  }
  
  // Validate date is in the past
  const now = new Date();
  if (parsedDate > now) {
    return {
      valid: false,
      error: 'Date of birth cannot be in the future. Please provide a valid past date.',
    };
  }
  
  // Validate person is < 150 years old (reasonable limit)
  const age = now.getFullYear() - parsedDate.getFullYear();
  if (age > 150) {
    return {
      valid: false,
      error: 'Date of birth seems too far in the past. Please verify the year.',
    };
  }
  
  // Validate person is at least born
  if (age < 0) {
    return {
      valid: false,
      error: 'Date of birth is invalid.',
    };
  }
  
  // Return standardized format YYYY-MM-DD
  const sanitized = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;
  
  return {
    valid: true,
    sanitized,
  };
}

/**
 * Validate name (first or last)
 * Must be non-empty, reasonable length, no numbers
 */
export function validateName(name: string, fieldName: string = 'Name'): ValidationResult {
  const trimmed = name.trim();
  
  if (trimmed.length === 0) {
    return {
      valid: false,
      error: `${fieldName} cannot be empty.`,
    };
  }
  
  if (trimmed.length < 2) {
    return {
      valid: false,
      error: `${fieldName} must be at least 2 characters long.`,
    };
  }
  
  if (trimmed.length > 100) {
    return {
      valid: false,
      error: `${fieldName} is too long (max 100 characters).`,
    };
  }
  
  // Allow letters, spaces, hyphens, apostrophes (common in names)
  const nameRegex = /^[a-zA-Z\s'-]+$/;
  if (!nameRegex.test(trimmed)) {
    return {
      valid: false,
      error: `${fieldName} contains invalid characters. Only letters, spaces, hyphens, and apostrophes are allowed.`,
    };
  }
  
  return {
    valid: true,
    sanitized: trimmed,
  };
}

/**
 * Validate patient contact information (all fields)
 * Returns object with validation results for each field
 */
export interface ContactValidation {
  valid: boolean;
  errors: string[];
  sanitized?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    dob?: string;
  };
}

export function validatePatientContact(contact: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  dob?: string;
}): ContactValidation {
  const errors: string[] = [];
  const sanitized: any = {};
  
  // Validate first name
  if (contact.firstName) {
    const result = validateName(contact.firstName, 'First name');
    if (!result.valid) {
      errors.push(result.error!);
    } else {
      sanitized.firstName = result.sanitized;
    }
  }
  
  // Validate last name
  if (contact.lastName) {
    const result = validateName(contact.lastName, 'Last name');
    if (!result.valid) {
      errors.push(result.error!);
    } else {
      sanitized.lastName = result.sanitized;
    }
  }
  
  // Validate phone number
  if (contact.phone) {
    const result = validatePhoneNumber(contact.phone);
    if (!result.valid) {
      errors.push(result.error!);
    } else {
      sanitized.phone = result.sanitized;
    }
  }
  
  // Validate email (optional field)
  if (contact.email) {
    const result = validateEmail(contact.email);
    if (!result.valid) {
      errors.push(result.error!);
    } else {
      sanitized.email = result.sanitized;
    }
  }
  
  // Validate date of birth
  if (contact.dob) {
    const result = validateDateOfBirth(contact.dob);
    if (!result.valid) {
      errors.push(result.error!);
    } else {
      sanitized.dob = result.sanitized;
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    sanitized: errors.length === 0 ? sanitized : undefined,
  };
}
