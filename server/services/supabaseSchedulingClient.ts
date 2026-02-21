import { getEnvironmentConfig } from '../../src/config/environment';

interface ScheduleRow {
  ScheduleKey: number;
  DataSource: string;
  ApptID: string;
  AppointmentDateTime: string;
  AppointmentDate: string;
  AppointmentDayOfWeek: string;
  SessionPartOfDay: string;
  AppointmentStatus: string;
  PatientLastName: string;
  PatientFirstName: string;
  PatientDateOfBirth: string;
  PatientCellPhone: string;
  PatientHomePhone: string;
  PatientEmailAddress: string;
  OfficeLocation: string;
  RenderingPhysician: string;
  DoctorType: string;
  AppointmentCategory: string;
  ServiceCategory1?: string;
  [key: string]: any;
}

function getPacificDateString(): string {
  const now = new Date();
  const pacificFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = pacificFormatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year')?.value || '2024';
  const month = parts.find(p => p.type === 'month')?.value || '01';
  const day = parts.find(p => p.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

export class SupabaseSchedulingClient {
  private supabaseUrl: string;
  private serviceKey: string;
  private initialized = false;

  constructor() {
    this.supabaseUrl = "";
    this.serviceKey = "";
  }

  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }

    const envConfig = getEnvironmentConfig();
    const url = envConfig.supabase.restUrl;
    const key = envConfig.supabase.serviceKey;

    if (!url || !key) {
      throw new Error("SUPABASE_REST_URL and SUPABASE_SERVICE_KEY must be configured for schedule lookups");
    }

    this.supabaseUrl = url.trim().replace(/\/$/, "");
    this.serviceKey = key.trim();
    this.initialized = true;
    console.info("[SUPABASE CLIENT] Initialized REST API client for external scheduling database");
  }

  private async fetch(endpoint: string, options: RequestInit = {}): Promise<any> {
    this.ensureInitialized();
    
    const url = `${this.supabaseUrl}/rest/v1/${endpoint}`;
    const headers = {
      "apikey": this.serviceKey,
      "Authorization": `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      this.ensureInitialized();
      
      const result = await this.fetch("Schedule?select=ScheduleKey&limit=1");
      console.info("[SUPABASE CLIENT] Connection test successful");
      
      return {
        success: true,
        message: `Connected successfully via REST API. Schedule table accessible.`
      };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Connection test failed:", error);
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getAppointments(limit: number = 50): Promise<{ success: boolean; appointments?: ScheduleRow[]; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=ScheduleKey,ApptID,AppointmentDateTime,AppointmentDate,AppointmentDayOfWeek,SessionPartOfDay,AppointmentStatus,PatientFirstName,PatientLastName,PatientDateOfBirth,PatientCellPhone,PatientHomePhone,OfficeLocation,RenderingPhysician,DoctorType,AppointmentCategory&order=AppointmentDateTime.desc&limit=${limit}`
      );
      
      console.info(`[SUPABASE CLIENT] Retrieved ${result.length} appointments`);
      
      return { success: true, appointments: result as ScheduleRow[] };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get appointments:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async searchAppointmentsByPatient(patientName: string): Promise<{ success: boolean; appointments?: ScheduleRow[]; error?: string }> {
    try {
      const searchPattern = `%${patientName}%`;
      const result = await this.fetch(
        `Schedule?select=ScheduleKey,ApptID,AppointmentDateTime,AppointmentDate,AppointmentDayOfWeek,SessionPartOfDay,AppointmentStatus,PatientFirstName,PatientLastName,PatientDateOfBirth,PatientCellPhone,PatientHomePhone,OfficeLocation,RenderingPhysician,DoctorType,AppointmentCategory&or=(PatientFirstName.ilike.${encodeURIComponent(searchPattern)},PatientLastName.ilike.${encodeURIComponent(searchPattern)})&order=AppointmentDateTime.desc&limit=20`
      );
      
      console.info(`[SUPABASE CLIENT] Found ${result.length} appointments for patient: ${patientName}`);
      
      return { success: true, appointments: result as ScheduleRow[] };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to search appointments:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getAppointmentsByPatientDOB(firstName: string, lastName: string, dob: string): Promise<{ success: boolean; appointments?: ScheduleRow[]; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=ScheduleKey,ApptID,AppointmentDateTime,AppointmentDate,AppointmentDayOfWeek,SessionPartOfDay,AppointmentStatus,PatientFirstName,PatientLastName,PatientDateOfBirth,PatientCellPhone,PatientHomePhone,OfficeLocation,RenderingPhysician,DoctorType,AppointmentCategory&PatientFirstName=ilike.${encodeURIComponent(firstName + '%')}&PatientLastName=ilike.${encodeURIComponent(lastName + '%')}&PatientDateOfBirth=eq.${encodeURIComponent(dob)}&order=AppointmentDateTime.desc&limit=20`
      );
      
      console.info(`[SUPABASE CLIENT] Found ${result.length} appointments for ${firstName} ${lastName} (DOB: ${dob})`);
      
      return { success: true, appointments: result as ScheduleRow[] };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get appointments by DOB:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getAppointmentsByDate(date: string): Promise<{ success: boolean; appointments?: ScheduleRow[]; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=ScheduleKey,ApptID,AppointmentDateTime,AppointmentDate,AppointmentDayOfWeek,SessionPartOfDay,AppointmentStatus,PatientFirstName,PatientLastName,PatientDateOfBirth,PatientCellPhone,PatientHomePhone,OfficeLocation,RenderingPhysician,DoctorType,AppointmentCategory&AppointmentDate=eq.${encodeURIComponent(date)}&order=AppointmentDateTime.asc&limit=100`
      );
      
      console.info(`[SUPABASE CLIENT] Found ${result.length} appointments for date: ${date}`);
      
      return { success: true, appointments: result as ScheduleRow[] };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get appointments by date:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getUpcomingAppointments(patientFirstName: string, patientLastName: string): Promise<{ success: boolean; appointments?: ScheduleRow[]; error?: string }> {
    try {
      const today = getPacificDateString();
      const result = await this.fetch(
        `Schedule?select=ScheduleKey,ApptID,AppointmentDateTime,AppointmentDate,AppointmentDayOfWeek,SessionPartOfDay,AppointmentStatus,PatientFirstName,PatientLastName,PatientDateOfBirth,PatientCellPhone,PatientHomePhone,OfficeLocation,RenderingPhysician,DoctorType,AppointmentCategory&PatientFirstName=ilike.${encodeURIComponent(patientFirstName + '%')}&PatientLastName=ilike.${encodeURIComponent(patientLastName + '%')}&AppointmentDate=gte.${today}&AppointmentStatus=eq.Active&order=AppointmentDateTime.asc&limit=10`
      );
      
      console.info(`[SUPABASE CLIENT] Found ${result.length} upcoming appointments for ${patientFirstName} ${patientLastName} (Pacific date: ${today})`);
      
      return { success: true, appointments: result as ScheduleRow[] };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get upcoming appointments:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getAppointmentByApptId(apptId: string): Promise<{ success: boolean; appointment?: ScheduleRow; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=*&ApptID=eq.${encodeURIComponent(apptId)}`
      );
      
      if (result.length === 0) {
        return { success: false, error: "Appointment not found" };
      }
      
      console.info(`[SUPABASE CLIENT] Found appointment: ${apptId}`);
      
      return { success: true, appointment: result[0] as ScheduleRow };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get appointment:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getLocationSchedule(location: string, date: string): Promise<{ success: boolean; appointments?: ScheduleRow[]; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=ScheduleKey,ApptID,AppointmentDateTime,AppointmentDate,SessionPartOfDay,AppointmentStatus,PatientFirstName,PatientLastName,RenderingPhysician,AppointmentCategory&OfficeLocation=ilike.${encodeURIComponent('%' + location + '%')}&AppointmentDate=eq.${encodeURIComponent(date)}&order=AppointmentDateTime.asc&limit=100`
      );
      
      console.info(`[SUPABASE CLIENT] Found ${result.length} appointments at ${location} on ${date}`);
      
      return { success: true, appointments: result as ScheduleRow[] };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get location schedule:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getProviderSchedule(providerName: string, date: string): Promise<{ success: boolean; appointments?: ScheduleRow[]; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=ScheduleKey,ApptID,AppointmentDateTime,AppointmentDate,SessionPartOfDay,AppointmentStatus,PatientFirstName,PatientLastName,OfficeLocation,AppointmentCategory&RenderingPhysician=ilike.${encodeURIComponent('%' + providerName + '%')}&AppointmentDate=eq.${encodeURIComponent(date)}&order=AppointmentDateTime.asc&limit=100`
      );
      
      console.info(`[SUPABASE CLIENT] Found ${result.length} appointments for ${providerName} on ${date}`);
      
      return { success: true, appointments: result as ScheduleRow[] };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get provider schedule:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getDistinctLocations(): Promise<{ success: boolean; locations?: string[]; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=OfficeLocation&order=OfficeLocation&limit=1000`
      );
      
      const uniqueLocations = [...new Set(result.map((r: any) => r.OfficeLocation).filter(Boolean))] as string[];
      console.info(`[SUPABASE CLIENT] Found ${uniqueLocations.length} distinct locations`);
      
      return { success: true, locations: uniqueLocations };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get locations:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getDistinctProviders(): Promise<{ success: boolean; providers?: string[]; error?: string }> {
    try {
      const result = await this.fetch(
        `Schedule?select=RenderingPhysician&order=RenderingPhysician&limit=1000`
      );
      
      const uniqueProviders = [...new Set(result.map((r: any) => r.RenderingPhysician).filter(Boolean))] as string[];
      console.info(`[SUPABASE CLIENT] Found ${uniqueProviders.length} distinct providers`);
      
      return { success: true, providers: uniqueProviders };
    } catch (error) {
      console.error("[SUPABASE CLIENT] Failed to get providers:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  
  async close(): Promise<void> {
    this.initialized = false;
    console.info("[SUPABASE CLIENT] REST client reset");
  }
}

export const supabaseSchedulingClient = new SupabaseSchedulingClient();
