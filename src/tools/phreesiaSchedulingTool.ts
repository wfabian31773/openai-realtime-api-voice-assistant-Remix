import { tool } from '@openai/agents';
import { z } from 'zod';
import { workflowManager, type PatientData } from '../../server/services/schedulingWorkflowManager';
import { PhreesiaComputerUseAgent } from '../../server/services/computerUseAgent';
import { PHREESIA_CONFIG } from '../config/phreesiaConfig';

export interface PhreesiaSchedulingContext {
  callLogId: string;
  campaignId?: string;
  contactId?: string;
  agentId: string;
}

// Global workflowId storage for OTP submission (keyed by callLogId)
const activeWorkflowsByCall = new Map<string, string>();

export function createPhreesiaSchedulingTool(context: PhreesiaSchedulingContext) {
  return tool({
    name: 'schedule_patient_in_phreesia',
    description: `Start automatic filling of the Phreesia DRS scheduling form at ${PHREESIA_CONFIG.schedulingUrl}. This tool will navigate the form and PAUSE when it needs the OTP code. The OTP is sent via SMS to the patient's mobile phone. Wait about ${PHREESIA_CONFIG.otpWaitBeforePromptMs / 1000} seconds for the patient to receive it, then ask them to read the 6-digit code. Use submit_otp_code tool to continue after getting the code.`,
    parameters: z.object({
      patient_type: z.enum(['new', 'returning']).describe('Whether this is a new patient or returning patient'),
      preferred_location: z.string().nullable().optional().describe(`Preferred Azul Vision location. Available: ${PHREESIA_CONFIG.locations.slice(0, 5).join(', ')}, and more.`),
      patient_data: z.object({
        firstName: z.string().describe('Patient first name'),
        lastName: z.string().describe('Patient last name'),
        middleName: z.string().nullable().optional().describe('Patient middle name'),
        dateOfBirth: z.string().describe('Date of birth in MM/DD/YYYY format'),
        gender: z.enum(['male', 'female']).describe('Patient gender'),
        address: z.string().describe('Street address'),
        city: z.string().describe('City'),
        state: z.string().describe('Two-letter state code (e.g., CA)'),
        zip: z.string().describe('ZIP code'),
        homePhone: z.string().describe('Home phone number'),
        mobilePhone: z.string().describe('Mobile phone number (for OTP verification)'),
        email: z.string().nullable().optional().describe('Email address'),
        insuranceCompany: z.string().nullable().optional().describe('Insurance company name. Use "Not Listed" if not found.'),
        preferredDate: z.string().nullable().optional().describe('Preferred appointment date'),
        preferredTime: z.string().nullable().optional().describe('Preferred appointment time (e.g., morning, afternoon)'),
      }).describe('Patient information collected from the voice call'),
    }),
    execute: async ({ patient_type, preferred_location, patient_data }) => {
      console.info('[PHREESIA TOOL] Starting form automation', {
        patient: `${patient_data.firstName} ${patient_data.lastName}`,
        patientType: patient_type,
        preferredLocation: preferred_location,
        callLogId: context.callLogId,
      });

      try {
        const workflow = await workflowManager.createWorkflow({
          callLogId: context.callLogId,
          campaignId: context.campaignId,
          contactId: context.contactId,
          agentId: context.agentId,
          patientData: patient_data as PatientData,
        });

        console.info(`[PHREESIA TOOL] Workflow created: ${workflow.id}`);

        activeWorkflowsByCall.set(context.callLogId, workflow.id);

        const computerAgent = new PhreesiaComputerUseAgent(workflow.id, patient_type, preferred_location ?? undefined);
        await computerAgent.init();

        try {
          const result = await computerAgent.fillPhreesiaForm(patient_data as PatientData);

          activeWorkflowsByCall.delete(context.callLogId);

          if (result.success) {
            await workflowManager.completeWorkflow(
              workflow.id,
              true,
              result.confirmationNumber,
              result.appointmentDetails
            );

            const details = result.appointmentDetails;
            return `✓ Appointment scheduled successfully!\n\nConfirmation: ${result.confirmationNumber || 'Pending'}\nDate: ${details?.date}\nTime: ${details?.time}\nLocation: ${details?.location}\n\nThe patient will receive a confirmation text message.`;
          } else {
            await workflowManager.completeWorkflow(workflow.id, false);

            return `✗ Unable to complete scheduling automatically. Error: ${result.error}\n\nPlease provide the patient with this link to schedule manually:\nhttps://z1-rpw.phreesia.net/ApptRequestForm.App/#/form/19a8be99-e9e4-4346-b7c7-3dd5feacc494`;
          }
        } finally {
          await computerAgent.dispose();
        }

      } catch (error: any) {
        console.error('[PHREESIA TOOL] Error:', error);
        activeWorkflowsByCall.delete(context.callLogId);

        return `✗ Scheduling automation encountered an error: ${error.message}\n\nPlease provide the patient with this manual scheduling link:\nhttps://z1-rpw.phreesia.net/ApptRequestForm.App/#/form/19a8be99-e9e4-4346-b7c7-3dd5feacc494\n\nOur staff will follow up to assist with scheduling.`;
      }
    },
  });
}


export function createSubmitOTPTool(context: PhreesiaSchedulingContext) {
  return tool({
    name: 'submit_otp_code',
    description: 'Submit the 6-digit OTP code that the patient read to you. Call this immediately after the patient tells you the verification code they received via text message.',
    parameters: z.object({
      otp_code: z.string().describe('The 6-digit OTP code spoken by the patient (e.g., "543210" or "5-4-3-2-1-0")'),
    }),
    execute: async ({ otp_code }) => {
      const normalizedOTP = otp_code.replace(/\D/g, '').substring(0, 6);

      if (normalizedOTP.length !== 6) {
        return `✗ Invalid OTP format. Expected 6 digits, got: "${otp_code}". Please ask the patient to read the code again.`;
      }

      const workflowId = activeWorkflowsByCall.get(context.callLogId);
      
      if (!workflowId) {
        return `✗ No active scheduling session found. Please start the scheduling process first using schedule_patient_in_phreesia.`;
      }

      console.info('[OTP TOOL] Submitting OTP to workflow', { workflowId, callLogId: context.callLogId, otp: normalizedOTP });

      try {
        await workflowManager.submitOTP(workflowId, normalizedOTP);
        return `✓ OTP code verified! The form is now completing the scheduling process... Please wait a moment.`;
      } catch (error: any) {
        console.error('[OTP TOOL] OTP submission failed:', error);
        return `✗ OTP verification failed: ${error.message}. Please ask the patient if they can read the code again, or we can provide a manual scheduling link.`;
      }
    },
  });
}
