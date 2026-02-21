# PATCH Endpoint Validation Error Verification

This document provides manual verification steps to confirm that WorkflowValidationError properly returns HTTP 400 status codes with specific error messages.

## Prerequisites

1. API Server running on port 5000
2. Authenticated session with Replit Auth
3. At least one scheduling workflow in the database

## Test Scenarios

### Test 1: Pause Already Paused Workflow

**Setup:**
```sql
-- Create a test workflow in paused state
INSERT INTO scheduling_workflows (
  id, call_log_id, agent_id, status, manual_override_enabled, 
  patient_data, otp_attempts, submission_successful, fallback_link_sent, started_at
) VALUES (
  'test-pause-001', 'test-call-001', 'test-agent-001', 'form_filling', true,
  '{"firstName": "Test", "lastName": "Patient"}', 0, false, false, NOW()
) ON CONFLICT (id) DO UPDATE SET manual_override_enabled = true;
```

**Test Request:**
```bash
curl -X PATCH http://localhost:5000/api/scheduling-workflows/test-pause-001 \
  -H "Content-Type: application/json" \
  -d '{"manualOverrideEnabled": true, "operatorNotes": "Trying to pause again"}'
```

**Expected Response:**
```json
{
  "message": "Workflow is already paused"
}
```

**Expected HTTP Status:** `400 Bad Request`

**Backend Log Expected:**
```
[SCHEDULING] Validation error: Workflow is already paused
```

---

### Test 2: Resume Not-Paused Workflow

**Setup:**
```sql
-- Create a test workflow in active state (not paused)
INSERT INTO scheduling_workflows (
  id, call_log_id, agent_id, status, manual_override_enabled,
  patient_data, otp_attempts, submission_successful, fallback_link_sent, started_at
) VALUES (
  'test-resume-001', 'test-call-002', 'test-agent-002', 'form_filling', false,
  '{"firstName": "Test", "lastName": "Patient"}', 0, false, false, NOW()
) ON CONFLICT (id) DO UPDATE SET manual_override_enabled = false;
```

**Test Request:**
```bash
curl -X PATCH http://localhost:5000/api/scheduling-workflows/test-resume-001 \
  -H "Content-Type: application/json" \
  -d '{"manualOverrideEnabled": false}'
```

**Expected Response:**
```json
{
  "message": "Workflow is not paused"
}
```

**Expected HTTP Status:** `400 Bad Request`

**Backend Log Expected:**
```
[SCHEDULING] Validation error: Workflow is not paused
```

---

### Test 3: Invalid State Transition

**Setup:**
```sql
-- Create a test workflow in otp_verified state
INSERT INTO scheduling_workflows (
  id, call_log_id, agent_id, status, manual_override_enabled,
  patient_data, otp_attempts, submission_successful, fallback_link_sent, started_at
) VALUES (
  'test-transition-001', 'test-call-003', 'test-agent-003', 'otp_verified', false,
  '{"firstName": "Test", "lastName": "Patient"}', 0, false, false, NOW()
) ON CONFLICT (id) DO UPDATE SET status = 'otp_verified', manual_override_enabled = false;
```

**Test Request (Invalid Transition):**
```bash
curl -X PATCH http://localhost:5000/api/scheduling-workflows/test-transition-001 \
  -H "Content-Type: application/json" \
  -d '{"status": "collecting_data"}'
```

**Expected Response:**
```json
{
  "message": "Invalid transition: otp_verified → collecting_data. Allowed: submitting, cancelled, failed"
}
```

**Expected HTTP Status:** `400 Bad Request`

**Backend Log Expected:**
```
[SCHEDULING] Validation error: Invalid transition: otp_verified → collecting_data. Allowed: submitting, cancelled, failed
```

---

### Test 4: Cancel Already Cancelled Workflow

**Setup:**
```sql
-- Create a test workflow in cancelled state
INSERT INTO scheduling_workflows (
  id, call_log_id, agent_id, status, manual_override_enabled,
  patient_data, otp_attempts, submission_successful, fallback_link_sent, started_at
) VALUES (
  'test-cancel-001', 'test-call-004', 'test-agent-004', 'cancelled', false,
  '{"firstName": "Test", "lastName": "Patient"}', 0, false, false, NOW()
) ON CONFLICT (id) DO UPDATE SET status = 'cancelled', manual_override_enabled = false;
```

**Test Request:**
```bash
curl -X PATCH http://localhost:5000/api/scheduling-workflows/test-cancel-001 \
  -H "Content-Type: application/json" \
  -d '{"status": "cancelled"}'
```

**Expected Response:**
```json
{
  "message": "Workflow is already cancelled"
}
```

**Expected HTTP Status:** `400 Bad Request`

**Backend Log Expected:**
```
[SCHEDULING] Validation error: Workflow is already cancelled
```

---

### Test 5: Workflow Not Found

**Test Request:**
```bash
curl -X PATCH http://localhost:5000/api/scheduling-workflows/non-existent-workflow-id \
  -H "Content-Type: application/json" \
  -d '{"status": "cancelled"}'
```

**Expected Response:**
```json
{
  "message": "Workflow non-existent-workflow-id not found"
}
```

**Expected HTTP Status:** `400 Bad Request`

**Backend Log Expected:**
```
[SCHEDULING] Validation error: Workflow non-existent-workflow-id not found
```

---

### Test 6: System Error (Database Unavailable)

**Setup:**
Temporarily stop the database or corrupt the connection string

**Expected Response:**
```json
{
  "message": "Failed to update scheduling workflow"
}
```

**Expected HTTP Status:** `500 Internal Server Error`

**Backend Log Expected:**
```
Error updating scheduling workflow: [database error details]
```

---

## Verification Checklist

After running all tests, verify:

- [ ] Test 1: Pause already paused → **400** with "Workflow is already paused"
- [ ] Test 2: Resume not paused → **400** with "Workflow is not paused"
- [ ] Test 3: Invalid transition → **400** with "Invalid transition: ... Allowed: ..."
- [ ] Test 4: Cancel already cancelled → **400** with "Workflow is already cancelled"
- [ ] Test 5: Workflow not found → **400** with "Workflow ... not found"
- [ ] Test 6: System error → **500** with generic message

## Error Handling Flow

```
PATCH /api/scheduling-workflows/:id
  │
  ├─> storage.updateSchedulingWorkflowWithLock()
  │     │
  │     ├─> db.transaction()
  │     │     │
  │     │     ├─> SELECT FOR UPDATE (row lock)
  │     │     │
  │     │     ├─> updateFn(current)
  │     │     │     │
  │     │     │     ├─> WorkflowStateHelper.validateOperatorAction()
  │     │     │     │
  │     │     │     ├─> throw WorkflowValidationError() [if invalid]
  │     │     │     │
  │     │     │     └─> return atomicUpdates
  │     │     │
  │     │     └─> UPDATE scheduling_workflows
  │     │
  │     └─> return updated workflow
  │
  ├─> catch (error)
  │     │
  │     ├─> isWorkflowValidationError(error)?
  │     │     │
  │     │     ├─> YES: return 400 with error.message
  │     │     │
  │     │     └─> NO: return 500 with generic message
  │
  └─> res.json(workflow)
```

## Prototype Chain Verification

The `WorkflowValidationError` class uses `Object.setPrototypeOf()` to maintain proper prototype chain:

```typescript
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
    // Maintain proper prototype chain
    Object.setPrototypeOf(this, WorkflowValidationError.prototype);
  }
}
```

The type guard checks both `instanceof` and `name` property:

```typescript
export function isWorkflowValidationError(error: unknown): error is WorkflowValidationError {
  return error instanceof WorkflowValidationError || 
         (error as any)?.name === 'WorkflowValidationError';
}
```

This ensures error detection works even if:
- Error is thrown across async boundaries
- Prototype chain is lost during bundling
- Error is serialized/deserialized

## Production Confidence

After all tests pass:
- ✅ Validation errors consistently return 400 with specific messages
- ✅ System errors consistently return 500 with generic messages
- ✅ No false positives (validation errors misclassified as system errors)
- ✅ No false negatives (system errors misclassified as validation errors)
- ✅ Transaction rollback prevents partial state updates
- ✅ Row-level locking prevents race conditions
