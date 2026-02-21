import { db } from '../../server/db';
import { 
  campaignContacts, 
  callbackQueue, 
  answeringServiceLogs,
  supportTickets,
  callLogs,
  InsertCallbackQueueItem,
  InsertAnsweringServiceLog,
  InsertSupportTicket
} from '../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';

export class CampaignAdapter {
  static async lookupPatient(campaignId: string, contactId: string) {
    try {
      const contact = await db
        .select()
        .from(campaignContacts)
        .where(
          and(
            eq(campaignContacts.campaignId, campaignId),
            eq(campaignContacts.id, contactId)
          )
        )
        .limit(1);

      if (!contact || contact.length === 0) {
        throw new Error(`Contact not found: ${contactId}`);
      }

      return {
        first_name: contact[0].firstName || '',
        last_name: contact[0].lastName || '',
        phone: contact[0].phoneNumber,
        email: contact[0].email,
        custom_data: contact[0].customData || {},
      };
    } catch (error) {
      console.error('[DB ERROR] lookupPatient:', error);
      throw error;
    }
  }

  static async markContactCompleted(
    contactId: string, 
    outcome: 'success' | 'failed' | 'no_answer',
    notes?: string
  ) {
    try {
      // Store full outcome details in custom_data for analytics
      const updateData: any = {
        contacted: true,
        successful: outcome === 'success',
        lastAttemptAt: new Date(),
        attempts: sql`${campaignContacts.attempts} + 1`,
      };

      // If notes provided, update customData with outcome details
      if (notes) {
        updateData.customData = sql`jsonb_set(
          COALESCE(${campaignContacts.customData}, '{}'::jsonb), 
          '{call_notes}', 
          ${JSON.stringify(notes)}::jsonb
        )`;
      }

      await db
        .update(campaignContacts)
        .set(updateData)
        .where(eq(campaignContacts.id, contactId));

      return { success: true };
    } catch (error) {
      console.error('[DB ERROR] markContactCompleted:', error);
      throw error;
    }
  }

  static async getAppointment(appointmentId: string) {
    try {
      const contact = await db
        .select()
        .from(campaignContacts)
        .where(eq(campaignContacts.id, appointmentId))
        .limit(1);

      if (!contact || contact.length === 0) {
        throw new Error(`Appointment not found: ${appointmentId}`);
      }

      const customData = contact[0].customData as any || {};
      
      return {
        appointment_id: contact[0].id,
        patient_name: `${contact[0].firstName} ${contact[0].lastName}`,
        phone: contact[0].phoneNumber,
        appointment_date: customData.appointment_date || 'Not specified',
        appointment_time: customData.appointment_time || 'Not specified',
        appointment_type: customData.appointment_type || 'General appointment',
        doctor: customData.doctor || 'Dr. Staff',
        location: customData.location || 'Azul Vision',
      };
    } catch (error) {
      console.error('[DB ERROR] getAppointment:', error);
      throw error;
    }
  }

  static async confirmAppointment(appointmentId: string) {
    try {
      await db
        .update(campaignContacts)
        .set({
          customData: sql`jsonb_set(COALESCE(${campaignContacts.customData}, '{}'::jsonb), '{confirmed}', 'true'::jsonb)`,
        })
        .where(eq(campaignContacts.id, appointmentId));

      return { success: true };
    } catch (error) {
      console.error('[DB ERROR] confirmAppointment:', error);
      throw error;
    }
  }

  static async rescheduleRequest(appointmentId: string, preferences: string) {
    try {
      await db
        .update(campaignContacts)
        .set({
          customData: sql`jsonb_set(COALESCE(${campaignContacts.customData}, '{}'::jsonb), '{reschedule_preferences}', ${JSON.stringify(preferences)}::jsonb)`,
        })
        .where(eq(campaignContacts.id, appointmentId));

      return { success: true };
    } catch (error) {
      console.error('[DB ERROR] rescheduleRequest:', error);
      throw error;
    }
  }

  static async cancelAppointment(appointmentId: string, reason?: string) {
    try {
      await db
        .update(campaignContacts)
        .set({
          customData: sql`jsonb_set(COALESCE(${campaignContacts.customData}, '{}'::jsonb), '{cancelled}', 'true'::jsonb)`,
        })
        .where(eq(campaignContacts.id, appointmentId));

      return { success: true };
    } catch (error) {
      console.error('[DB ERROR] cancelAppointment:', error);
      throw error;
    }
  }

  static async markConfirmed(
    appointmentId: string, 
    status: 'confirmed' | 'rescheduled' | 'cancelled' | 'no_answer' | 'wrong_number',
    notes?: string
  ) {
    try {
      // Preserve full status details for analytics
      const updateData: any = {
        contacted: true,
        successful: status === 'confirmed',
        lastAttemptAt: new Date(),
        customData: sql`jsonb_set(
          jsonb_set(
            COALESCE(${campaignContacts.customData}, '{}'::jsonb), 
            '{confirmation_status}', 
            ${JSON.stringify(status)}::jsonb
          ),
          '{confirmation_notes}',
          ${JSON.stringify(notes || '')}::jsonb
        )`,
      };

      await db
        .update(campaignContacts)
        .set(updateData)
        .where(eq(campaignContacts.id, appointmentId));

      return { success: true };
    } catch (error) {
      console.error('[DB ERROR] markConfirmed:', error);
      throw error;
    }
  }
}

export class CallbackQueueAdapter {
  static async addToQueue(data: {
    patient_name: string;
    patient_phone: string;
    patient_dob?: string;
    patient_email?: string;
    reason: string;
    priority?: 'stat' | 'urgent' | 'normal';
    notes?: string;
    call_log_id?: string;
  }) {
    try {
      const queueItem: InsertCallbackQueueItem = {
        patientName: data.patient_name,
        patientPhone: data.patient_phone,
        patientDob: data.patient_dob,
        patientEmail: data.patient_email,
        reason: data.reason,
        priority: data.priority || 'normal',
        notes: data.notes,
        callLogId: data.call_log_id,
        status: 'pending',
      };

      const result = await db.insert(callbackQueue).values(queueItem).returning();
      return { success: true, id: result[0].id };
    } catch (error) {
      console.error('[DB ERROR] addToCallbackQueue:', error);
      throw error;
    }
  }
}

export class AnsweringServiceAdapter {
  static async logRouting(data: {
    call_log_id?: string;
    department: 'optical' | 'surgery_coordinator' | 'clinical_tech';
    routing_reason: string;
    action: 'transferred' | 'message_taken' | 'callback_created' | 'ticket_created';
    staff_member?: string;
    message?: string;
    ticket_id?: string;
  }) {
    try {
      const log: InsertAnsweringServiceLog = {
        callLogId: data.call_log_id,
        department: data.department,
        routingReason: data.routing_reason,
        action: data.action,
        staffMemberContacted: data.staff_member,
        messageDetails: data.message,
        ticketId: data.ticket_id,
      };

      await db.insert(answeringServiceLogs).values(log);
      return { success: true };
    } catch (error) {
      console.error('[DB ERROR] logRouting:', error);
      throw error;
    }
  }

  static async takeMessage(data: {
    call_log_id?: string;
    department: 'optical' | 'surgery_coordinator' | 'clinical_tech';
    patient_name: string;
    phone: string;
    message: string;
  }) {
    try {
      await this.logRouting({
        call_log_id: data.call_log_id,
        department: data.department,
        routing_reason: 'Message taken',
        action: 'message_taken',
        message: `From: ${data.patient_name} (${data.phone})\nMessage: ${data.message}`,
      });

      return { success: true };
    } catch (error) {
      console.error('[DB ERROR] takeMessage:', error);
      throw error;
    }
  }

  static async createTicket(data: {
    patient_name: string;
    contact_info: string;
    department: 'optical' | 'surgery_coordinator' | 'clinical_tech';
    issue_summary: string;
    issue_details: string;
    priority: 'low' | 'medium' | 'high';
    call_log_id?: string;
  }) {
    try {
      const ticketNumber = `TICK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

      const ticket: InsertSupportTicket = {
        ticketNumber,
        patientName: data.patient_name,
        contactInfo: data.contact_info,
        department: data.department,
        issueSummary: data.issue_summary,
        issueDetails: data.issue_details,
        priority: data.priority,
        status: 'open',
        callLogId: data.call_log_id,
      };

      const result = await db.insert(supportTickets).values(ticket).returning();

      await this.logRouting({
        call_log_id: data.call_log_id,
        department: data.department,
        routing_reason: data.issue_summary,
        action: 'ticket_created',
        ticket_id: result[0].id,
      });

      return { 
        success: true, 
        ticket_id: result[0].id,
        ticket_number: ticketNumber 
      };
    } catch (error) {
      console.error('[DB ERROR] createTicket:', error);
      throw error;
    }
  }
}
