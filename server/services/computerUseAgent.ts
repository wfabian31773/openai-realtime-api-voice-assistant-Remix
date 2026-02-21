import { chromium, Browser, Page } from 'playwright';
import { workflowManager, type PatientData } from './schedulingWorkflowManager';
import { PHREESIA_CONFIG, type PatientType } from '../../src/config/phreesiaConfig';

const CUA_KEY_TO_PLAYWRIGHT_KEY: Record<string, string> = {
  '/': 'Divide',
  '\\': 'Backslash',
  alt: 'Alt',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  backspace: 'Backspace',
  capslock: 'CapsLock',
  cmd: 'Meta',
  ctrl: 'Control',
  delete: 'Delete',
  end: 'End',
  enter: 'Enter',
  esc: 'Escape',
  home: 'Home',
  insert: 'Insert',
  option: 'Alt',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  shift: 'Shift',
  space: ' ',
  super: 'Meta',
  tab: 'Tab',
  win: 'Meta',
};

export interface PhreesiaFormResult {
  success: boolean;
  confirmationNumber?: string;
  appointmentDetails?: {
    date: string;
    time: string;
    location: string;
    visitType: string;
  };
  error?: string;
  screenshots?: string[];
}

export class PhreesiaComputerUseAgent {
  private _browser: Browser | null = null;
  private _page: Page | null = null;
  private workflowId: string;
  private patientType: PatientType;
  private preferredLocation?: string;
  private readonly width = 1280;
  private readonly height = 800;
  private readonly phreesiaUrl = PHREESIA_CONFIG.schedulingUrl;

  constructor(workflowId: string, patientType: PatientType = 'new', preferredLocation?: string) {
    this.workflowId = workflowId;
    this.patientType = patientType;
    this.preferredLocation = preferredLocation;
  }

  private async captureScreenshot(step: string): Promise<string> {
    if (!this._page) throw new Error('Page not initialized');

    try {
      await this._page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const buffer = await this._page.screenshot({ fullPage: false });
      const base64 = Buffer.from(buffer).toString('base64');

      await workflowManager.captureScreenshot(this.workflowId, step, base64);

      return base64;
    } catch (err) {
      console.error(`[COMPUTER USE] Screenshot failed at step ${step}:`, err);
      return '';
    }
  }

  async init(): Promise<this> {
    console.info('[COMPUTER USE] Initializing browser...');

    this._browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      args: [`--window-size=${this.width},${this.height}`],
    });

    this._page = await this._browser.newPage();
    await this._page.setViewportSize({ width: this.width, height: this.height });

    console.info('[COMPUTER USE] ✓ Browser initialized');
    return this;
  }

  async dispose(): Promise<void> {
    console.info('[COMPUTER USE] Disposing browser...');
    if (this._browser) await this._browser.close();
    this._browser = null;
    this._page = null;
  }

  async fillPhreesiaForm(patientData: PatientData): Promise<PhreesiaFormResult> {
    if (!this._page) throw new Error('Page not initialized');

    const screenshots: string[] = [];

    try {
      console.info('[COMPUTER USE] Starting Phreesia form automation');
      await workflowManager.updateWorkflowStatus(this.workflowId, 'form_filling');

      await this._page.goto(this.phreesiaUrl, { waitUntil: 'networkidle' });
      screenshots.push(await this.captureScreenshot('landing_page'));

      await this.checkPauseState(); // Check if operator paused
      await workflowManager.updateWorkflowStep(this.workflowId, 'patient_type');
      await this.selectPatientType(this.patientType);
      screenshots.push(await this.captureScreenshot('patient_type_selected'));

      await this.checkPauseState(); // Check if operator paused
      await workflowManager.updateWorkflowStep(this.workflowId, 'location');
      await this.selectLocation(this.preferredLocation);
      screenshots.push(await this.captureScreenshot('location_selected'));

      await this.checkPauseState(); // Check if operator paused
      await workflowManager.updateWorkflowStep(this.workflowId, 'calendar');
      const dateTime = await this.selectDateTime(patientData);
      screenshots.push(await this.captureScreenshot('datetime_selected'));

      await this.checkPauseState(); // Check if operator paused
      await workflowManager.updateWorkflowStep(this.workflowId, 'patient_info');
      await this.fillPatientInfo(patientData);
      screenshots.push(await this.captureScreenshot('patient_info_filled'));

      await this.checkPauseState(); // Check if operator paused
      await workflowManager.updateWorkflowStep(this.workflowId, 'otp');
      await workflowManager.updateWorkflowStatus(this.workflowId, 'otp_requested');

      const otp = await workflowManager.requestOTP(this.workflowId, patientData.mobilePhone);
      console.info('[COMPUTER USE] OTP received from DRS agent');

      await this.checkPauseState(); // Check if operator paused
      await this.submitOTP(otp);
      screenshots.push(await this.captureScreenshot('otp_verified'));

      await this.checkPauseState(); // Check if operator paused
      await workflowManager.updateWorkflowStatus(this.workflowId, 'submitting');

      const confirmationData = await this.extractConfirmation();
      screenshots.push(await this.captureScreenshot('confirmation'));

      console.info('[COMPUTER USE] ✓ Form submitted successfully', confirmationData);

      return {
        success: true,
        confirmationNumber: confirmationData.confirmationNumber,
        appointmentDetails: confirmationData.appointmentDetails,
        screenshots,
      };

    } catch (error: any) {
      console.error('[COMPUTER USE] ✗ Form submission failed:', error);
      screenshots.push(await this.captureScreenshot('error_state').catch(() => ''));

      await workflowManager.recordError(
        this.workflowId,
        error.message || 'Unknown error',
        { stack: error.stack, screenshots }
      );

      return {
        success: false,
        error: error.message || 'Form automation failed',
        screenshots,
      };
    }
  }

  private async checkPauseState(): Promise<void> {
    const { storage } = await import('../storage');
    const workflow = await storage.getSchedulingWorkflow(this.workflowId);
    
    if (!workflow) {
      throw new Error('Workflow no longer exists');
    }
    
    // Halt immediately if workflow is in terminal state
    if (workflow.status === 'cancelled') {
      throw new Error('Workflow cancelled by operator');
    }
    
    if (workflow.status === 'failed') {
      throw new Error('Workflow marked as failed');
    }
    
    // If paused, poll until resumed or cancelled
    if (workflow.manualOverrideEnabled) {
      console.warn(`[COMPUTER USE] Workflow ${this.workflowId} paused by operator, waiting for resume...`);
      
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const updatedWorkflow = await storage.getSchedulingWorkflow(this.workflowId);
        
        if (!updatedWorkflow) {
          throw new Error('Workflow no longer exists');
        }
        
        // Check for terminal states while paused
        if (updatedWorkflow.status === 'cancelled') {
          throw new Error('Workflow cancelled by operator');
        }
        
        if (updatedWorkflow.status === 'failed') {
          throw new Error('Workflow marked as failed');
        }
        
        if (!updatedWorkflow.manualOverrideEnabled) {
          console.info(`[COMPUTER USE] Workflow ${this.workflowId} resumed by operator`);
          break;
        }
      }
    }
  }

  private async selectPatientType(type: 'new' | 'returning'): Promise<void> {
    if (!this._page) throw new Error('Page not initialized');

    console.info(`[COMPUTER USE] Selecting patient type: ${type}`);

    const selector = type === 'new' 
      ? 'input[value="NewPatient"], label:has-text("New Patient")'
      : 'input[value="ReturningPatient"], label:has-text("Returning Patient")';

    await this._page.click(selector, { timeout: 10000 });
    await this._page.click('button:has-text("Continue")');
    await this._page.waitForLoadState('networkidle');
  }

  private async selectLocation(preferredLocation?: string): Promise<void> {
    if (!this._page) throw new Error('Page not initialized');

    console.info('[COMPUTER USE] Selecting location (auto-populates provider)');

    await this._page.waitForSelector('select, [role="combobox"], [role="listbox"]', { timeout: 10000 });

    const locationDropdown = await this._page.$('select[name*="location"], select:has(option)');
    if (locationDropdown) {
      const options = await this._page.$$eval('select option', opts => 
        opts.map(opt => ({ value: (opt as HTMLOptionElement).value, text: opt.textContent?.trim() || '' }))
      );
      
      let selectedOption: { value: string; text: string } | undefined;
      
      if (preferredLocation) {
        selectedOption = options.find(opt => 
          opt.text.toLowerCase().includes(preferredLocation.toLowerCase()) ||
          preferredLocation.toLowerCase().includes(opt.text.toLowerCase())
        );
        if (selectedOption) {
          console.info(`[COMPUTER USE] Found preferred location: ${selectedOption.text}`);
        }
      }
      
      if (!selectedOption) {
        selectedOption = options.find(opt => opt.value && opt.value !== '' && opt.text !== 'Select location');
      }
      
      if (selectedOption) {
        await this._page.selectOption('select', selectedOption.value);
        console.info(`[COMPUTER USE] Selected location: ${selectedOption.text}`);
      } else {
        throw new Error('No available locations found in dropdown');
      }
    } else {
      const combobox = await this._page.$('[role="combobox"], [role="listbox"]');
      if (combobox) {
        await combobox.click();
        await this._page.waitForTimeout(500);
        
        if (preferredLocation) {
          const option = await this._page.$(`text="${preferredLocation}"`);
          if (option) {
            await option.click();
            console.info(`[COMPUTER USE] Selected location via combobox: ${preferredLocation}`);
          }
        } else {
          const firstOption = await this._page.$('[role="option"]:not([aria-disabled="true"])');
          if (firstOption) {
            const optionText = await firstOption.textContent();
            await firstOption.click();
            console.info(`[COMPUTER USE] Selected first available location: ${optionText}`);
          }
        }
      }
    }

    await this._page.waitForTimeout(2000);

    const searchButton = await this._page.$('button:has-text("Search Available")');
    if (searchButton) {
      await searchButton.click();
      await this._page.waitForLoadState('networkidle');
    }
  }

  private async selectDateTime(patientData: PatientData): Promise<{ date: string; time: string }> {
    if (!this._page) throw new Error('Page not initialized');

    console.info('[COMPUTER USE] Selecting date and time');

    await this._page.waitForSelector('button:has-text("Next Week"), div:has-text("Thu,"), div:has-text("Fri,")', { timeout: 10000 });

    const availableSlots = await this._page.$$('button[class*="appointment"], button:has-text("AM"), button:has-text("PM")');
    
    if (availableSlots.length === 0) {
      await this._page.click('button:has-text("Next Week")');
      await this._page.waitForTimeout(2000);
    }

    const firstSlot = await this._page.$('button[class*="appointment"]:not([disabled])');
    if (firstSlot) {
      const slotText = await firstSlot.textContent();
      await firstSlot.click();
      console.info(`[COMPUTER USE] Selected time slot: ${slotText}`);
      
      await this._page.waitForLoadState('networkidle');
      
      return { date: 'Selected from calendar', time: slotText || 'Unknown' };
    }

    throw new Error('No available appointment slots found');
  }

  private async fillPatientInfo(patientData: PatientData): Promise<void> {
    if (!this._page) throw new Error('Page not initialized');

    console.info('[COMPUTER USE] Filling patient information form');

    await this._page.waitForSelector('input[placeholder*="first name"], input[name*="firstName"]', { timeout: 10000 });

    await this._page.fill('input[placeholder*="first name"], input[name*="firstName"]', patientData.firstName);
    
    if (patientData.middleName) {
      await this._page.fill('input[placeholder*="middle"], input[name*="middleName"]', patientData.middleName).catch(() => {});
    }
    
    await this._page.fill('input[placeholder*="last name"], input[name*="lastName"]', patientData.lastName);

    await this._page.fill('input[type="date"], input[placeholder*="date of birth"]', patientData.dateOfBirth);

    const genderRadio = patientData.gender === 'male' 
      ? 'input[value="Male"], label:has-text("Male")'
      : 'input[value="Female"], label:has-text("Female")';
    await this._page.click(genderRadio);

    await this._page.fill('input[placeholder*="address"], input[name*="address"]', patientData.address);
    await this._page.fill('input[placeholder*="zip"], input[name*="zip"]', patientData.zip);
    await this._page.fill('input[placeholder*="city"], input[name*="city"]', patientData.city);

    const stateSelect = await this._page.$('select[name*="state"], select[name*="State"]');
    if (stateSelect) {
      await this._page.selectOption('select[name*="state"], select[name*="State"]', patientData.state);
    }

    await this._page.fill('input[type="tel"][placeholder*="home"], input[name*="homePhone"]', patientData.homePhone);
    await this._page.fill('input[type="tel"][placeholder*="mobile"], input[name*="mobilePhone"]', patientData.mobilePhone);

    if (patientData.email) {
      await this._page.fill('input[type="email"]', patientData.email);
    }

    const insuranceCompany = patientData.insuranceCompany || PHREESIA_CONFIG.insuranceFallback;

    const insuranceDropdown = await this._page.$('select[name*="insurance"], select[name*="Insurance"]');
    if (insuranceDropdown) {
      const insuranceOptions = await this._page.$$eval('select[name*="insurance"] option, select[name*="Insurance"] option', opts => 
        opts.map(opt => ({ value: (opt as HTMLOptionElement).value, text: opt.textContent?.trim() || '' }))
      );
      
      let selectedInsurance = insuranceOptions.find(opt => 
        opt.text.toLowerCase().includes(insuranceCompany.toLowerCase()) ||
        insuranceCompany.toLowerCase().includes(opt.text.toLowerCase())
      );
      
      if (!selectedInsurance) {
        selectedInsurance = insuranceOptions.find(opt => 
          opt.text.toLowerCase().includes('not listed') ||
          opt.text.toLowerCase().includes('other')
        );
        console.warn(`[COMPUTER USE] Insurance "${insuranceCompany}" not found, using fallback: ${selectedInsurance?.text}`);
      }
      
      if (selectedInsurance) {
        await this._page.selectOption('select[name*="insurance"], select[name*="Insurance"]', selectedInsurance.value);
        console.info(`[COMPUTER USE] Selected insurance: ${selectedInsurance.text}`);
      }
    }

    await this._page.click('button:has-text("Continue to Verification")');
    await this._page.waitForLoadState('networkidle');

    console.info('[COMPUTER USE] ✓ Patient info submitted');
  }

  private async submitOTP(otp: string): Promise<void> {
    if (!this._page) throw new Error('Page not initialized');

    console.info('[COMPUTER USE] Submitting OTP');

    await this._page.waitForSelector('input[placeholder*="code"], input[type="text"][maxlength="6"]', { timeout: 10000 });

    await this._page.fill('input[placeholder*="code"], input[type="text"]', otp);

    await this._page.click('button:has-text("Verify and book"), button:has-text("Verify")');
    await this._page.waitForLoadState('networkidle');

    const errorMessage = await this._page.textContent('text=invalid code, text=incorrect').catch(() => null);
    if (errorMessage) {
      throw new Error('Invalid OTP code');
    }

    console.info('[COMPUTER USE] ✓ OTP verified');
  }

  private async extractConfirmation(): Promise<{
    confirmationNumber?: string;
    appointmentDetails?: any;
  }> {
    if (!this._page) throw new Error('Page not initialized');

    console.info('[COMPUTER USE] Extracting confirmation details');

    await this._page.waitForSelector('text=appointment has been booked, text=confirmed', { timeout: 10000 });

    const pageText = await this._page.textContent('body');

    const confirmationNumber = pageText?.match(/confirmation.*?(\w{6,})/i)?.[1];

    const dateMatch = pageText?.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\w+\s+\d+/);
    const timeMatch = pageText?.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    const locationMatch = pageText?.match(/(Anaheim|Pawling|[A-Z][a-z]+)/);

    return {
      confirmationNumber,
      appointmentDetails: {
        date: dateMatch?.[0] || 'Unknown',
        time: timeMatch?.[0] || 'Unknown',
        location: locationMatch?.[0] || 'Unknown',
        visitType: 'Diabetic Screening',
      },
    };
  }
}
