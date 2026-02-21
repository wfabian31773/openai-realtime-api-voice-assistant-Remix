# Testing Guide for Azul Vision Voice Agents

## ✅ System Status
Both servers are running:
- **API Server (Port 5000)** - Dashboard & API
- **Voice Agent Server (Port 8000)** - All 4 AI agents ready

## 🎯 How to Access & Test Agents

### Step 1: Access the Dashboard
1. Click **"Sign In"** in the top-right corner
2. Sign in with your Replit account
3. You'll be redirected to the Dashboard

### Step 2: View All Agents
1. Click **"Agents"** in the left sidebar
2. You'll see all 4 pre-built agents:
   - **After-Hours Triage** (Inbound)
   - **DRS Outbound Scheduler** (Outbound)  
   - **Appointment Confirmation** (Outbound)
   - **Answering Service** (Inbound)

### Step 3: Test an Agent
1. Click the **"Test"** button on any agent card
2. Enter a phone number in E.164 format (e.g., `+12345678900`)
3. Click **"Initiate Call"**

**⚠️ Important:** Test calls require Twilio credentials to be configured:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `DOMAIN` (your Replit deployment domain)

### Step 4: Configure an Agent (Optional)
1. Click **"Configure"** on any agent
2. Adjust settings:
   - Voice selection (sage, alloy, shimmer, etc.)
   - Temperature (controls randomness)
   - System prompt (agent's instructions)

## 🔧 Agent Capabilities

### 1️⃣ After-Hours Triage
**Type:** Inbound  
**Purpose:** Medical triage with emergency detection  
**Tools:**
- `lookup_patient` - Get patient information
- `transfer_to_physician` - Immediate transfer for STAT conditions
- `create_callback` - Queue non-urgent cases

**Test Scenario:** Call and mention symptoms like "sudden vision loss" to trigger STAT transfer

### 2️⃣ DRS Outbound Scheduler
**Type:** Outbound  
**Purpose:** Schedule diabetic eye exams  
**Tools:**
- `lookup_patient` - Get patient demographics
- Computer Use (Phreesia) - Navigate scheduling in real-time
- `mark_contact_completed` - Update campaign status

**Test Scenario:** Create a campaign with diabetic patients and let the agent call to schedule exams

### 3️⃣ Appointment Confirmation
**Type:** Outbound  
**Purpose:** Confirm upcoming appointments  
**Tools:**
- `get_appointment` - Retrieve appointment details
- `confirm_appointment` - Mark as confirmed
- `reschedule_appointment` - Change date/time
- `cancel_appointment` - Cancel if needed

**Test Scenario:** Create campaign with upcoming appointments

### 4️⃣ Answering Service
**Type:** Inbound  
**Purpose:** Route calls to departments  
**Tools:**
- `transfer_to_department` - Transfer to Optical/Surgery/Clinical
- `take_message` - Create callback queue entry
- `create_support_ticket` - External ticketing system

**Test Scenario:** Call and request to speak with "Optical department"

## 📊 Monitoring & Analytics

### Call Logs
- Navigate to **"Call Logs"** in sidebar
- View all call history with transcripts
- Filter by status, date, agent

### Callback Queue
- Navigate to **"Callbacks"** in sidebar
- See all pending callbacks
- Assign to staff members
- Mark as completed

### Campaigns
- Navigate to **"Campaigns"** in sidebar
- Create outbound campaigns
- Upload CSV contact lists
- Monitor progress in real-time

## 🛠 Re-Seed Agents (If Needed)
If you need to reset agents to default configuration:
```bash
npx tsx server/seedAgents.ts
```
This updates all 4 agents with latest system prompts and settings.

## 📞 Required Twilio Setup
To make actual test calls, set these environment variables:
1. Get credentials from [Twilio Console](https://console.twilio.com)
2. Add to Replit Secrets:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`  
   - `TWILIO_PHONE_NUMBER`
   - `DOMAIN` (your `.replit.dev` domain)

## 🔐 Medical Safety
All agents have 6 medical guardrails enforced:
1. ✅ No medical diagnoses
2. ✅ No prescription recommendations
3. ✅ No claims of being a doctor
4. ✅ No treatment instructions
5. ✅ Professional, empathetic tone
6. ✅ Minimal personal health info collection

These guardrails are enforced via OpenAI SDK's output guardrail system.

## 🎉 You're Ready!
All 4 agents are live and ready to handle calls. Sign in to the dashboard to see them in action!
