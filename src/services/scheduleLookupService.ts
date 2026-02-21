import { db } from '../../server/db';
import { schedule } from '../../shared/schema';
import { eq, or, desc, gte, ilike, and, sql } from 'drizzle-orm';

export interface PatientScheduleContext {
  patientFound: boolean;
  patientName?: string;
  matchedBy?: 'phone' | 'name' | 'dob' | 'name_and_dob';
  upcomingAppointments: AppointmentSummary[];
  pastAppointments: AppointmentSummary[];
  lastProviderSeen?: string;
  lastLocationSeen?: string;
  lastVisitDate?: string;
  totalAppointmentsFound: number;
  patientData?: PatientData;
}

export interface PatientData {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  email?: string;
  cellPhone?: string;
  homePhone?: string;
  preferredLocation?: string;
  preferredProvider?: string;
}

export interface AppointmentSummary {
  date: string;
  isoDate: string;
  dayOfWeek: string;
  timeOfDay: string;
  startTime?: string;
  endTime?: string;
  location: string;
  provider: string;
  status: string;
  appointmentType?: string;
  category?: string;
}

function getPacificDate(): Date {
  const now = new Date();
  const pacificFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = pacificFormatter.formatToParts(now);
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '2024');
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '1') - 1;
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '1');
  return new Date(year, month, day);
}

function getPacificDateString(): string {
  const date = getPacificDate();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T12:00:00');
    return date.toLocaleDateString('en-US', { 
      weekday: 'long',
      month: 'long', 
      day: 'numeric', 
      year: 'numeric' 
    });
  } catch {
    return dateStr;
  }
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

function formatTimeString(timeStr: string | null | undefined): string | undefined {
  if (!timeStr) return undefined;
  
  try {
    let hours: number;
    let minutes: number;
    
    if (timeStr.includes(':')) {
      [hours, minutes] = timeStr.split(':').map(Number);
    } else if (/^\d{3,4}$/.test(timeStr)) {
      const padded = timeStr.padStart(4, '0');
      hours = parseInt(padded.slice(0, 2), 10);
      minutes = parseInt(padded.slice(2, 4), 10);
    } else {
      return undefined;
    }
    
    if (isNaN(hours) || isNaN(minutes) || hours > 23 || minutes > 59) return undefined;
    
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch {
    return undefined;
  }
}

function formatAppointmentTime(appointmentDateTime: Date | string | null | undefined, sessionPartOfDay?: string): string {
  if (!appointmentDateTime) {
    return sessionPartOfDay || 'Unknown';
  }
  
  try {
    const date = appointmentDateTime instanceof Date 
      ? appointmentDateTime 
      : new Date(appointmentDateTime);
    
    if (isNaN(date.getTime())) {
      return sessionPartOfDay || 'Unknown';
    }
    
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    
    return timeFormatter.format(date);
  } catch {
    return sessionPartOfDay || 'Unknown';
  }
}

// Month name to number mapping for natural language date parsing
const MONTH_MAP: Record<string, string> = {
  'jan': '01', 'january': '01',
  'feb': '02', 'february': '02',
  'mar': '03', 'march': '03',
  'apr': '04', 'april': '04',
  'may': '05',
  'jun': '06', 'june': '06',
  'jul': '07', 'july': '07',
  'aug': '08', 'august': '08',
  'sep': '09', 'sept': '09', 'september': '09',
  'oct': '10', 'october': '10',
  'nov': '11', 'november': '11',
  'dec': '12', 'december': '12',
};

function normalizeDOB(dob: string): string {
  if (!dob) return '';
  
  const cleaned = dob.trim();
  
  // Already in ISO format YYYY-MM-DD - validate before returning
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    if (isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return cleaned;
    }
    console.warn(`[normalizeDOB] Invalid ISO date: ${cleaned}`);
    return '';
  }
  
  // MM/DD/YYYY format
  const mmddyyyy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) {
    const [, month, day, year] = mmddyyyy;
    if (isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // MM/DD/YY format (with smart year windowing)
  const mmddyy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mmddyy) {
    const [, month, day, shortYear] = mmddyy;
    const fullYear = parseInt(shortYear) > 30 ? `19${shortYear}` : `20${shortYear}`;
    if (isValidDate(parseInt(fullYear), parseInt(month), parseInt(day))) {
      return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // MM-DD-YYYY format
  const mmddyyyyDash = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mmddyyyyDash) {
    const [, month, day, year] = mmddyyyyDash;
    if (isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // Natural language: "March 12, 1975" or "March 12 1975" or "Mar 12, 1975"
  const naturalLang = cleaned.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (naturalLang) {
    const [, monthName, day, year] = naturalLang;
    const month = MONTH_MAP[monthName.toLowerCase()];
    if (month && isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }
  
  // Natural language: "12 March 1975" or "12 Mar 1975"
  const naturalLangReverse = cleaned.match(/^(\d{1,2})\s+([a-zA-Z]+),?\s+(\d{4})$/i);
  if (naturalLangReverse) {
    const [, day, monthName, year] = naturalLangReverse;
    const month = MONTH_MAP[monthName.toLowerCase()];
    if (month && isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }
  
  // Natural language with 2-digit year: "March 12, 75" or "Mar 12 75"
  const naturalLang2Digit = cleaned.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{2})$/i);
  if (naturalLang2Digit) {
    const [, monthName, day, shortYear] = naturalLang2Digit;
    const month = MONTH_MAP[monthName.toLowerCase()];
    const fullYear = parseInt(shortYear) > 30 ? `19${shortYear}` : `20${shortYear}`;
    if (month && isValidDate(parseInt(fullYear), parseInt(month), parseInt(day))) {
      return `${fullYear}-${month}-${day.padStart(2, '0')}`;
    }
  }
  
  // Try JavaScript's Date parser as fallback
  try {
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = parsed.getMonth() + 1;
      const day = parsed.getDate();
      // Only accept if year is reasonable (1900-2025 for DOBs)
      if (year >= 1900 && year <= new Date().getFullYear()) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  } catch {
    // Fall through
  }
  
  console.warn(`[normalizeDOB] Unable to parse date: ${cleaned}`);
  return '';
}

// Validate that month (1-12) and day (1-31 depending on month) are in range
function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 1900 || year > new Date().getFullYear()) return false;
  
  // Check days in month
  const daysInMonth = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month]) return false;
  
  return true;
}

export class ScheduleLookupService {
  
  async lookupByPhone(phone: string): Promise<PatientScheduleContext> {
    const normalizedPhone = normalizePhone(phone);
    
    if (normalizedPhone.length < 10) {
      return this.emptyContext();
    }

    try {
      const appointments = await db.select()
        .from(schedule)
        .where(
          or(
            eq(schedule.patientCellPhone, normalizedPhone),
            eq(schedule.patientHomePhone, normalizedPhone)
          )
        )
        .orderBy(desc(schedule.appointmentDate))
        .limit(20);
      
      if (appointments.length === 0) {
        console.log(`[ScheduleLookup] No appointments found for phone: ${normalizedPhone.slice(-4)}`);
        return this.emptyContext();
      }

      console.log(`[ScheduleLookup] Found ${appointments.length} appointments for phone ending in ${normalizedPhone.slice(-4)}`);
      return this.buildContext(appointments, 'phone');
      
    } catch (error) {
      console.error('[ScheduleLookup] Error looking up by phone:', error);
      return this.emptyContext();
    }
  }

  async lookupByName(firstName: string, lastName: string): Promise<PatientScheduleContext> {
    try {
      const normalizedFirst = firstName.trim().toLowerCase();
      const normalizedLast = lastName.trim().toLowerCase();
      
      const appointments = await db.select()
        .from(schedule)
        .where(
          and(
            ilike(schedule.patientLastName, `${normalizedLast}%`),
            ilike(schedule.patientFirstName, `${normalizedFirst.substring(0, 3)}%`)
          )
        )
        .orderBy(desc(schedule.appointmentDate))
        .limit(20);

      if (appointments.length === 0) {
        return this.emptyContext();
      }

      console.log(`[ScheduleLookup] Found ${appointments.length} appointments for ${firstName} ${lastName}`);
      return this.buildContext(appointments, 'name');
      
    } catch (error) {
      console.error('[ScheduleLookup] Error looking up by name:', error);
      return this.emptyContext();
    }
  }

  async lookupByNameAndDOB(firstName: string, lastName: string, dob: string): Promise<PatientScheduleContext> {
    try {
      const normalizedFirst = firstName.trim().toLowerCase();
      const normalizedLast = lastName.trim().toLowerCase();
      const normalizedDOB = normalizeDOB(dob);
      
      if (!normalizedDOB) {
        console.warn('[ScheduleLookup] Invalid DOB format:', dob);
        return this.emptyContext();
      }
      
      const appointments = await db.select()
        .from(schedule)
        .where(
          and(
            ilike(schedule.patientLastName, `${normalizedLast}%`),
            ilike(schedule.patientFirstName, `${normalizedFirst.substring(0, 3)}%`),
            eq(schedule.patientDateOfBirth, normalizedDOB)
          )
        )
        .orderBy(desc(schedule.appointmentDate))
        .limit(20);
      
      if (appointments.length === 0) {
        return this.emptyContext();
      }

      console.log(`[ScheduleLookup] Found ${appointments.length} appointments for ${firstName} ${lastName} (DOB: ${normalizedDOB})`);
      return this.buildContext(appointments, 'name_and_dob');
      
    } catch (error) {
      console.error('[ScheduleLookup] Error looking up by name and DOB:', error);
      return this.emptyContext();
    }
  }

  async lookupPatient(params: {
    phone?: string;
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
  }): Promise<PatientScheduleContext> {
    const { phone, firstName, lastName, dateOfBirth } = params;

    if (firstName && lastName && dateOfBirth) {
      const result = await this.lookupByNameAndDOB(firstName, lastName, dateOfBirth);
      if (result.patientFound) return result;
    }

    if (phone) {
      const result = await this.lookupByPhone(phone);
      if (result.patientFound) return result;
    }

    if (firstName && lastName) {
      const result = await this.lookupByName(firstName, lastName);
      if (result.patientFound) return result;
    }

    return this.emptyContext();
  }

  private buildContext(appointments: any[], matchedBy: 'phone' | 'name' | 'dob' | 'name_and_dob'): PatientScheduleContext {
    const todayStr = getPacificDateString();

    const upcoming: AppointmentSummary[] = [];
    const past: AppointmentSummary[] = [];

    for (const apt of appointments) {
      const aptDateStr = apt.appointmentDate || '';
      const aptDate = aptDateStr ? new Date(aptDateStr + 'T12:00:00') : new Date();
      
      const summary: AppointmentSummary = {
        date: formatDate(aptDateStr),
        isoDate: aptDateStr,
        dayOfWeek: aptDate.toLocaleDateString('en-US', { weekday: 'long' }),
        timeOfDay: formatTimeString(apt.appointmentStart) || apt.sessionPartOfDay || 'Unknown',
        startTime: formatTimeString(apt.appointmentStart),
        endTime: formatTimeString(apt.appointmentEnd),
        location: apt.officeLocation || 'Unknown',
        provider: apt.renderingPhysician || 'Unknown',
        status: apt.appointmentStatus || 'Unknown',
        appointmentType: apt.serviceCategory1 || undefined,
        category: apt.serviceCategory1, // Using serviceCategory1 instead of removed appointmentCategory
      };

      const isUpcoming = aptDateStr >= todayStr && apt.appointmentStatus === 'Active';
      if (isUpcoming) {
        upcoming.push(summary);
      } else {
        past.push(summary);
      }
    }

    upcoming.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    past.sort((a, b) => b.isoDate.localeCompare(a.isoDate));

    const lastProviderSeen = past[0]?.provider !== 'Unknown' ? past[0]?.provider : undefined;
    const lastLocationSeen = past[0]?.location !== 'Unknown' ? past[0]?.location : undefined;

    const firstApt = appointments[0];
    const patientName = `${firstApt.patientFirstName || ''} ${firstApt.patientLastName || ''}`.trim();

    const patientData: PatientData = {
      firstName: firstApt.patientFirstName || undefined,
      lastName: firstApt.patientLastName || undefined,
      dateOfBirth: firstApt.patientDateOfBirth || undefined,
      email: firstApt.patientEmailAddress || undefined,
      cellPhone: firstApt.patientCellPhone || undefined,
      homePhone: firstApt.patientHomePhone || undefined,
      preferredLocation: lastLocationSeen || firstApt.officeLocation || undefined,
      preferredProvider: lastProviderSeen || firstApt.renderingPhysician || undefined,
    };

    return {
      patientFound: true,
      patientName: patientName || undefined,
      matchedBy,
      upcomingAppointments: upcoming.slice(0, 5),
      pastAppointments: past.slice(0, 5),
      lastProviderSeen,
      lastLocationSeen,
      lastVisitDate: past[0]?.date,
      totalAppointmentsFound: appointments.length,
      patientData,
    };
  }

  private emptyContext(): PatientScheduleContext {
    return {
      patientFound: false,
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 0,
    };
  }

  formatContextForAgent(context: PatientScheduleContext): string {
    if (!context.patientFound) {
      return 'No appointment history found for this patient. They may be a new patient or calling from a different phone number.';
    }

    const parts: string[] = [];
    
    parts.push(`Patient: ${context.patientName || 'Unknown'}`);
    parts.push(`Total appointments in system: ${context.totalAppointmentsFound}`);

    if (context.upcomingAppointments.length > 0) {
      parts.push('\nUPCOMING APPOINTMENTS:');
      context.upcomingAppointments.forEach((apt, i) => {
        let timeInfo = apt.startTime || apt.timeOfDay;
        if (apt.startTime && apt.endTime) {
          timeInfo = `${apt.startTime} - ${apt.endTime}`;
        }
        parts.push(`  ${i + 1}. ${apt.date} (${timeInfo}) at ${apt.location} with ${apt.provider}`);
        if (apt.appointmentType) parts.push(`     Appointment Type: ${apt.appointmentType}`);
      });
    } else {
      parts.push('\nNo upcoming appointments scheduled.');
    }

    if (context.pastAppointments.length > 0) {
      parts.push('\nRECENT VISITS:');
      context.pastAppointments.slice(0, 3).forEach((apt, i) => {
        parts.push(`  ${i + 1}. ${apt.date} at ${apt.location} with ${apt.provider}`);
      });
    }

    if (context.lastLocationSeen) {
      parts.push(`\nLast location seen: ${context.lastLocationSeen}`);
    }
    if (context.lastProviderSeen) {
      parts.push(`Last provider seen: ${context.lastProviderSeen}`);
    }

    return parts.join('\n');
  }
}

export const scheduleLookupService = new ScheduleLookupService();
