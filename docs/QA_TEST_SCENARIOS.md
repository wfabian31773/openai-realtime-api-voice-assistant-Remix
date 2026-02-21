# QA Test Scenarios - Azul Vision Voice Agents

## Overview
This document outlines critical test scenarios for validating voice agent functionality before production deployment.

## Pre-Test Checklist
- [ ] All workflows running (API Server + Voice Agent Server)
- [ ] Database connection verified
- [ ] Twilio credentials configured
- [ ] OpenAI API key active with realtime access
- [ ] Test phone number configured in Twilio

---

## No-IVR Agent (v1.10.0)

### Basic Call Flow
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| N1 | Inbound call answered | Call test number | Greeting plays within 2s, agent responds naturally |
| N2 | Caller identification | State name and callback number | Agent confirms understanding, creates ticket |
| N3 | Ghost call detection | Call and stay silent 10s | Agent detects silence, prompts caller, hangs up if no response |
| N4 | Language detection | Speak in Spanish | Agent detects Spanish, continues in Spanish |

### Medical Triage
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| N5 | STAT condition | Report sudden vision loss | Immediate human handoff, STAT ticket created |
| N6 | Urgent condition | Report eye pain with redness | Urgent ticket, same-day callback promised |
| N7 | Routine inquiry | Ask about appointment availability | Ticket created, normal priority |

### Edge Cases
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| N8 | Caller interruption | Interrupt during greeting | Agent pauses, acknowledges, continues |
| N9 | Call recovery | Lose connection mid-call, call back | Agent recognizes caller, continues context |
| N10 | Third-party caller | Call on behalf of family member | Agent asks for patient info separately |

---

## Answering Service Agent (v3.1.0)

### Department Routing
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| A1 | Optical request | Ask about glasses order | Routes to Optical department |
| A2 | Surgery coordination | Ask about surgery scheduling | Routes to Surgery department |
| A3 | Tech support | Report equipment issue | Routes to Tech department |

### Request Classification
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| A4 | Prescription refill | Request eye drop refill | classify_request returns PRESCRIPTION_REFILL |
| A5 | Appointment change | Request to reschedule | classify_request returns APPOINTMENT_RESCHEDULE |
| A6 | Billing inquiry | Ask about insurance | classify_request returns BILLING_INSURANCE |

---

## Human Handoff

### Transfer Scenarios
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| H1 | Cold transfer success | Trigger STAT condition | Transfer to HUMAN_AGENT_NUMBER completes |
| H2 | Transfer busy | Human line busy | Agent apologizes, creates priority ticket |
| H3 | After-hours transfer | Call outside business hours | Agent explains hours, offers ticket |

---

## System Reliability

### Error Handling
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| S1 | OpenAI timeout | Simulate API delay | Agent uses fallback response |
| S2 | Database unavailable | Pause DB connection | Call continues, alert service triggers |
| S3 | Twilio webhook failure | Break webhook URL | System recovers gracefully |

### Data Integrity
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| S4 | Ticket creation | Complete call with ticket | Ticket appears in dashboard within 30s |
| S5 | Call duration tracking | Make 5-minute call | Duration recorded accurately (within 5s) |
| S6 | Recording saved | Complete call with recording | Recording URL saved to call log |

---

## Performance Benchmarks

| Metric | Target | Acceptable |
|--------|--------|------------|
| Greeting latency | < 2s | < 4s |
| Response latency | < 1s | < 2s |
| Human handoff time | < 10s | < 30s |
| Ticket creation | < 5s | < 15s |
| Recording availability | < 60s | < 120s |

---

## Test Execution Log

| Date | Tester | Agent | Tests Passed | Tests Failed | Notes |
|------|--------|-------|--------------|--------------|-------|
| | | | | | |

---

## Sign-Off Checklist
- [ ] All critical scenarios (N1-N10, A1-A6, H1-H3) pass
- [ ] Performance benchmarks met
- [ ] No PHI/PII exposed in logs
- [ ] Alert service tested (send test alert)
- [ ] Production secrets verified in .env
