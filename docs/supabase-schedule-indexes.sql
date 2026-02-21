-- Supabase Schedule Table Index Recommendations
-- These indexes optimize the common query patterns used by the Schedule Lookup Service

-- Index 1: Case-insensitive patient name + DOB lookup (ALREADY EXISTS)
-- Used by: lookupByNameAndDOB() for matching patients
CREATE INDEX IF NOT EXISTS idx_schedule_name_dob_ci 
ON "Schedule" (
    lower("PatientFirstName"), 
    lower("PatientLastName"), 
    "PatientDateOfBirth"
);

-- Index 2: Phone number lookup - Cell Phone
-- Used by: lookupByPhone() for caller ID matching
CREATE INDEX IF NOT EXISTS idx_schedule_cell_phone 
ON "Schedule" ("PatientCellPhone")
WHERE "PatientCellPhone" IS NOT NULL;

-- Index 3: Phone number lookup - Home Phone  
-- Used by: lookupByPhone() for caller ID matching (fallback)
CREATE INDEX IF NOT EXISTS idx_schedule_home_phone 
ON "Schedule" ("PatientHomePhone")
WHERE "PatientHomePhone" IS NOT NULL;

-- Index 4: Appointment Date + Status for upcoming appointment queries
-- Used by: getUpcomingAppointments() and buildContext()
CREATE INDEX IF NOT EXISTS idx_schedule_date_status 
ON "Schedule" ("AppointmentDate", "AppointmentStatus")
WHERE "AppointmentStatus" = 'Active';

-- Index 5: Combined phone + date for efficient filtered lookups
-- Covers the most common query pattern: find patient by phone, filter by date
CREATE INDEX IF NOT EXISTS idx_schedule_cell_date 
ON "Schedule" ("PatientCellPhone", "AppointmentDate")
WHERE "PatientCellPhone" IS NOT NULL;

-- Verify indexes after creation
SELECT 
    indexname,
    indexdef
FROM pg_indexes 
WHERE tablename = 'Schedule'
ORDER BY indexname;
