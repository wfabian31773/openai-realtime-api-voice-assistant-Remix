/**
 * Time-awareness utility for all agents
 * Provides current date/time in Pacific Coast timezone
 * 
 * IMPORTANT: Uses manual UTC offset calculation because Node.js on this host
 * may not have full ICU timezone data, causing toLocaleString timezone hints to be ignored.
 */

/**
 * Get current time in Pacific timezone using UTC offset calculation
 * Handles PST (UTC-8) and PDT (UTC-7) based on DST rules
 */
function getPacificTime(): Date {
  const now = new Date();
  const utcTime = now.getTime();
  
  // Determine if we're in PDT (Daylight Saving Time) or PST
  // PDT: Second Sunday of March (2 AM) to First Sunday of November (2 AM)
  const year = now.getUTCFullYear();
  
  // Calculate second Sunday of March
  // Formula: If March 1 is day X, first Sunday is 1 + (7-X)%7, second Sunday is that + 7
  const marchFirst = new Date(Date.UTC(year, 2, 1)); // March 1
  const marchFirstDay = marchFirst.getUTCDay(); // 0=Sun, 1=Mon, etc.
  const secondSundayMarchDate = 8 + (7 - marchFirstDay) % 7;
  // DST starts at 2 AM local (10 AM UTC for PST)
  const dstStart = new Date(Date.UTC(year, 2, secondSundayMarchDate, 10, 0, 0));
  
  // Calculate first Sunday of November
  const novFirst = new Date(Date.UTC(year, 10, 1)); // November 1
  const novFirstDay = novFirst.getUTCDay();
  const firstSundayNovDate = 1 + (7 - novFirstDay) % 7;
  // DST ends at 2 AM local (9 AM UTC for PDT)
  const dstEnd = new Date(Date.UTC(year, 10, firstSundayNovDate, 9, 0, 0));
  
  // Check if we're in DST
  const isDST = utcTime >= dstStart.getTime() && utcTime < dstEnd.getTime();
  
  // PDT = UTC-7, PST = UTC-8
  const offsetHours = isDST ? -7 : -8;
  const pacificTime = new Date(utcTime + offsetHours * 60 * 60 * 1000);
  
  return pacificTime;
}

/**
 * Get Pacific timezone info
 */
function getPacificTimeInfo(): { 
  hour: number; 
  dayOfWeek: string; 
  shortDay: string;
  fullDate: string;
  timeStr: string;
} {
  const pacific = getPacificTime();
  
  const hour = pacific.getUTCHours();
  const minute = pacific.getUTCMinutes();
  
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
  
  const dayIndex = pacific.getUTCDay();
  const dayOfWeek = days[dayIndex];
  const shortDay = shortDays[dayIndex];
  
  const month = months[pacific.getUTCMonth()];
  const date = pacific.getUTCDate();
  const year = pacific.getUTCFullYear();
  
  // Format time as "11:30 AM"
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const timeStr = `${hour12}:${minute.toString().padStart(2, '0')} ${ampm}`;
  
  const fullDate = `${dayOfWeek}, ${month} ${date}, ${year}`;
  
  return { hour, dayOfWeek, shortDay, fullDate, timeStr };
}

export function getPacificTimeContext(): string {
  const { dayOfWeek, fullDate, timeStr } = getPacificTimeInfo();

  return `Current Pacific Coast Time: ${fullDate} at ${timeStr}
Today is ${dayOfWeek}.
The time is ${timeStr}.

Use this information when:
- Answering questions about "today", "tomorrow", or relative dates
- Scheduling appointments or callbacks
- Determining if it's during business hours
- Providing time-sensitive information`;
}

/**
 * Get simple time string for logging
 */
export function getPacificTimeString(): string {
  const { fullDate, timeStr } = getPacificTimeInfo();
  return `${fullDate} ${timeStr}`;
}

/**
 * Check if current Pacific time is within business hours
 * Default: Monday-Friday, 8 AM - 5 PM Pacific
 */
export function isBusinessHours(
  startHour = 8,
  endHour = 17,
  excludeWeekends = true
): boolean {
  const { hour, shortDay } = getPacificTimeInfo();

  // Check if weekend
  if (excludeWeekends && (shortDay === 'Sat' || shortDay === 'Sun')) {
    return false;
  }

  // Check if within business hours
  return hour >= startHour && hour < endHour;
}

/**
 * Get time-of-day appropriate greeting
 * Returns "Good morning", "Good afternoon", or "Good evening"
 */
export function getTimeOfDayGreeting(): string {
  const { hour } = getPacificTimeInfo();
  
  if (hour < 12) {
    return 'Good morning';
  } else if (hour < 17) {
    return 'Good afternoon';
  } else {
    return 'Good evening';
  }
}

/**
 * Get the next business day name and context
 * 
 * For after-hours agents: If offices are closed (the reason we're using the answering service),
 * never say "later today" - always give the next business day/time.
 * 
 * Logic:
 * - Friday (any time after-hours) → Monday
 * - Saturday → Monday  
 * - Sunday → Monday
 * - Mon-Thu evening → Tomorrow
 * - Mon-Fri morning (before 8am) → Later this morning
 * - Mon-Thu during business hours but closed → Tomorrow
 * - Friday during business hours but closed → Monday
 */
export function getNextBusinessDayContext(): { dayName: string; contextPhrase: string } {
  const { hour, dayOfWeek, shortDay } = getPacificTimeInfo();
  
  // Saturday or Sunday → Monday
  if (shortDay === 'Sat' || shortDay === 'Sun') {
    return { dayName: 'Monday', contextPhrase: 'on Monday' };
  }
  
  // Friday (if offices are closed, callback is Monday)
  if (shortDay === 'Fri') {
    return { dayName: 'Monday', contextPhrase: 'on Monday' };
  }
  
  // Mon-Thu before 8am → Later this morning
  if (['Mon', 'Tue', 'Wed', 'Thu'].includes(shortDay) && hour < 8) {
    return { dayName: 'today', contextPhrase: 'later this morning when the office opens' };
  }
  
  // Mon-Thu during or after business hours → Next business day
  // User preference: Always say "next business day" to cover all angles (holidays, etc.)
  if (['Mon', 'Tue', 'Wed', 'Thu'].includes(shortDay)) {
    return { dayName: 'the next business day', contextPhrase: 'on the next business day' };
  }
  
  // Fallback
  return { dayName: 'the next business day', contextPhrase: 'on the next business day' };
}

/**
 * Get Spanish time-of-day greeting
 */
function getSpanishTimeOfDayGreeting(): string {
  const { hour } = getPacificTimeInfo();
  
  if (hour < 12) {
    return 'Buenos días';
  } else if (hour < 17) {
    return 'Buenas tardes';
  } else {
    return 'Buenas noches';
  }
}

/**
 * Get Spanish next business day context phrase
 */
function getSpanishNextBusinessDayPhrase(): string {
  const { shortDay } = getPacificTimeInfo();
  
  if (shortDay === 'Sat' || shortDay === 'Sun' || shortDay === 'Fri') {
    return 'el lunes';
  }
  if (['Mon', 'Tue', 'Wed', 'Thu'].includes(shortDay)) {
    const { hour } = getPacificTimeInfo();
    if (hour < 8) {
      return 'más tarde esta mañana cuando abra la oficina';
    }
    return 'el próximo día hábil';
  }
  return 'el próximo día hábil';
}

/**
 * Get the standard greeter opening greeting with time-of-day and next business day context
 * This is the hardcoded greeting that the greeter agent speaks immediately upon call entry
 * Supports both English and Spanish
 */
export function getGreeterOpeningGreeting(language: 'english' | 'spanish' = 'english'): string {
  if (language === 'spanish') {
    const timeGreeting = getSpanishTimeOfDayGreeting();
    const nextBizPhrase = getSpanishNextBusinessDayPhrase();
    
    return `${timeGreeting}, gracias por llamar a Azul Vision. Todas nuestras oficinas están cerradas actualmente. Soy del servicio de contestación, pero puedo ayudarle tomando un mensaje y asegurándome de que la persona adecuada le devuelva la llamada ${nextBizPhrase}. ¿En qué puedo ayudarle?`;
  }
  
  const timeGreeting = getTimeOfDayGreeting();
  const nextBizDay = getNextBusinessDayContext();
  
  return `${timeGreeting}, thank you for calling Azul Vision. All of our offices are currently closed. I'm with the answering service, but I can absolutely help by taking a message and making sure the right person gets back to you ${nextBizDay.contextPhrase}. How can I help?`;
}

/**
 * Format phone number for display (last 4 digits)
 */
export function formatPhoneLast4(phone: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 4) {
    return digits.slice(-4);
  }
  return digits;
}

/**
 * Format phone number for natural speech
 * e.g., +15551234567 → "555-123-4567"
 */
export function formatPhoneForSpeech(phone: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  // Handle 11-digit numbers (with country code)
  if (digits.length === 11 && digits.startsWith('1')) {
    const area = digits.slice(1, 4);
    const prefix = digits.slice(4, 7);
    const line = digits.slice(7);
    return `${area}-${prefix}-${line}`;
  }
  // Handle 10-digit numbers
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    const prefix = digits.slice(3, 6);
    const line = digits.slice(6);
    return `${area}-${prefix}-${line}`;
  }
  return phone;
}
