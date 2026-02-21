# Agent Phone Number Configuration Guide

## Overview

This guide explains how Twilio phone numbers are assigned to AI voice agents in the Azul Vision AI Operations Hub. Understanding the relationship between agents and phone numbers is critical for proper configuration and operation.

---

## Table of Contents

1. [Understanding Agent Types](#understanding-agent-types)
2. [Phone Number Assignment](#phone-number-assignment)
3. [Inbound Call Routing](#inbound-call-routing)
4. [Outbound Caller ID](#outbound-caller-id)
5. [How to Assign Phone Numbers](#how-to-assign-phone-numbers)
6. [Twilio Configuration Requirements](#twilio-configuration-requirements)
7. [Common Scenarios](#common-scenarios)
8. [Troubleshooting](#troubleshooting)

---

## Understanding Agent Types

Each voice agent has a **type** that determines how it interacts with the phone system:

### Inbound Agents
- **Purpose:** Receive and handle incoming calls
- **Examples:** After-Hours Triage, Answering Service
- **Phone Number Usage:** Calls **to** the assigned number are routed **to** this agent
- **Configuration:** Requires Twilio webhook configuration to route incoming calls

### Outbound Agents
- **Purpose:** Make outgoing calls to patients/contacts
- **Examples:** DRS Outbound Scheduler, Appointment Confirmation
- **Phone Number Usage:** Calls **from** this agent display the assigned number as **caller ID**
- **Configuration:** Uses Twilio's Programmable Voice API to initiate calls

---

## Phone Number Assignment

### Current Agent Phone Number Assignments

To view which phone numbers are assigned to which agents:

1. Navigate to the **Agents** page in the admin dashboard
2. Each agent card displays:
   - 📞 **Phone number** (if assigned)
   - 📥 **Inbound icon** (blue) for agents receiving calls
   - 📤 **Outbound icon** (green) for agents making calls
   - ⚠️ **Warning** if no phone number is assigned

### Example Agent Configuration

**After-Hours Triage Agent (Inbound)**
```
Agent Name: After-Hours Triage
Type: Inbound
Phone Number: +1 (626) 555-0100
```
✅ **Meaning:** When patients call +1 (626) 555-0100, they reach the After-Hours Triage agent.

**DRS Outbound Scheduler (Outbound)**
```
Agent Name: DRS Outbound Scheduler
Type: Outbound
Phone Number: +1 (626) 555-0200
```
✅ **Meaning:** When this agent calls patients, their phone displays +1 (626) 555-0200 as the caller ID.

---

## Inbound Call Routing

### How Inbound Routing Works

1. **Patient calls** a Twilio phone number (e.g., +1-626-555-0100)
2. **Twilio receives** the call and checks webhook configuration
3. **Webhook routes** the call to the Voice Agent Server (port 8000)
4. **Server looks up** which agent is assigned to that phone number
5. **Agent answers** and begins conversation using OpenAI Realtime API

### Required Twilio Configuration

For inbound agents to work, you must configure the Twilio phone number webhook:

**Webhook URL:**
```
https://your-replit-domain.repl.co:8000/api/voice/inbound
```

**Configuration Steps (Twilio Console):**

1. Log in to Twilio Console
2. Navigate to **Phone Numbers → Manage → Active numbers**
3. Click on the phone number you want to configure
4. Scroll to **Voice Configuration**
5. Set **A Call Comes In** to:
   - **Webhook**
   - **URL:** `https://your-replit-domain.repl.co:8000/api/voice/inbound`
   - **HTTP Method:** `POST`
6. Click **Save**

### Dynamic Agent Selection

The Voice Agent Server automatically selects the correct agent based on:
- **Incoming phone number** (the number the patient dialed)
- **Agent database lookup** (finds agent assigned to that number)
- **Fallback logic** (defaults to "After-Hours" agent if no match)

---

## Outbound Caller ID

### How Outbound Caller ID Works

1. **Campaign triggers** outbound call (e.g., DRS screening campaign)
2. **Server initiates call** via Twilio API with specified "From" number
3. **Twilio places call** using the assigned phone number as caller ID
4. **Patient's phone** displays the configured Twilio number
5. **Agent converses** with patient using OpenAI Realtime API

### Choosing the Right Caller ID

**Best Practices:**
- ✅ Use a **local area code** matching your practice location
- ✅ Use a **consistent number** across campaigns (builds trust)
- ✅ Ensure the number is **configured in Twilio** and verified
- ⚠️ **Never use** personal cell phones or unverified numbers

**Example Configuration:**
```
Practice Location: Pasadena, CA (626 area code)
Outbound Number: +1 (626) 555-0200
Caller ID Display: "AZUL VISION" (configured in Twilio)
```

---

## How to Assign Phone Numbers

### Method 1: During Agent Creation

1. Navigate to **Agents** page
2. Click **Create Agent**
3. Fill in agent details (name, type, prompts)
4. In **Twilio Phone Number** dropdown:
   - Select from available Twilio numbers
   - Or leave blank to configure later
5. Click **Create Agent**

### Method 2: Edit Existing Agent

1. Navigate to **Agents** page
2. Find the agent you want to configure
3. Click **Configure** button
4. In the edit dialog:
   - Select or change **Twilio Phone Number**
   - Click **Save Changes**

### Method 3: Clear Phone Number Assignment

To unassign a phone number from an agent:

1. Click **Configure** on the agent card
2. Set **Twilio Phone Number** to `-- No phone number assigned --`
3. Click **Save Changes**

The phone number becomes available for other agents.

---

## Twilio Configuration Requirements

### Prerequisites

Before assigning phone numbers to agents, ensure you have:

✅ **Active Twilio Account** with:
- Verified phone numbers
- Sufficient credit balance
- SIP Trunking enabled (for voice calls)

✅ **Phone Numbers Configured** with:
- Voice capability enabled
- Webhooks configured (for inbound agents)
- Caller ID verification (for outbound agents)

✅ **Environment Variables Set:**
```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1... (default fallback number)
```

### Fetching Available Phone Numbers

The system automatically fetches available Twilio numbers via API:

```
GET /twilio/phone-numbers
```

This endpoint returns:
- Phone numbers owned by your Twilio account
- Friendly names (configurable in Twilio)
- Capabilities (voice, SMS)

---

## Common Scenarios

### Scenario 1: After-Hours Coverage

**Setup:**
- Agent: After-Hours Triage (Inbound)
- Number: Main practice line +1 (626) 555-0100
- Hours: 6 PM - 8 AM, weekends, holidays

**Configuration:**
1. Assign +1 (626) 555-0100 to After-Hours Triage agent
2. Configure Twilio time-based routing:
   - Business hours → Forward to office staff
   - After hours → Webhook to AI agent
3. Test by calling after hours

### Scenario 2: DRS Screening Campaign

**Setup:**
- Agent: DRS Outbound Scheduler (Outbound)
- Number: Dedicated campaign line +1 (626) 555-0200
- Campaign: Diabetic retinopathy screening outreach

**Configuration:**
1. Assign +1 (626) 555-0200 to DRS Outbound Scheduler
2. Create campaign with target contact list
3. Agent uses this number as caller ID when calling patients
4. If patients call back, number can route to After-Hours or main line

### Scenario 3: Multi-Department Answering Service

**Setup:**
- Agent: Answering Service (Inbound)
- Number: Main switchboard +1 (626) 555-0000
- Departments: Optical, Surgery, Clinical

**Configuration:**
1. Assign +1 (626) 555-0000 to Answering Service agent
2. Agent uses natural language to determine department
3. Agent creates ticketing system entries
4. Agent transfers calls to staff when available

---

## Troubleshooting

### Problem: Inbound calls not reaching agent

**Possible Causes:**
- ❌ Twilio webhook not configured
- ❌ Wrong webhook URL
- ❌ Phone number not assigned to agent in database

**Solution:**
1. Check Twilio Console → Phone Numbers → Voice Configuration
2. Verify webhook URL matches: `https://your-domain:8000/api/voice/inbound`
3. Check Agents page to confirm phone number assignment
4. Review Voice Agent Server logs for incoming call events

### Problem: Outbound calls showing wrong caller ID

**Possible Causes:**
- ❌ Agent has no phone number assigned
- ❌ Campaign using default fallback number
- ❌ Twilio number not verified

**Solution:**
1. Navigate to Agents page
2. Configure correct phone number for outbound agent
3. Verify number in Twilio Console → Phone Numbers
4. Check campaign configuration uses agent's assigned number

### Problem: "No phone number assigned" warning on agent card

**This is expected if:**
- ✅ Agent is newly created and not yet configured
- ✅ Agent is for testing purposes only
- ✅ Agent is inactive/deprecated

**Action Required:**
- Configure a phone number if agent should handle calls
- Leave unassigned if agent is not yet deployed

### Problem: Phone number assigned to multiple agents

**Symptom:** Unexpected behavior, calls routing to wrong agent

**Cause:** Database allows same number on multiple agents (current design)

**Solution:**
1. Audit all agents on Agents page
2. Ensure each phone number is unique to one agent
3. Reassign numbers as needed
4. **Note:** Future enhancement could enforce uniqueness constraint

---

## Quick Reference

### Agent Types Summary

| Type | Direction | Number Purpose | Webhook Required |
|------|-----------|---------------|------------------|
| **Inbound** | Receives calls | Routes incoming calls to this agent | ✅ Yes |
| **Outbound** | Makes calls | Displays as caller ID when calling out | ❌ No |

### Phone Number Flow

**Inbound:**
```
Patient dials number → Twilio → Webhook → Voice Server → Agent (by number lookup)
```

**Outbound:**
```
Campaign triggers → Voice Server → Twilio (with From number) → Patient sees caller ID
```

### Key Pages

- **Agent Configuration:** `https://your-domain:5000/agents`
- **Twilio Console:** `https://console.twilio.com`
- **Voice Agent Server:** Running on port 8000
- **API Server:** Running on port 5000

---

## Best Practices

1. **Document Your Configuration**
   - Maintain a spreadsheet of agent-to-number mappings
   - Note purpose and hours of operation for each agent

2. **Test Before Deployment**
   - Use "Test" button on agent card to initiate test calls
   - Verify caller ID displays correctly
   - Confirm inbound routing works as expected

3. **Monitor Call Logs**
   - Review Call Logs page for successful connections
   - Check for failed calls or routing issues
   - Monitor callback queue for follow-ups

4. **Regular Audits**
   - Review agent configurations monthly
   - Update phone numbers if practice contact info changes
   - Disable unused agents to avoid confusion

5. **Security**
   - Never expose Twilio credentials in client code
   - Rotate auth tokens periodically
   - Use webhook signature validation (configured in Twilio)

---

## Additional Resources

- **Twilio Documentation:** https://www.twilio.com/docs/voice
- **OpenAI Realtime API:** https://platform.openai.com/docs/guides/realtime
- **Replit Deployment:** See publishing guide for production deployment

---

## Support

For questions or issues with phone number configuration:

1. Check this guide first
2. Review Call Logs for error messages
3. Check Voice Agent Server logs
4. Contact Twilio support for account/billing issues

---

*Last Updated: November 25, 2025*
