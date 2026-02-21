# End-to-End Testing Guide: DRS Outbound Scheduler with Computer Use

**Last Updated:** November 24, 2025  
**Status:** MVP Complete, Production Refinements Identified

---

## Overview

This guide provides comprehensive testing procedures for the DRS Outbound Scheduler agent, which uses Computer Use (Playwright browser automation) to fill the Phreesia self-scheduling form in real-time during patient conversations.

### System Architecture

```
┌──────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  DRS Voice   │─────▶│ Workflow Manager │─────▶│ Computer Use    │
│  Agent       │      │  (Event Bus)     │      │ Agent (Browser) │
│  (OpenAI)    │◀─────│                  │◀─────│                 │
└──────────────┘      └──────────────────┘      └─────────────────┘
       │                      │                         │
       ▼                      ▼                         ▼
  submit_otp_code        requestOTP()            fillPhreesiaForm()
  (Voice Tool)          Promise<string>          Playwright Steps
```

**Key Components:**
- **DRS Scheduler Agent** (`src/agents/drsSchedulerAgent.ts`) - Voice-based patient interaction
- **Phreesia Scheduling Tool** (`src/tools/phreesiaSchedulingTool.ts`) - Orchestrates form automation
- **Computer Use Agent** (`server/services/computerUseAgent.ts`) - Browser automation with Playwright
- **Workflow Manager** (`server/services/schedulingWorkflowManager.ts`) - Event bus coordinating OTP exchange
- **Operator Dashboard** (`client/src/pages/SchedulingMonitorPage.tsx`) - Live monitoring and manual controls

---

## Pre-Test Checklist

### Environment Setup

- [ ] PostgreSQL database initialized (`npm run db:push`)
- [ ] OpenAI API key configured (secret: `OPENAI_API_KEY`)
- [ ] Twilio credentials configured (via `twilio` integration)
- [ ] Test user authenticated (e.g., Wayne Fabian, role: operator)
- [ ] Both workflows running:
  - [ ] API Server (port 5000)
  - [ ] Voice Agent Server (port 8000)

### Database Seeding

Verify pre-built agents exist in database:
```bash
# Check agents table
psql $DATABASE_URL -c "SELECT id, name, type FROM agents WHERE type='outbound';"
```

Expected result: "DRS Outbound Scheduler" agent should exist.

### Test Contact Setup

Create test contact in `campaign_contacts` table:
```sql
INSERT INTO campaign_contacts (phone_number, first_name, last_name, status, metadata)
VALUES ('+15555551234', 'Jane', 'Doe', 'pending', '{"insurance": "Blue Cross"}');
```

---

## Test Scenarios

### Scenario 1: Happy Path - Successful Appointment Scheduling

**Objective:** Verify end-to-end automation from voice call through OTP to confirmation.

**Setup:**
1. Create DRS campaign with test contact
2. Navigate to "Scheduling Monitor" page in dashboard
3. Enable auto-refresh toggle

**Test Steps:**

1. **Initiate Outbound Call**
   ```bash
   curl -X POST http://localhost:5000/api/campaigns/{campaignId}/start \
     -H "Content-Type: application/json" \
     -d '{"contactIds": ["{contactId}"]}'
   ```

2. **Answer Call on Test Phone**
   - Agent: "Hi Jane, this is Alex from Azul Vision..."
   - Listen for agent to collect patient information (DOB, address, insurance)

3. **Monitor Browser Automation** (Operator Dashboard)
   - Verify workflow card appears with status "Collecting Info"
   - Watch status progress: `initiated` → `collecting_data` → `form_filling`
   - Observe screenshots appearing in real-time (patient_type, location, calendar)

4. **OTP Verification Loop**
   - Agent: "A 6-digit code was just sent to your phone. What's the code?"
   - Caller: "One, two, three, four, five, six"
   - Verify status updates to `otp_requested` → `otp_verified`
   - Confirm screenshot shows OTP field populated

5. **Appointment Confirmation**
   - Agent: "Perfect! Your appointment is confirmed for [date/time] at [location]"
   - Verify status: `submitting` → `completed`
   - Check final screenshot shows confirmation page

**Expected Results:**

- ✅ Call log created with `status: completed`
- ✅ Scheduling workflow created with `status: completed`
- ✅ Confirmation number stored in `phreesiaConfirmationNumber` field
- ✅ Appointment details stored in `phreesiaAppointmentDetails` JSON field
- ✅ At least 7 screenshots captured (landing → confirmation)
- ✅ `submissionSuccessful: true`
- ✅ No error details recorded

**Database Verification:**
```sql
SELECT 
  sw.status, 
  sw.phreesia_confirmation_number, 
  sw.submission_successful,
  jsonb_array_length(sw.screenshots) as screenshot_count
FROM scheduling_workflows sw
WHERE call_log_id = '{callLogId}';
```

---

### Scenario 2: Error Handling - Automation Failure with Fallback

**Objective:** Verify manual link fallback when browser automation fails.

**Test Steps:**

1. **Simulate Form Error** (modify Computer Use Agent temporarily)
   ```typescript
   // In computerUseAgent.ts, line 165
   throw new Error('Simulated Playwright timeout');
   ```

2. **Initiate Call** (same as Scenario 1)

3. **Observe Fallback Behavior**
   - Agent: "I'm having trouble with the automated system. I'll send you a link to complete scheduling yourself."
   - Agent provides manual link: `https://z1-rpw.phreesia.net/ApptRequestForm.App/#/form/19a8be99-e9e4-4346-b7c7-3dd5feacc494`

**Expected Results:**

- ✅ Workflow status: `failed`
- ✅ Error details stored in `errorDetails` JSON field
- ✅ `fallbackLinkSent: true`
- ✅ Screenshot captured at error state
- ✅ Agent gracefully continues conversation without hanging up

**Database Verification:**
```sql
SELECT 
  sw.status, 
  sw.fallback_link_sent, 
  sw.error_details->>'message' as error_message
FROM scheduling_workflows sw
WHERE call_log_id = '{callLogId}';
```

---

### Scenario 3: Manual Intervention - Operator Pause/Resume

**Objective:** Verify operator can pause automation, inspect state, and resume.

**Test Steps:**

1. **Start Call and Automation** (same as Scenario 1)

2. **Pause During Location Selection**
   - In Operator Dashboard, click **"Pause"** button
   - Enter note: "Checking patient eligibility"
   - Verify button changes to **"Resume"** (green)

3. **Observe Automation Halts**
   - Computer Use Agent logs: `[COMPUTER USE] Workflow {id} paused by operator, waiting for resume...`
   - Agent enters polling loop (checks every 2s)
   - Verify no new screenshots appear

4. **Inspect Workflow State**
   - Click **"View Details"** to open modal
   - Verify orange banner: "⚠️ Manual Override Enabled"
   - Verify operator notes displayed: "Checking patient eligibility"

5. **Resume Automation**
   - Click **"Resume"** button
   - Confirm prompt: "Resume automatic form filling?"
   - Verify automation continues from paused step

**Expected Results:**

- ✅ `manualOverrideEnabled: true` while paused
- ✅ `operatorId` stamped with authenticated user ID
- ✅ `operatorNotes` persisted with reason
- ✅ Automation halts at next `checkPauseState()` checkpoint
- ✅ Automation resumes when `manualOverrideEnabled: false`
- ✅ Operator notes cleared on resume

**Database Verification:**
```sql
SELECT 
  sw.manual_override_enabled,
  sw.operator_id,
  sw.operator_notes,
  sw.updated_at
FROM scheduling_workflows sw
WHERE id = '{workflowId}';
```

**Backend Logs Verification:**
```
[SCHEDULING] Operator {userId} paused workflow {workflowId}: Checking patient eligibility
[COMPUTER USE] Workflow {workflowId} paused by operator, waiting for resume...
[SCHEDULING] Operator {userId} resumed workflow {workflowId}
[COMPUTER USE] Workflow {workflowId} resumed by operator
```

---

### Scenario 4: Operator Cancellation

**Objective:** Verify operator can cancel workflow mid-automation.

**Test Steps:**

1. **Start Call and Automation**
2. **Click "Cancel" Button**
   - Confirm prompt: "Are you sure you want to cancel this scheduling session?"
   - Click OK

**Expected Results:**

- ✅ Workflow status immediately changes to `cancelled`
- ✅ Computer Use Agent throws error: "Workflow cancelled by operator"
- ✅ Browser session closed gracefully
- ✅ `operatorId` stamped

**Database Verification:**
```sql
SELECT status, operator_id, updated_at
FROM scheduling_workflows
WHERE id = '{workflowId}';
```

---

### Scenario 5: OTP Retry Loop

**Objective:** Verify agent handles incorrect OTP codes gracefully.

**Test Steps:**

1. **Start Call Through Patient Info Collection**
2. **Agent Requests OTP**
   - Agent: "A 6-digit code was just sent to your phone. What's the code?"
3. **Provide Incorrect Code**
   - Caller: "Nine, eight, seven, six, five, four"
   - Agent: "That code didn't work. Let me try again. What's the code you received?"
4. **Provide Correct Code**
   - Caller: "One, two, three, four, five, six"
   - Verify form continues

**Expected Results:**

- ✅ `otpAttempts` increments with each submission
- ✅ `otpFailureReason` populated on incorrect attempts
- ✅ Agent retries up to 3 times before fallback
- ✅ Successful OTP clears failure reason

---

## Known Limitations and Production Considerations

### Automation Restart on Workflow Reopen

**Current Behavior:**
When an operator reopens a workflow from a terminal state (completed/failed/cancelled → initiated/collecting_data):
- ✅ The PATCH endpoint allows the transition with a warning
- ✅ The `manualOverrideEnabled` flag is cleared properly
- ❌ **Automation does NOT automatically restart**

**Why:**
- Browser automation runs during an active phone call context
- When a workflow reaches a terminal state, the original call has typically ended
- There is no active voice agent to resume the automation
- The workflow is tied to a specific `callLogId` which is immutable

**Operator Workaround:**
To retry a failed/cancelled scheduling workflow:
1. Make a **new outbound call** to the patient using the DRS Outbound Scheduler agent
2. The new call will create a **new workflow** with fresh automation
3. The original workflow remains in the database for audit purposes

**Future Enhancement Opportunity:**
- Add a "Retry" button in the Operator Dashboard
- Button triggers a new outbound call to the patient's phone number
- New call creates a new workflow with the same patient data pre-filled
- Maintains audit trail by linking retries to original workflow

### Legacy Data Migration

**Null Status Handling:**
The WorkflowStateHelper now gracefully handles workflows with `null` status values (legacy data):
- Normalizes `null` → `initiated` for validation purposes
- Logs warning: "Workflow had null status (legacy data) - normalized to initiated"
- Allows operators to update these workflows without corruption errors

**Production Cleanup Script:**
```sql
-- Identify workflows with null status
SELECT id, call_log_id, created_at, updated_at
FROM scheduling_workflows
WHERE status IS NULL
ORDER BY created_at DESC;

-- Normalize null statuses to 'initiated' (run after testing)
UPDATE scheduling_workflows
SET status = 'initiated', updated_at = NOW()
WHERE status IS NULL;
```

### Race Condition Prevention

**Transaction-Level Coordination:**
The PATCH endpoint uses `SELECT FOR UPDATE` row-level locking to prevent race conditions:
- ✅ Operator pause requests cannot be overwritten by concurrent automation updates
- ✅ Atomic validation and update within a single transaction
- ✅ Guarantees `manualOverrideEnabled` flag consistency

**Impact:**
- Operator interventions are **always** respected, even during high-concurrency scenarios
- Automation updates wait for operator transactions to complete before proceeding
- No risk of "lost updates" or desynchronized state

---

## Production Readiness Checklist

### ⚠️ REQUIRED: Manual Verification Before Production Deployment

**CRITICAL:** Before deploying to production, you MUST run the PATCH validation verification tests to confirm error handling works correctly.

**Required Verification Steps:**

1. **Run Automated Test Script:**
   ```bash
   # NOTE: Requires authenticated session
   node test-patch-validation.js
   ```
   
   Expected result: All 4 tests pass with 400 status codes

2. **Manual cURL Testing** (if automated script fails auth):
   Follow the test scenarios in `docs/PATCH_VALIDATION_VERIFICATION.md`
   
   **Minimum Required Tests:**
   - [ ] Pause already paused workflow → 400 with "already paused" message
   - [ ] Resume not-paused workflow → 400 with "not paused" message
   - [ ] Invalid state transition → 400 with "Invalid transition" + allowed states
   - [ ] Workflow not found → 400 with "not found" message

3. **Verify Backend Logs:**
   ```bash
   # Check that validation errors log warnings (not errors)
   grep "Validation error" /tmp/logs/API_Server_*.log
   
   # Should see lines like:
   # [SCHEDULING] Validation error: Workflow is already paused
   # [SCHEDULING] Validation error: Invalid transition: ...
   ```

4. **Verify HTTP Responses:**
   - All validation errors return **HTTP 400** (not 500)
   - Response body includes specific error message (not generic)
   - System errors (DB failures) return **HTTP 500** with generic message

**⚠️ DO NOT DEPLOY TO PRODUCTION WITHOUT COMPLETING THIS VERIFICATION**

The implementation is complete, but has not been manually tested in this development environment. Running the verification tests will confirm:
- WorkflowValidationError prototype chain survives async boundaries
- Type guard correctly identifies validation errors
- Transaction rollback works on validation failure
- No global error handlers override our error responses

---

### ✅ MVP Features Complete

- [x] **Voice Agent Integration** - DRS agent collects patient data via conversation
- [x] **Computer Use Automation** - Playwright fills Phreesia form in real-time
- [x] **OTP Verification Loop** - Promise-based coordination between voice and browser
- [x] **Operator Dashboard** - Live workflow monitoring with screenshots
- [x] **Error Handling** - Automatic fallback to manual scheduling links
- [x] **Manual Controls** - Pause/resume/cancel functionality

### 🔧 Production Refinements Needed (Architect Feedback)

#### **1. State Transition Validation (Priority: HIGH)**

**Issue:** PATCH endpoint accepts any status string without validating allowed transitions.

**Fix Required:**
```typescript
// server/routes.ts - Add state machine validation
const ALLOWED_TRANSITIONS = {
  'initiated': ['collecting_data', 'cancelled'],
  'collecting_data': ['form_filling', 'failed', 'cancelled'],
  'form_filling': ['otp_requested', 'failed', 'cancelled'],
  'otp_requested': ['otp_verified', 'failed', 'cancelled'],
  // ... etc
};

// In PATCH handler:
const currentWorkflow = await storage.getSchedulingWorkflow(workflowId);
if (!ALLOWED_TRANSITIONS[currentWorkflow.status]?.includes(updates.status)) {
  return res.status(400).json({ 
    message: `Invalid transition: ${currentWorkflow.status} → ${updates.status}` 
  });
}
```

**Test:** Attempt invalid transition (e.g., `completed` → `initiated`) and verify 400 error.

---

#### **2. Operator Intervention Timestamp Persistence (Priority: MEDIUM)**

**Issue:** No `operatorInterventionAt` timestamp persisted for audit trail.

**Fix Required:**
```typescript
// shared/schema.ts - Add field
operatorInterventionAt: timestamp("operator_intervention_at"),

// server/routes.ts - Stamp on ALL operator actions
if (req.body.manualOverrideEnabled !== undefined || req.body.status === 'cancelled') {
  updates.operatorInterventionAt = new Date();
}
```

**Test:** Pause workflow, verify `operatorInterventionAt` populated in database.

---

#### **3. Force Clear Manual Override on Completion/Cancellation (Priority: HIGH)**

**Issue:** Cancelled workflows can remain flagged as paused, confusing UI.

**Fix Required:**
```typescript
// server/routes.ts - Force clear on terminal states
if (['cancelled', 'completed', 'failed'].includes(req.body.status)) {
  updates.manualOverrideEnabled = false;
  updates.operatorNotes = null;
}
```

**Test:** Cancel a paused workflow, verify `manualOverrideEnabled: false` in database.

---

#### **4. Pause Polling Optimization (Priority: LOW)**

**Issue:** `checkPauseState()` loads storage in hot loop, potentially inefficient.

**Improvement:**
- Move polling to Workflow Manager
- Emit events on pause/resume instead of polling
- Add timeout to prevent infinite loops

**Not blocking MVP deployment.**

---

### 🔒 Security & Compliance

- [ ] **Medical Guardrails Active** - Verify 6 guardrails enforced (see `src/agents/triageAgent.ts`)
- [ ] **HIPAA Logging Compliance** - Ensure transcripts redact SSN, credit cards
- [ ] **Operator Authentication** - PATCH endpoint requires `isAuthenticated` middleware ✅
- [ ] **Role-Based Access** - Consider restricting manual controls to `operator` role only
- [ ] **Rate Limiting** - Add throttling to `/api/scheduling-workflows/:id` PATCH endpoint

---

### 📊 Performance Testing

- [ ] **Concurrent Workflows** - Test 5+ simultaneous DRS calls with automation
- [ ] **Browser Resource Limits** - Monitor Playwright memory usage over 1-hour test
- [ ] **Database Connection Pool** - Verify no connection leaks during polling loops
- [ ] **Screenshot Storage** - Test with 100+ workflows (JSONB field size limits)

---

### 🚀 Deployment Considerations

#### **Environment Variables**
```bash
# Required for Computer Use
PLAYWRIGHT_HEADLESS=true  # Set to false for debugging
PHREESIA_FORM_URL=https://phreesia.me/AzulVisionDRS

# Database
DATABASE_URL=postgresql://...

# API Keys (via Replit Secrets)
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

#### **Workflow Configuration**
```bash
# Start API Server (port 5000)
npx tsx server/index.ts

# Start Voice Agent Server (port 8000)
npx tsx src/server.ts
```

#### **Database Migrations**
```bash
# Push schema changes
npm run db:push

# Or force push if conflicts
npm run db:push --force
```

---

## Troubleshooting

### Issue: "Workflow not found" in Computer Use Agent

**Cause:** Call log created after agent instantiation, `workflowId` not passed.

**Fix:** Ensure `callLogId` and `agentId` passed in enhanced metadata (see Task 7).

**Verify:**
```typescript
// src/voiceAgentRoutes.ts
metadata.callLogId = callLog.id;
metadata.agentId = agent.id;
```

---

### Issue: OTP verification loop never resolves

**Cause:** `submit_otp_code` tool not looking up `workflowId` using `callLogId`.

**Fix:** Tool must query `scheduling_workflows` table by `call_log_id`.

**Verify:**
```typescript
// src/tools/phreesiaSchedulingTool.ts
const workflow = await storage.getSchedulingWorkflowByCallLog(callLogId);
await workflowManager.submitOTP(workflow.id, otpCode);
```

---

### Issue: Screenshots not appearing in dashboard

**Cause:** `captureScreenshot()` not awaiting Playwright screenshot.

**Fix:** Ensure `await this._page.screenshot()` called before base64 encoding.

**Debug:**
```bash
# Check screenshots JSONB field
psql $DATABASE_URL -c "SELECT jsonb_array_length(screenshots) FROM scheduling_workflows WHERE id='{id}';"
```

---

### Issue: Pause button doesn't halt automation

**Cause:** `checkPauseState()` not called between form steps.

**Fix:** Insert `await this.checkPauseState()` after each major step (7 checkpoints total).

**Verify Backend Logs:**
```
[COMPUTER USE] Workflow {id} paused by operator, waiting for resume...
```

---

## Next Steps

1. **Address Production Refinements** - Implement state validation, timestamps, and clear-on-terminal fixes
2. **Load Testing** - Verify 10+ concurrent DRS calls with automation
3. **HIPAA Audit** - Review transcript logging for PHI compliance
4. **Operator Training** - Document dashboard usage and manual intervention workflows
5. **Monitoring Setup** - Add alerts for failed workflows, stale calls, browser crashes

---

## Appendix: Key Database Queries

### Active Workflows Monitor
```sql
SELECT 
  sw.id,
  sw.status,
  sw.current_step,
  sw.manual_override_enabled,
  sw.operator_notes,
  cl.caller_phone,
  c.name as campaign_name,
  sw.started_at,
  sw.updated_at
FROM scheduling_workflows sw
JOIN call_logs cl ON sw.call_log_id = cl.id
LEFT JOIN campaigns c ON sw.campaign_id = c.id
WHERE sw.status NOT IN ('completed', 'failed', 'cancelled')
ORDER BY sw.started_at DESC;
```

### Failed Workflows Analysis
```sql
SELECT 
  sw.error_details->>'message' as error,
  COUNT(*) as occurrences,
  MAX(sw.created_at) as last_occurrence
FROM scheduling_workflows sw
WHERE sw.status = 'failed'
GROUP BY error
ORDER BY occurrences DESC;
```

### Operator Intervention Audit
```sql
SELECT 
  u.email as operator,
  sw.id as workflow_id,
  sw.operator_notes,
  sw.manual_override_enabled,
  sw.status,
  sw.updated_at
FROM scheduling_workflows sw
JOIN users u ON sw.operator_id = u.id
WHERE sw.operator_id IS NOT NULL
ORDER BY sw.updated_at DESC
LIMIT 50;
```

---

**Document Version:** 1.0  
**Last Reviewed:** November 24, 2025  
**Maintainer:** Azul Vision Engineering Team
